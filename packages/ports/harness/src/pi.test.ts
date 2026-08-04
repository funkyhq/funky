// packages/ports/harness/src/pi.test.ts — the pi driver against a scripted session.
//
// Two surfaces are under test:
//   1. makeSandboxOps — offline: how pi's tool primitives compile to sandbox shell
//      commands (path translation, base64 content transport, timeout units).
//   2. PiHarness.runTurn — against a real Postgres, with `createSessionFn` standing
//      where the SDK would build the in-process AgentSession. Everything else is
//      REAL: SessionManager (the file the driver materializes and mirrors),
//      ModelRuntime (catalog + key injection), resource isolation plumbing.
// The real-model path is exercised end-to-end only with an API key (not here).

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import {
  makeSandboxOps,
  type PiCreateSessionFn,
  PiHarness,
  type PiSession,
} from "./drivers/pi";
import { loadPiTranscript, PiTranscriptStore } from "./drivers/pi-store";
import {
  type ExecResult,
  HarnessFencedError,
  HarnessPermanentError,
  HarnessTransientError,
  type HarnessProjectedEvent,
  type HarnessTurnRequest,
} from "./port";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

// ------------------------------------------------------------------ sandbox ops

function fakeRunExec(result: Partial<ExecResult> = {}) {
  const calls: Array<{ cmd: string; timeoutMs: number | undefined }> = [];
  const runExec = async (cmd: string, timeoutMs?: number): Promise<ExecResult> => {
    calls.push({ cmd, timeoutMs });
    return { output: "", exitCode: 0, truncated: false, ...result };
  };
  return { runExec, calls };
}

describe("makeSandboxOps — pi tool primitives over the exec bridge", () => {
  it("bash passes the command verbatim, converts pi's SECONDS timeout to ms, streams output", async () => {
    const { runExec, calls } = fakeRunExec({ output: "hi\n", exitCode: 3 });
    const chunks: Buffer[] = [];
    const r = await makeSandboxOps(runExec).bash.exec("echo hi", "/workspace", {
      onData: (d) => chunks.push(d),
      timeout: 5,
    });
    expect(calls).toEqual([{ cmd: "echo hi", timeoutMs: 5000 }]);
    expect(Buffer.concat(chunks).toString()).toBe("hi\n");
    expect(r.exitCode).toBe(3); // non-zero exit is a RESULT pi renders, never thrown
  });

  it("readFile: paths under the /workspace fiction become sandbox-relative; content rides base64", async () => {
    const { runExec, calls } = fakeRunExec({
      output: `${Buffer.from("hello world").toString("base64")}\n`,
    });
    const buf = await makeSandboxOps(runExec).read.readFile("/workspace/src/a.txt");
    expect(calls[0]!.cmd).toBe("base64 < 'src/a.txt'");
    expect(buf.toString()).toBe("hello world");
  });

  it("readFile: paths OUTSIDE the fiction pass through absolute; quotes are escaped", async () => {
    const { runExec, calls } = fakeRunExec({ output: "" });
    await makeSandboxOps(runExec).read.readFile("/etc/it's.conf");
    expect(calls[0]!.cmd).toBe(`base64 < '/etc/it'\\''s.conf'`);
  });

  it("readFile: a non-zero exit throws the sandbox's message; truncation refuses to return corrupt bytes", async () => {
    const failing = fakeRunExec({ output: "No such file\n", exitCode: 1 });
    await expect(
      makeSandboxOps(failing.runExec).read.readFile("/workspace/x"),
    ).rejects.toThrow("No such file");

    const truncated = fakeRunExec({ output: "QUJD", truncated: true });
    await expect(
      makeSandboxOps(truncated.runExec).read.readFile("/workspace/x"),
    ).rejects.toThrow(/too large/);
  });

  it("writeFile: content crosses as a base64 heredoc, decoded inside the sandbox", async () => {
    const { runExec, calls } = fakeRunExec();
    await makeSandboxOps(runExec).write.writeFile("/workspace/out.txt", "line1\nline2\n");
    const b64 = Buffer.from("line1\nline2\n").toString("base64");
    expect(calls[0]!.cmd).toBe(`base64 -d > 'out.txt' <<'FUNKY_B64'\n${b64}\nFUNKY_B64`);
  });

  it("mkdir and access compile to mkdir -p / test probes", async () => {
    const { runExec, calls } = fakeRunExec();
    const ops = makeSandboxOps(runExec);
    await ops.write.mkdir("/workspace/a/b");
    await ops.read.access("/workspace/f");
    await ops.edit.access("/workspace/f");
    expect(calls.map((c) => c.cmd)).toEqual([
      "mkdir -p 'a/b'",
      "test -r 'f'",
      "test -e 'f'",
    ]);
  });

  it("the /workspace root itself resolves to '.'", async () => {
    const { runExec, calls } = fakeRunExec();
    await makeSandboxOps(runExec).write.mkdir("/workspace");
    expect(calls[0]!.cmd).toBe("mkdir -p '.'");
  });
});

// ------------------------------------------------------------------ runTurn vs scripted session

const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

const NS = "test-ns";
const agentConfigId = randomUUID();
const envConfigId = randomUUID();
let sessionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  db = createDb(pool);
  await pool.query(
    "insert into agent_configs (id, namespace, name, latest_version) values ($1,$2,$3,1)",
    [agentConfigId, NS, "test-agent"],
  );
  await pool.query("insert into env_configs (id, namespace, name) values ($1,$2,$3)", [
    envConfigId,
    NS,
    "test-env",
  ]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("truncate table harness_transcript_entries");
  sessionId = randomUUID();
  await pool.query(
    `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status, harness_attempt)
     values ($1,$2,$3,1,$4,'ready','a1')`,
    [sessionId, NS, agentConfigId, envConfigId],
  );
});

type ScriptCtx = {
  sm: SessionManager;
  emit: (ev: AgentSessionEvent) => void;
  prompt: string;
};

/** A scripted stand-in for createAgentSession: real SessionManager in, fake loop. */
function scriptedSession(
  script: (ctx: ScriptCtx) => Promise<void>,
  state: { errorMessage?: string } = {},
) {
  const seen: {
    options?: Parameters<PiCreateSessionFn>[0];
    aborts: number;
    prompts: string[];
  } = { aborts: 0, prompts: [] };
  const createSessionFn: PiCreateSessionFn = async (options) => {
    seen.options = options;
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const session: PiSession = {
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async prompt(text) {
        seen.prompts.push(text);
        await script({
          sm: options.sessionManager as SessionManager,
          emit: (ev) => {
            for (const l of listeners) l(ev);
          },
          prompt: text,
        });
      },
      abort: async () => {
        seen.aborts += 1;
      },
      dispose() {},
      state,
    };
    return { session };
  };
  return { createSessionFn, seen };
}

const assistantMessage = (text: string, usage?: { input: number; output: number }) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    usage: usage ?? { input: 0, output: 0 },
    stopReason: "stop",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    timestamp: 0,
  }) as never;

/** Append a message to the real SessionManager and emit the events pi would. */
function appendAndEmit(ctx: ScriptCtx, message: never, endEvent = true): void {
  ctx.sm.appendMessage(message);
  const entry = ctx.sm.getEntries().at(-1);
  ctx.emit({ type: "entry_appended", entry } as unknown as AgentSessionEvent);
  if (endEvent) {
    ctx.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
  }
}

function makeRequest(overrides: Partial<HarnessTurnRequest> = {}): {
  req: HarnessTurnRequest;
  appended: HarnessProjectedEvent[];
} {
  const appended: HarnessProjectedEvent[] = [];
  let seq = 1;
  const req: HarnessTurnRequest = {
    namespace: NS,
    sessionId,
    attempt: "a1",
    systemPrompt: "be helpful",
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    prompt: "do the thing",
    resume: null,
    limits: { maxTurns: 20 },
    exec: async () => ({ output: "", exitCode: 0, truncated: false }),
    append: async (e) => {
      appended.push(e);
      return { seq: ++seq };
    },
    ...overrides,
  };
  return { req, appended };
}

function harness(createSessionFn: PiCreateSessionFn) {
  return new PiHarness({
    db,
    apiKeys: { anthropic: "sk-test" },
    createSessionFn,
  });
}

describe("PiHarness.runTurn — projection, mirroring, result mapping", () => {
  it("fresh turn: mirrors header+entries, projects assistant text with usage, plumbs isolation options", async () => {
    const { createSessionFn, seen } = scriptedSession(async (ctx) => {
      appendAndEmit(
        ctx,
        { role: "user", content: [{ type: "text", text: ctx.prompt }] } as never,
        false,
      );
      appendAndEmit(ctx, assistantMessage("done!", { input: 12, output: 34 }));
    });
    const { req, appended } = makeRequest();

    const result = await harness(createSessionFn).runTurn(req);
    expect(result.stop).toEqual({ type: "success" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });

    // The projection: assistant text (with per-inference usage), nothing else.
    expect(appended).toEqual([
      {
        kind: "assistant_message",
        content: [{ type: "text", text: "done!" }],
        toolCalls: [],
        usage: { inputTokens: 12, outputTokens: 34 },
      },
    ]);

    // The mirror: header + user + assistant, loadable by the returned session id.
    const rows = await loadPiTranscript(db, NS, sessionId, result.sdkSessionId);
    expect(rows.map((r) => r.type)).toEqual(["session", "message", "message"]);

    // Isolation plumbing: sentinel cwd, exactly pi's four default tools — ours.
    const options = seen.options!;
    expect(options.cwd).toBe("/workspace");
    expect(options.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(options.customTools?.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    expect(options.model?.id).toBe("claude-sonnet-4-5");
    expect(options.resourceLoader?.getSystemPrompt()).toBe("be helpful");
    expect(seen.prompts).toEqual(["do the thing"]);
  });

  it("the initial entries are durable BEFORE the model is prompted", async () => {
    let rowsAtPrompt = -1;
    const { createSessionFn } = scriptedSession(async () => {
      const r = await pool.query(
        "select count(*)::int as n from harness_transcript_entries where funky_session_id=$1",
        [sessionId],
      );
      rowsAtPrompt = r.rows[0].n;
    });
    const { req } = makeRequest();
    await harness(createSessionFn).runTurn(req);
    expect(rowsAtPrompt).toBeGreaterThan(0); // at least the header landed pre-prompt
  });

  it("resume: materializes the stored transcript, keeps the session id, mirrors only what is new", async () => {
    // A prior attempt's transcript, stored under fence a0.
    await pool.query("update sessions set harness_attempt='a0' where id=$1", [sessionId]);
    const store = new PiTranscriptStore({
      db,
      namespace: NS,
      funkySessionId: sessionId,
      attempt: "a0",
    });
    await store.flush("11111111-2222-7333-8444-555555555555", [
      {
        type: "session",
        version: 3,
        id: "11111111-2222-7333-8444-555555555555",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace",
      },
      {
        type: "message",
        id: "e1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "earlier" }] },
      },
    ]);
    await pool.query("update sessions set harness_attempt='a1' where id=$1", [sessionId]);

    let entriesAtPrompt = -1;
    const { createSessionFn } = scriptedSession(async (ctx) => {
      entriesAtPrompt = ctx.sm.getEntries().length; // the materialized history
      appendAndEmit(ctx, assistantMessage("resumed"));
    });
    const { req } = makeRequest({ resume: "11111111-2222-7333-8444-555555555555" });

    const result = await harness(createSessionFn).runTurn(req);
    expect(result.sdkSessionId).toBe("11111111-2222-7333-8444-555555555555");
    expect(entriesAtPrompt).toBe(1); // e1 was rehydrated into the session file

    const rows = await loadPiTranscript(db, NS, sessionId, result.sdkSessionId);
    expect(rows).toHaveLength(3); // header + e1 + the new assistant entry; no duplicates
  });

  it("maxTurns: a turn that would START past the budget aborts as a budget stop", async () => {
    const { createSessionFn, seen } = scriptedSession(async (ctx) => {
      appendAndEmit(ctx, assistantMessage("turn 1"));
      ctx.emit({ type: "turn_start" } as unknown as AgentSessionEvent); // wants turn 2
    });
    const { req } = makeRequest({ limits: { maxTurns: 1 } });

    const result = await harness(createSessionFn).runTurn(req);
    expect(result.stop).toEqual({ type: "budget", message: "harness max_turns exhausted" });
    expect(seen.aborts).toBeGreaterThan(0);
  });

  it("finishing EXACTLY on budget is a success, not a budget stop", async () => {
    const { createSessionFn } = scriptedSession(async (ctx) => {
      appendAndEmit(ctx, assistantMessage("only turn"));
    });
    const { req } = makeRequest({ limits: { maxTurns: 1 } });
    expect((await harness(createSessionFn).runTurn(req)).stop).toEqual({ type: "success" });
  });

  it("a run ending with an error message is transient; auth errors are permanent", async () => {
    const transient = scriptedSession(async () => {}, { errorMessage: "stream disconnected" });
    await expect(
      harness(transient.createSessionFn).runTurn(makeRequest().req),
    ).rejects.toThrowError(HarnessTransientError);

    const auth = scriptedSession(async () => {}, {
      errorMessage: "401 invalid x-api-key",
    });
    await expect(
      harness(auth.createSessionFn).runTurn(makeRequest().req),
    ).rejects.toThrowError(HarnessPermanentError);
  });

  it("★ losing the write fence mid-run fails the turn as fenced — the zombie's rows never land", async () => {
    const { createSessionFn } = scriptedSession(async (ctx) => {
      // Another worker takes the turn while this one is mid-run.
      await pool.query("update sessions set harness_attempt='a2' where id=$1", [sessionId]);
      appendAndEmit(ctx, assistantMessage("zombie output"), false);
    });
    const { req } = makeRequest();

    await expect(harness(createSessionFn).runTurn(req)).rejects.toThrowError(HarnessFencedError);
    // Nothing after the fence flip was mirrored.
    const r = await pool.query(
      "select count(*)::int as n from harness_transcript_entries where funky_session_id=$1 and entry->>'type'='message'",
      [sessionId],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("an unsupported provider, a missing key, and an unknown model are permanent config errors", async () => {
    const { createSessionFn } = scriptedSession(async () => {});

    const { req: googleReq } = makeRequest({
      model: { provider: "google", model: "gemini-something" },
    });
    await expect(harness(createSessionFn).runTurn(googleReq)).rejects.toThrowError(
      HarnessPermanentError,
    );

    const noKey = new PiHarness({ db, apiKeys: {}, createSessionFn });
    await expect(noKey.runTurn(makeRequest().req)).rejects.toThrowError(HarnessPermanentError);

    const { req: badModel } = makeRequest({
      model: { provider: "anthropic", model: "definitely-not-a-model" },
    });
    await expect(harness(createSessionFn).runTurn(badModel)).rejects.toThrowError(
      HarnessPermanentError,
    );
  });
});
