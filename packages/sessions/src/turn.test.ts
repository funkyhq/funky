// packages/sessions/src/turn.test.ts — the turn/provision loop against fakes + real Postgres.
//
// Everything here is offline: FakeLlm (and a few one-off LlmPort stubs) + the subprocess
// sandbox + a testcontainers Postgres. No API keys, no network. The two ★ tests — happy
// path and CRASH-RESUME — are the phase: if they pass, Funky's core promise is real.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import {
  FakeLlm,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  LlmPermanentError,
} from "@funky/llm";
import {
  type SandboxDriver,
  type SandboxHandle,
  SubprocessDriver,
  SandboxUnavailableError,
} from "@funky/sandbox";
import {
  type EventPayload,
  type Job,
  type SessionEvent,
  type ToolCall,
  buildContext,
  EventStore,
  makeEvent,
  runProvision,
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
const handles: SandboxHandle[] = []; // provisioned during a test → torn down after

// --------------------------------------------------------------------------- setup

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
  await pool.query("truncate table session_events, turn_jobs, sessions cascade");
  await pool.query("delete from agent_config_versions");
  await pool.query("delete from agent_configs");
  await pool.query("delete from env_configs");
  await pool.query("insert into agent_configs (id, namespace, name, latest_version) values ($1,$2,$3,1)", [
    agentConfigId,
    NS,
    "test-agent",
  ]);
  await pool.query(
    "insert into env_configs (id, namespace, name, base_image) values ($1,$2,$3,$4)",
    [envConfigId, NS, "test-env", "funky/base:latest"],
  );
  sessionId = randomUUID();
});

afterEach(async () => {
  while (handles.length) await sandbox.teardown(handles.pop()!);
});

// ------------------------------------------------------------------------- helpers

/** Insert the pinned agent version. tool_policy carries max_iterations. */
async function seedAgentVersion(opts: { systemPrompt?: string; maxIterations?: number } = {}) {
  const toolPolicy =
    opts.maxIterations !== undefined ? { max_iterations: opts.maxIterations } : {};
  await pool.query(
    `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model, tool_policy)
     values ($1, 1, $2, $3, $4, $5)`,
    [
      agentConfigId,
      NS,
      opts.systemPrompt ?? "you are a helpful agent",
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }),
      JSON.stringify(toolPolicy),
    ],
  );
}

/** Insert the session row. Provisions a real subprocess sandbox unless told otherwise. */
async function seedSession(opts: {
  status?: string;
  provision?: boolean;
  handle?: SandboxHandle;
} = {}) {
  const status = opts.status ?? "ready";
  let handle: SandboxHandle | null = opts.handle ?? null;
  if (!handle && opts.provision !== false) {
    handle = await sandbox.provision(
      { base_image: "x", persistent_fs: { size_gb: 1 }, egress: { allow: [] } },
      sessionId,
    );
    handles.push(handle);
  }
  await pool.query(
    `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status, sandbox_handle)
     values ($1,$2,$3,1,$4,$5,$6)`,
    [sessionId, NS, agentConfigId, envConfigId, status, handle ? JSON.stringify(handle) : null],
  );
}

/** Seed a session's opening user_message at seq 1. */
async function seedUserMessage(text = "hello") {
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

function deps(llm: LlmPort, sb: SandboxDriver = sandbox) {
  return { store, llm, sandbox: sb, db };
}

async function log() {
  return store.readEvents(NS, sessionId);
}

/** An LlmPort that returns the same scripted turns to every call (order = the script). */
function scriptLlm(turns: Array<{ content: string; toolCall?: LlmResult["toolCall"] }>): FakeLlm {
  return new FakeLlm({ scripts: { [sessionId]: turns } });
}

const exec = (cmd: string): ToolCall => ({ kind: "exec", cmd });

// ================================================================= ★ HAPPY PATH

describe("runTurn — the happy path", () => {
  it("★ drives infer → exec → infer → complete and records the full log", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const llm = scriptLlm([{ content: "", toolCall: exec("echo hi") }, { content: "done" }]);
    const outcome = await runTurn(job(), deps(llm));
    expect(outcome).toBe("completed");

    const events = await log();
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
      "turn_completed",
    ]);

    const asstTool = events[1] as SessionEvent<"assistant_message">;
    expect(asstTool.payload.tool_calls).toEqual([exec("echo hi")]);

    const result = events[2] as SessionEvent<"tool_result">;
    expect(result.payload.exit_code).toBe(0);
    expect(result.payload.output).toContain("hi");
    expect(result.payload.idem_key).toBe(`${sessionId}:2:0`);
  });

  it("a non-zero exit is a RESULT: the loop continues and the turn still completes", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const llm = scriptLlm([{ content: "", toolCall: exec("exit 3") }, { content: "acknowledged" }]);
    const outcome = await runTurn(job(), deps(llm));
    expect(outcome).toBe("completed");

    const events = await log();
    const result = events.find((e) => e.type === "tool_result") as SessionEvent<"tool_result">;
    expect(result.payload.exit_code).toBe(3); // failure surfaced as a result, not thrown
    // The model got to respond after the failure, and the turn reached a terminal event.
    expect(events.at(-1)!.type).toBe("turn_completed");
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(2);
  });
});

// ================================================================= budget

describe("runTurn — iteration budget", () => {
  it("maxIterations=2 with an LLM that always calls a tool → turn_failed(BUDGET)", async () => {
    await seedAgentVersion({ maxIterations: 2 });
    await seedSession();
    await seedUserMessage();

    const alwaysTool: LlmPort = {
      async complete(): Promise<LlmResult> {
        return { content: "", toolCall: exec("echo loop"), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const outcome = await runTurn(job(), deps(alwaysTool));
    expect(outcome).toBe("failed");

    const events = await log();
    const last = events.at(-1) as SessionEvent<"turn_failed">;
    expect(last.type).toBe("turn_failed");
    expect(last.payload.error_class).toBe("BUDGET");
    // exactly 2 assistant messages before the budget stopped it
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(2);
  });
});

// ================================================================= error policy

describe("runTurn — error policy", () => {
  it("LlmPermanentError → turn_failed(LLM_PERMANENT), outcome 'failed'", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    const permanent: LlmPort = {
      async complete(): Promise<LlmResult> {
        throw new LlmPermanentError("400 bad request");
      },
    };
    const outcome = await runTurn(job(), deps(permanent));
    expect(outcome).toBe("failed");

    const last = (await log()).at(-1) as SessionEvent<"turn_failed">;
    expect(last.type).toBe("turn_failed");
    expect(last.payload.error_class).toBe("LLM_PERMANENT");
  });

  it("LlmTransientError escaping the driver → 'retry_later', NO events appended", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    // failOnce at global call-index 0: the very first complete() throws transient.
    const llm = new FakeLlm({ scripts: { [sessionId]: [{ content: "done" }] }, failOnce: [0] });
    const outcome = await runTurn(job(), deps(llm));
    expect(outcome).toBe("retry_later");

    // Only the pre-seeded user_message exists — a transient failure records nothing.
    expect((await log()).map((e) => e.type)).toEqual(["user_message"]);
  });

  it("last-attempt escalation: sandbox unobservable on the final attempt → turn_failed(SANDBOX_FATAL)", async () => {
    await seedAgentVersion();
    // A handle pointing at a workdir that does not exist → exec throws SandboxUnavailable.
    // reboot is a subprocess no-op, so the retry throws again and the error escalates.
    await seedSession({
      provision: false,
      handle: { driver: "subprocess", workdir: "/tmp/funky/does-not-exist-" + randomUUID() },
    });
    await seedUserMessage();

    const llm = scriptLlm([{ content: "", toolCall: exec("echo hi") }]);
    const outcome = await runTurn(job({ attempts: 5, maxAttempts: 5 }), deps(llm));
    expect(outcome).toBe("failed"); // never a silent hang: the session gets a terminal event

    const events = await log();
    const last = events.at(-1) as SessionEvent<"turn_failed">;
    expect(last.type).toBe("turn_failed");
    expect(last.payload.error_class).toBe("SANDBOX_FATAL");
    // The assistant tool call was recorded before the sandbox failure.
    expect(events.some((e) => e.type === "assistant_message")).toBe(true);
  });

  it("non-final sandbox failure → 'retry_later' (no terminal event, the queue backs off)", async () => {
    await seedAgentVersion();
    await seedSession({
      provision: false,
      handle: { driver: "subprocess", workdir: "/tmp/funky/does-not-exist-" + randomUUID() },
    });
    await seedUserMessage();

    const llm = scriptLlm([{ content: "", toolCall: exec("echo hi") }]);
    const outcome = await runTurn(job({ attempts: 1, maxAttempts: 5 }), deps(llm));
    expect(outcome).toBe("retry_later");

    const events = await log();
    // assistant recorded, but NO terminal event — a later attempt replays and retries.
    expect(events.some((e) => e.type === "turn_failed")).toBe(false);
    expect(events.some((e) => e.type === "assistant_message")).toBe(true);
  });
});

// ================================================================= conflict

describe("runTurn — ErrConflict", () => {
  it("a competing worker taking the seq → 'conflict', no further appends by us", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    // This LLM simulates another worker: during complete() it writes the seq (2) that
    // runTurn is about to write, so runTurn's own append loses the (session_id, seq) race.
    const racyLlm: LlmPort = {
      async complete(): Promise<LlmResult> {
        const seq = (await store.lastSeq(NS, sessionId)) + 1;
        const evt = makeEvent({ sessionId, namespace: NS, seq }, "assistant_message", {
          content: textContent("other worker"),
          tool_calls: [],
        });
        await store.appendEvent(NS, sessionId, seq, evt);
        return { content: "mine", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const outcome = await runTurn(job(), deps(racyLlm));
    expect(outcome).toBe("conflict");

    // Exactly the user_message + the competing worker's assistant. Nothing from us.
    const events = await log();
    expect(events.map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
    expect((events[1] as SessionEvent<"assistant_message">).payload.content).toEqual(
      textContent("other worker"),
    );
  });
});

// ================================================================= session gate

describe("runTurn — session status gate", () => {
  it("status 'provisioning' → 'retry_later' without ever touching the LLM", async () => {
    await seedAgentVersion();
    await seedSession({ status: "provisioning", provision: false });
    await seedUserMessage();

    let called = false;
    const spy: LlmPort = {
      async complete(): Promise<LlmResult> {
        called = true;
        return { content: "x", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    expect(await runTurn(job(), deps(spy))).toBe("retry_later");
    expect(called).toBe(false);
    expect((await log()).map((e) => e.type)).toEqual(["user_message"]);
  });

  it("status 'archived' → 'abandoned'", async () => {
    await seedAgentVersion();
    await seedSession({ status: "archived", provision: false });
    await seedUserMessage();
    expect(await runTurn(job(), deps(scriptLlm([])))).toBe("abandoned");
  });
});

// ================================================================= ★ CRASH-RESUME

describe("★ CRASH-RESUME", () => {
  it("crashing right after the assistant tool call runs the command exactly once", async () => {
    await seedAgentVersion();
    await seedSession();
    await seedUserMessage();

    // A store that persists the assistant_message (durable), then throws to simulate the
    // worker dying before it could run the tool. The row survives; the process does not.
    class CrashAfterAssistantStore extends EventStore {
      crashed = false;
      override async appendEvent(
        ns: string,
        sid: string,
        seq: number,
        event: Omit<SessionEvent, "createdAt">,
        tx?: Parameters<EventStore["appendEvent"]>[4],
      ): Promise<void> {
        await super.appendEvent(ns, sid, seq, event, tx);
        const isToolCall =
          event.type === "assistant_message" &&
          (event.payload as EventPayload<"assistant_message">).tool_calls.length > 0;
        if (isToolCall && !this.crashed) {
          this.crashed = true;
          throw new Error("simulated crash after assistant_message");
        }
      }
    }

    // The command appends one line to a marker file inside the sandbox. If it ever ran
    // twice, the file would have two lines.
    const cmd = "echo ran >> marker.txt";

    // A STATELESS LLM: it decides purely from the rebuilt context — call the tool until a
    // tool_result is present, then answer. This is what a real provider does, and it is the
    // whole point of resume: a fresh worker rebuilds the same context and gets the same
    // decision, with no cursor/state carried across the crash.
    const resumeLlm: LlmPort = {
      async complete(req: LlmRequest): Promise<LlmResult> {
        const answered = req.messages.some((m) => m.role === "tool");
        if (answered) return { content: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return { content: "", toolCall: exec(cmd), usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    // Attempt 1: crash-injecting store — the assistant_message row commits, then the
    // "process" dies before the tool ever runs.
    const crashStore = new CrashAfterAssistantStore(db);
    const outcome1 = await runTurn(job(), {
      store: crashStore,
      llm: resumeLlm,
      sandbox,
      db,
    });
    expect(outcome1).toBe("retry_later"); // the crash was caught; nothing terminal yet

    // The assistant tool call is durably recorded; no tool_result yet.
    const mid = await log();
    expect(mid.map((e) => e.type)).toEqual(["user_message", "assistant_message"]);

    // Attempt 2: a completely fresh worker (real store) resumes from the log alone.
    const outcome2 = await runTurn(job(), deps(resumeLlm));
    expect(outcome2).toBe("completed");

    const events = await log();
    // Exactly ONE tool_result, and the turn completed.
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("turn_completed");

    // The side effect happened exactly once.
    const handle = handles[0]!;
    const marker = await sandbox.connect(handle).readFile("marker.txt");
    const lines = Buffer.from(marker).toString("utf8").trim().split("\n");
    expect(lines).toEqual(["ran"]);
  });
});

// ================================================================= buildContext

describe("buildContext", () => {
  const sys = "SYSTEM-PROMPT";
  const evt = <T extends SessionEvent["type"]>(
    seq: number,
    type: T,
    payload: EventPayload<T>,
  ): SessionEvent<T> =>
    ({ sessionId, namespace: NS, seq, type, payload, createdAt: new Date(0) }) as SessionEvent<T>;

  it("skips turn_completed / turn_failed / session_provisioned (bookkeeping, not conversation)", () => {
    const events: SessionEvent[] = [
      evt(1, "session_provisioned", {}),
      evt(2, "user_message", { content: textContent("hi") }),
      evt(3, "assistant_message", { content: textContent("on it"), tool_calls: [exec("ls")] }),
      evt(4, "tool_result", { idem_key: `${sessionId}:3:0`, output: "files", exit_code: 0, truncated: false }),
      evt(5, "assistant_message", { content: textContent("done"), tool_calls: [] }),
      evt(6, "turn_completed", {}),
    ];
    const messages = buildContext(events, sys);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(messages[0]).toEqual({ role: "system", content: sys });
    // the tool-calling assistant carries its toolCall; the tool message pairs by idemKey
    expect(messages[2]).toMatchObject({ role: "assistant", toolCall: exec("ls") });
    expect(messages[3]).toEqual({ role: "tool", idemKey: `${sessionId}:3:0`, output: "files", exitCode: 0 });
  });

  it("the system prompt comes from the PINNED agent version, not the agent's latest", async () => {
    // Seed v1 with a distinctive prompt, then bump the agent to v2 with a different prompt.
    // The session pins v1; buildContext (via runTurn) must use v1's prompt.
    await seedAgentVersion({ systemPrompt: "PINNED-V1-PROMPT" });
    await pool.query(
      `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model, tool_policy)
       values ($1, 2, $2, $3, $4, '{}')`,
      [agentConfigId, NS, "LATEST-V2-PROMPT", JSON.stringify({ provider: "anthropic", model: "m" })],
    );
    await pool.query("update agent_configs set latest_version = 2 where id = $1", [agentConfigId]);
    await seedSession(); // agent_version pinned to 1 by seedSession
    await seedUserMessage();

    let seenSystem: string | undefined;
    const capture: LlmPort = {
      async complete(req: LlmRequest): Promise<LlmResult> {
        seenSystem = req.messages.find((m) => m.role === "system")?.content;
        return { content: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    await runTurn(job(), deps(capture));
    expect(seenSystem).toBe("PINNED-V1-PROMPT");
  });
});

// ================================================================= provision

describe("runProvision", () => {
  it("provisions the sandbox, snapshots resolved_env, flips to ready, appends session_provisioned", async () => {
    await seedAgentVersion();
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status)
       values ($1,$2,$3,1,$4,'provisioning')`,
      [sessionId, NS, agentConfigId, envConfigId],
    );

    const outcome = await runProvision(job({ kind: "provision" }), deps(scriptLlm([])));
    expect(outcome).toBe("completed");

    const { rows } = await pool.query<{
      status: string;
      resolved_env: unknown;
      sandbox_handle: { driver?: string } | null;
    }>("select status, resolved_env, sandbox_handle from sessions where id = $1", [sessionId]);
    expect(rows[0]!.status).toBe("ready");
    expect(rows[0]!.resolved_env).toMatchObject({ base_image: "funky/base:latest" });
    expect(rows[0]!.sandbox_handle?.driver).toBe("subprocess");
    if (rows[0]!.sandbox_handle) handles.push(rows[0]!.sandbox_handle as SandboxHandle);

    const events = await log();
    expect(events.map((e) => e.type)).toEqual(["session_provisioned"]);
  });

  it("a session that is already ready → 'completed' with no new event (stale job)", async () => {
    await seedAgentVersion();
    await seedSession({ status: "ready" });
    expect(await runProvision(job({ kind: "provision" }), deps(scriptLlm([])))).toBe("completed");
    expect(await log()).toEqual([]); // nothing appended
  });

  it("last-attempt provision failure → session 'failed' + turn_failed(SANDBOX_FATAL)", async () => {
    await seedAgentVersion();
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status)
       values ($1,$2,$3,1,$4,'provisioning')`,
      [sessionId, NS, agentConfigId, envConfigId],
    );

    const brokenSandbox: SandboxDriver = {
      async provision(): Promise<SandboxHandle> {
        throw new SandboxUnavailableError("cannot reach the sandbox host");
      },
      async reboot(h) {
        return h;
      },
      async teardown() {},
      connect() {
        throw new Error("unreachable");
      },
    };

    const outcome = await runProvision(
      job({ kind: "provision", attempts: 5, maxAttempts: 5 }),
      deps(scriptLlm([]), brokenSandbox),
    );
    expect(outcome).toBe("failed");

    const { rows } = await pool.query<{ status: string }>(
      "select status from sessions where id = $1",
      [sessionId],
    );
    expect(rows[0]!.status).toBe("failed");
    const last = (await log()).at(-1) as SessionEvent<"turn_failed">;
    expect(last.payload.error_class).toBe("SANDBOX_FATAL");
  });

  it("non-final provision failure → 'retry_later', session stays 'provisioning'", async () => {
    await seedAgentVersion();
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status)
       values ($1,$2,$3,1,$4,'provisioning')`,
      [sessionId, NS, agentConfigId, envConfigId],
    );
    const brokenSandbox: SandboxDriver = {
      async provision(): Promise<SandboxHandle> {
        throw new SandboxUnavailableError("transient host hiccup");
      },
      async reboot(h) {
        return h;
      },
      async teardown() {},
      connect() {
        throw new Error("unreachable");
      },
    };
    const outcome = await runProvision(
      job({ kind: "provision", attempts: 1, maxAttempts: 5 }),
      deps(scriptLlm([]), brokenSandbox),
    );
    expect(outcome).toBe("retry_later");
    const { rows } = await pool.query<{ status: string }>(
      "select status from sessions where id = $1",
      [sessionId],
    );
    expect(rows[0]!.status).toBe("provisioning"); // untouched; a later attempt retries
    expect(await log()).toEqual([]);
  });
});
