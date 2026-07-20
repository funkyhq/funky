// packages/sessions/src/harness-turn.test.ts — the harness turn loop against a fake
// HarnessPort + the subprocess sandbox + a testcontainers Postgres. Everything here
// is offline: no Agent SDK subprocess, no API keys — the fake stands where the
// Claude Code driver would, exercising the SAME appender/exec contract the driver
// uses. The two ★ tests are the phase: fence + commit on the happy path, and
// crash-resume with EXACTLY-ONCE exec recovery.

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import type {
  HarnessPort,
  HarnessTurnRequest,
  HarnessTurnResult,
} from "@funky/harness/port";
import type { LlmPort } from "@funky/llm";
import { type SandboxHandle, SubprocessDriver } from "@funky/sandbox";
import {
  type EventPayload,
  type Job,
  type SessionEvent,
  EventStore,
  makeEvent,
  runTurn,
  textContent,
} from "./index";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let store: EventStore;
let sandbox: SubprocessDriver;

const NS = "test-ns";
const agentConfigId = randomUUID();
const envConfigId = randomUUID();

let sessionId: string;
const handles: SandboxHandle[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  db = createDb(pool);
  store = new EventStore(db);
  sandbox = new SubprocessDriver();
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(
    "truncate table harness_transcript_entries, session_events, turn_jobs, sessions cascade",
  );
  await pool.query("delete from agent_config_versions");
  await pool.query("delete from agent_configs");
  await pool.query("delete from env_configs");
  await pool.query(
    "insert into agent_configs (id, namespace, name, latest_version) values ($1,$2,$3,1)",
    [agentConfigId, NS, "test-agent"],
  );
  await pool.query("insert into env_configs (id, namespace, name) values ($1,$2,$3)", [
    envConfigId,
    NS,
    "test-env",
  ]);
  sessionId = randomUUID();
});

afterEach(async () => {
  while (handles.length) await sandbox.teardown(handles.pop()!);
});

// ------------------------------------------------------------------------- helpers

async function seedAgentVersion(opts: { maxIterations?: number } = {}) {
  const toolPolicy =
    opts.maxIterations !== undefined ? { max_iterations: opts.maxIterations } : {};
  await pool.query(
    `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model, tool_policy, runtime)
     values ($1, 1, $2, $3, $4, $5, $6)`,
    [
      agentConfigId,
      NS,
      "you are a harness agent",
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }),
      JSON.stringify(toolPolicy),
      JSON.stringify({ type: "claude-code" }),
    ],
  );
}

async function seedSession() {
  const handle = await sandbox.provision({ network: { type: "unrestricted" } }, sessionId);
  handles.push(handle);
  await pool.query(
    `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status, sandbox_handle)
     values ($1,$2,$3,1,$4,'ready',$5)`,
    [sessionId, NS, agentConfigId, envConfigId, JSON.stringify(handle)],
  );
  return handle;
}

async function seedUserMessage(text = "do the thing") {
  const evt = makeEvent({ sessionId, namespace: NS, seq: 1 }, "user_message", {
    content: textContent(text),
  });
  await store.appendEvent(NS, sessionId, 1, evt);
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    namespace: NS,
    sessionId,
    kind: "turn",
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

// runTurn dispatches to runHarnessTurn via the version's runtime; the llm port is
// never called on the harness path — a throwing stub proves it.
const untouchableLlm: LlmPort = {
  complete: async () => {
    throw new Error("llm port must not be called for harness sessions");
  },
};

function deps(harness?: HarnessPort) {
  return { store, llm: untouchableLlm, sandbox, db, ...(harness ? { harness } : {}) };
}

async function log() {
  return store.readEvents(NS, sessionId);
}

async function sessionRow() {
  const r = await pool.query("select harness_attempt, harness_state from sessions where id=$1", [
    sessionId,
  ]);
  return r.rows[0] as { harness_attempt: string | null; harness_state: unknown };
}

/** A scripted harness: each runTurn call pops the next behavior. */
function fakeHarness(
  behaviors: Array<(req: HarnessTurnRequest) => Promise<HarnessTurnResult>>,
): HarnessPort & { requests: HarnessTurnRequest[] } {
  const requests: HarnessTurnRequest[] = [];
  return {
    requests,
    async runTurn(req) {
      requests.push(req);
      const next = behaviors.shift();
      if (!next) throw new Error("fake harness: no scripted behavior left");
      return next(req);
    },
  };
}

/** What the real driver's exec bridge does: journal → exec by seq-derived idemKey →
 *  record. Kept here so the fake exercises the exact contract. */
async function bridgeExec(req: HarnessTurnRequest, cmd: string) {
  const { seq } = await req.append({
    kind: "assistant_message",
    content: [],
    toolCalls: [{ kind: "exec", cmd }],
  });
  const idemKey = `${req.sessionId}:${seq}:0`;
  const res = await req.exec({ kind: "exec", cmd }, idemKey);
  await req.append({ kind: "tool_result", idemKey, ...res });
  return res;
}

const success = (sdkSessionId: string): HarnessTurnResult => ({
  sdkSessionId,
  usage: { inputTokens: 1, outputTokens: 1 },
  stop: { type: "success" },
});

// ================================================================= ★ HAPPY PATH

describe("runHarnessTurn — the happy path", () => {
  it("★ fences the attempt, journals exec through the log, commits state", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const harness = fakeHarness([
      async (req) => {
        const res = await bridgeExec(req, "echo hi");
        expect(res.exitCode).toBe(0);
        expect(res.output).toContain("hi");
        await req.append({
          kind: "assistant_message",
          content: textContent("done"),
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 7 },
        });
        return success("cc-session-1");
      },
    ]);

    const outcome = await runTurn(job(), deps(harness));
    expect(outcome).toBe("completed");

    const events = await log();
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "harness_attempt_started",
      "assistant_message", // the journaled exec decision
      "tool_result",
      "assistant_message", // the text answer
      "turn_completed",
    ]);
    // idemKey is the log position of the journaled decision.
    const result = events[3] as SessionEvent<"tool_result">;
    expect(result.payload.idem_key).toBe(`${sessionId}:3:0`);

    // The projection's usage lands on the logged event — parity with the native loop.
    const answer = events[4] as SessionEvent<"assistant_message">;
    expect(answer.payload.usage).toEqual({ input_tokens: 5, output_tokens: 7 });

    // Fresh turn: the prompt is the user's message, no resume tip.
    expect(harness.requests[0]!.prompt).toBe("do the thing");
    expect(harness.requests[0]!.resume).toBeNull();
    expect(harness.requests[0]!.systemPrompt).toBe("you are a harness agent");

    // Committed: fence token installed, vendor session id recorded.
    const row = await sessionRow();
    expect(row.harness_attempt).toBe(
      (events[1] as SessionEvent<"harness_attempt_started">).payload.attempt,
    );
    expect(row.harness_state).toEqual({
      driver: "claude-code",
      sdk_session_id: "cc-session-1",
    });
  });

  it("a stale redelivery of a finished turn is a silent ack", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();
    const harness = fakeHarness([async () => success("cc-1")]);
    await runTurn(job(), deps(harness));

    const before = (await log()).length;
    const outcome = await runTurn(job(), deps(fakeHarness([])));
    expect(outcome).toBe("completed");
    expect((await log()).length).toBe(before); // nothing appended
  });
});

// ================================================================= ★ CRASH-RESUME

describe("runHarnessTurn — crash-resume, exactly-once", () => {
  it("★ crash AFTER journaling but BEFORE exec: recovery replays the logged decision once", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage("append a line");

    // Attempt 1: journals the decision, then dies before the sandbox sees it.
    const crashing = fakeHarness([
      async (req) => {
        await req.append({
          kind: "assistant_message",
          content: [],
          toolCalls: [{ kind: "exec", cmd: "echo once >> marker.txt" }],
        });
        throw new Error("worker died");
      },
    ]);
    expect(await runTurn(job(), deps(crashing))).toBe("retry_later");

    // Attempt 2: recovery must execute the journaled command (exactly once) BEFORE
    // the harness runs, and hand the result to the continuation prompt.
    const resumed = fakeHarness([
      async (req) => {
        const check = await bridgeExec(req, "cat marker.txt | wc -l");
        expect(check.output.trim()).toBe("1"); // ← ran exactly once
        return success("cc-2");
      },
    ]);
    expect(await runTurn(job({ attempts: 2 }), deps(resumed))).toBe("completed");

    const req = resumed.requests[0]!;
    expect(req.prompt).toContain("interrupted");
    expect(req.prompt).toContain("append a line"); // original user request
    expect(req.prompt).toContain("echo once >> marker.txt"); // recovered command
    expect(req.prompt).toContain("do NOT re-run");

    // The recovered result is in the log under the ORIGINAL decision's idemKey.
    const events = await log();
    const results = events.filter((e) => e.type === "tool_result");
    const recovered = results[0] as SessionEvent<"tool_result">;
    expect(recovered.payload.idem_key).toBe(`${sessionId}:3:0`);
    expect(events.at(-1)!.type).toBe("turn_completed");
  });

  it("★ crash AFTER exec ran but BEFORE the result was recorded: recovery ATTACHES, never re-runs", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    // Attempt 1: journals AND executes (the command's side effect lands), then dies
    // before recording the result — the worst window for a side-effecting command.
    const crashing = fakeHarness([
      async (req) => {
        const { seq } = await req.append({
          kind: "assistant_message",
          content: [],
          toolCalls: [{ kind: "exec", cmd: "echo once >> marker.txt; cat marker.txt | wc -l" }],
        });
        await req.exec(
          { kind: "exec", cmd: "echo once >> marker.txt; cat marker.txt | wc -l" },
          `${req.sessionId}:${seq}:0`,
        );
        throw new Error("worker died before recording the result");
      },
    ]);
    expect(await runTurn(job(), deps(crashing))).toBe("retry_later");

    const resumed = fakeHarness([async () => success("cc-2")]);
    expect(await runTurn(job({ attempts: 2 }), deps(resumed))).toBe("completed");

    // The idemKey replay attached to the FIRST execution's recorded output: the
    // marker was appended exactly once, and the recovered result proves it.
    const results = (await log()).filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect((results[0]!.payload as EventPayload<"tool_result">).output.trim()).toBe("1");
    expect(resumed.requests[0]!.prompt).toContain("[exit code: 0]");
  });

  it("the retry resumes from the transcript tip left by the crashed attempt", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    // Simulate the crashed attempt's mirrored transcript rows (what the fenced store
    // would have written before the crash).
    await pool.query(
      `insert into harness_transcript_entries (project_key, sdk_session_id, subpath, entry_uuid, entry, namespace, funky_session_id)
       values ('pk', 'cc-crashed-tip', '', $1, '{"type":"user"}', $2, $3)`,
      [randomUUID(), NS, sessionId],
    );

    const resumed = fakeHarness([async () => success("cc-next")]);
    expect(await runTurn(job({ attempts: 2 }), deps(resumed))).toBe("completed");
    expect(resumed.requests[0]!.resume).toBe("cc-crashed-tip");

    const attempt = (await log()).find(
      (e) => e.type === "harness_attempt_started",
    ) as SessionEvent<"harness_attempt_started">;
    expect(attempt.payload.resumed_from).toBe("cc-crashed-tip");
  });
});

// ================================================================= conflicts & fences

describe("runHarnessTurn — conflicts", () => {
  it("losing an append race mid-turn → conflict, no terminal event from the loser", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const harness = fakeHarness([
      async (req) => {
        // Another worker steals the next seq out from under this attempt.
        const events = await store.readEvents(NS, sessionId);
        const seq = (events.at(-1)?.seq ?? 0) + 1;
        await store.appendEvent(
          NS,
          sessionId,
          seq,
          makeEvent({ sessionId, namespace: NS, seq }, "harness_attempt_started", {
            attempt: randomUUID(),
            resumed_from: null,
          }),
        );
        // This attempt's next append must lose and the rejection must propagate.
        await req.append({ kind: "assistant_message", content: textContent("x"), toolCalls: [] });
        throw new Error("unreachable — append should have rejected");
      },
    ]);

    expect(await runTurn(job(), deps(harness))).toBe("conflict");
    const events = await log();
    expect(events.at(-1)!.type).toBe("harness_attempt_started"); // no terminal junk
  });

  it("a second attempt flips the fence token on the session row", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    expect(await runTurn(job(), deps(fakeHarness([async () => { throw new Error("die"); }])))).toBe(
      "retry_later",
    );
    const first = (await sessionRow()).harness_attempt;
    expect(first).toBeTruthy();

    expect(await runTurn(job({ attempts: 2 }), deps(fakeHarness([async () => success("cc")])))).toBe(
      "completed",
    );
    const second = (await sessionRow()).harness_attempt;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first); // the zombie's token is dead — its store writes bounce
  });
});

// ================================================================= error policy

describe("runHarnessTurn — error policy", () => {
  it("budget stop → turn_failed(BUDGET), transcript tip still committed", async () => {
    await seedAgentVersion({ maxIterations: 3 });
    await seedSession();
    await seedUserMessage();

    const harness = fakeHarness([
      async (req) => {
        expect(req.limits.maxTurns).toBe(3);
        return {
          sdkSessionId: "cc-budget",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: { type: "budget", message: "harness max_turns exhausted" },
        };
      },
    ]);

    expect(await runTurn(job(), deps(harness))).toBe("failed");
    const lastEvent = (await log()).at(-1) as SessionEvent<"turn_failed">;
    expect(lastEvent.type).toBe("turn_failed");
    expect(lastEvent.payload.error_class).toBe("BUDGET");
    expect((await sessionRow()).harness_state).toEqual({
      driver: "claude-code",
      sdk_session_id: "cc-budget",
    });
  });

  it("no harness driver on this worker → terminal turn_failed(HARNESS)", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    expect(await runTurn(job(), deps(/* no harness */))).toBe("failed");
    const lastEvent = (await log()).at(-1) as SessionEvent<"turn_failed">;
    expect(lastEvent.payload.error_class).toBe("HARNESS");
  });

  it("a transient harness failure retries, then terminates as INTERNAL on the last attempt", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const die = () => fakeHarness([async () => { throw new Error("subprocess lost"); }]);
    expect(await runTurn(job({ attempts: 1 }), deps(die()))).toBe("retry_later");
    expect(await runTurn(job({ attempts: 5 }), deps(die()))).toBe("failed");
    const lastEvent = (await log()).at(-1) as SessionEvent<"turn_failed">;
    expect(lastEvent.payload.error_class).toBe("INTERNAL");
    expect(lastEvent.payload.message).toContain("subprocess lost");
  });
});
