// apps/worker/test/worker.test.ts — Phase E integration tests.
//
// The worker's whole job is lifecycle over a REAL Postgres queue: FOR UPDATE SKIP LOCKED
// claims, LISTEN/NOTIFY wake-ups, lease heartbeats, crash-resume via the conditional append.
// None of that is observable on a single-connection engine, so these run against
// testcontainers Postgres with the real subprocess sandbox and scripted LLMs.
//
// One container serves the file; each test truncates the log + queue and stops any worker
// it started (pull()/depth() are global — a leaked worker would steal the next test's jobs).

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@funky/db";
import type { JobKind } from "@funky/db/schema";
import type { LlmPort } from "@funky/llm";
import { FakeLlm } from "@funky/llm";
import { type SandboxDriver, SubprocessDriver } from "@funky/sandbox";
import { EventStore, JobQueue, makeEvent, textContent } from "@funky/sessions";
import { createMetrics, startWorker, type WorkerHandle } from "../src/worker";

// testcontainers' Ryuk reaper pulls its own image; disable it and rely on afterAll.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

let container: StartedPostgreSqlContainer;
let connectionUri: string;
let pool: Pool;
let db: Db;
let store: EventStore;
let queue: JobQueue;

const realSandbox: SandboxDriver = new SubprocessDriver();

const NS = "test-ns";
const agentConfigId = randomUUID();
const envConfigId = randomUUID();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  connectionUri = container.getConnectionUri();
  pool = new Pool({ connectionString: connectionUri, max: 20 });

  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  await pool.query("insert into agent_configs (id, namespace, name) values ($1,$2,$3)", [
    agentConfigId,
    NS,
    "test-agent",
  ]);
  // runTurn reads the PINNED agent version for the system prompt + model + budget.
  await pool.query(
    `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model)
     values ($1, 1, $2, $3, $4::jsonb)`,
    [agentConfigId, NS, "You are a test agent.", JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" })],
  );
  await pool.query(
    "insert into env_configs (id, namespace, name, base_image) values ($1,$2,$3,$4)",
    [envConfigId, NS, "test-env", "funky/base:latest"],
  );

  db = createDb(pool);
  store = new EventStore(db);
  queue = new JobQueue(db);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Workers started in a test register a cleanup here; afterEach kills them before truncating.
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  await pool.query("truncate table session_events, turn_jobs, sessions cascade");
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await sleep(25); // let any in-flight pull settle before the next truncate
});

// ------------------------------------------------------------------- helpers

async function startTestWorker(opts: {
  llm: LlmPort;
  sandbox?: SandboxDriver;
  concurrency?: number;
  heartbeatMs?: number;
  queue?: JobQueue; // fault-injection seam (the gated-pull kill test)
}): Promise<{ worker: WorkerHandle; metrics: ReturnType<typeof createMetrics> }> {
  const listenClient = new Client({ connectionString: connectionUri });
  await listenClient.connect();
  const metrics = createMetrics();
  const worker = startWorker({
    queue: opts.queue ?? queue,
    store,
    db,
    llm: opts.llm,
    sandbox: opts.sandbox ?? realSandbox,
    listenClient,
    concurrency: opts.concurrency ?? 50,
    metrics,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  cleanups.push(async () => {
    await worker.kill(); // await the loop's exit so no straggler pull outlives the test
    await listenClient.end();
  });
  return { worker, metrics };
}

async function seedSession(opts: { id?: string; status?: string; handle?: unknown } = {}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await pool.query(
    `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status, sandbox_handle)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, NS, agentConfigId, 1, envConfigId, opts.status ?? "ready", opts.handle ? JSON.stringify(opts.handle) : null],
  );
  return id;
}

async function appendUser(sessionId: string): Promise<void> {
  await store.appendEvent(
    NS,
    sessionId,
    1,
    makeEvent({ sessionId, namespace: NS, seq: 1 }, "user_message", { content: textContent("hi") }),
  );
}

async function insertTurnJob(sessionId: string, kind: JobKind = "turn"): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into turn_jobs (id, namespace, session_id, kind) values ($1,$2,$3,$4)", [
    id,
    NS,
    sessionId,
    kind,
  ]);
  return id;
}

async function jobExists(id: string): Promise<boolean> {
  const { rows } = await pool.query("select 1 from turn_jobs where id=$1", [id]);
  return rows.length > 0;
}

async function eventTypes(sessionId: string): Promise<string[]> {
  return (await store.readEvents(NS, sessionId)).map((e) => e.type);
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

async function depthZero(): Promise<boolean> {
  const d = await queue.depth();
  return d.queued + d.running === 0;
}

/** A no-tool-call LLM: one complete() → the turn ends. Optional per-call latency. */
function doneLlm(delayMs = 0): LlmPort {
  return {
    async complete() {
      if (delayMs) await sleep(delayMs);
      return { content: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

/** An LLM whose complete() blocks until release() is called (keeps a turn in-flight). */
function deferredLlm(): { llm: LlmPort; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    llm: {
      async complete() {
        await gate;
        return { content: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    release,
  };
}

// ==================================================================== tests

it("runs one enqueued turn to completion and acks the job", async () => {
  const sid = await seedSession();
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  await startTestWorker({ llm: doneLlm() });

  // Wait for the ACK (row gone), not the terminal event: the event is appended inside the
  // turn BEFORE the worker acks, so asserting on the row right after the event races the
  // delete. The job being gone is the unambiguous "fully processed" signal.
  await waitFor(async () => !(await jobExists(jobId)), 15_000, "completed and acked");
  expect(await eventTypes(sid)).toEqual(["user_message", "assistant_message", "turn_completed"]);
});

it("interleaves many turns on one event loop (handle is not awaited)", async () => {
  // 20 different sessions, a fake LLM that sleeps 200ms. Serial would be ~4s; concurrent
  // is ~200-400ms. This is the test that catches `await handle(job)` in the loop.
  const N = 20;
  const jobIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const sid = await seedSession();
    await appendUser(sid);
    jobIds.push(await insertTurnJob(sid));
  }

  const t0 = Date.now();
  await startTestWorker({ llm: doneLlm(200), concurrency: 50 });
  await waitFor(depthZero, 15_000, "all turns done");
  const elapsed = Date.now() - t0;

  expect(elapsed).toBeLessThan(2000); // NOT ~4000ms serial
  for (const id of jobIds) expect(await jobExists(id)).toBe(false);
});

it("respects the concurrency limit (backpressure)", async () => {
  for (let i = 0; i < 10; i++) {
    const sid = await seedSession();
    await appendUser(sid);
    await insertTurnJob(sid);
  }

  const { metrics } = await startTestWorker({ llm: doneLlm(100), concurrency: 2 });
  let maxInFlight = 0;
  const sampler = setInterval(() => {
    maxInFlight = Math.max(maxInFlight, metrics.inFlight);
  }, 5);
  await waitFor(depthZero, 15_000, "all turns done");
  clearInterval(sampler);

  expect(maxInFlight).toBeGreaterThan(0);
  expect(maxInFlight).toBeLessThanOrEqual(2); // turns_inflight never exceeds the limit
});

it("NACKs a retry_later outcome (job stays queued with a future run_at)", async () => {
  // A provisioning session yields retry_later — backoff waits, the job is NOT dropped.
  const sid = await seedSession({ status: "provisioning" });
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  await startTestWorker({ llm: doneLlm() });

  await waitFor(
    async () => {
      const { rows } = await pool.query(
        "select state, lease_expires_at, attempts from turn_jobs where id=$1",
        [jobId],
      );
      const r = rows[0];
      return Boolean(r) && r.state === "queued" && r.lease_expires_at === null && r.attempts >= 1;
    },
    15_000,
    "nacked",
  );

  const { rows } = await pool.query(
    "select state, extract(epoch from (run_at - now())) as delay from turn_jobs where id=$1",
    [jobId],
  );
  expect(rows[0].state).toBe("queued");
  expect(await jobExists(jobId)).toBe(true); // still in the table — never acked
  expect(Number(rows[0].delay)).toBeGreaterThan(0.5); // backed off into the future
});

it("ACKs a conflict silently, counts it, and logs no error", async () => {
  const sid = await seedSession();
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errSpy.mockRestore());

  // The LLM races another worker: it plants the assistant_message at seq 2 before returning,
  // so the worker's own append loses the (session_id, seq) race → ErrConflict → "conflict".
  const conflictLlm: LlmPort = {
    async complete(req) {
      await pool.query(
        "insert into session_events (session_id, seq, namespace, type, payload) values ($1, 2, $2, 'assistant_message', $3::jsonb)",
        [req.trace?.sessionId, NS, JSON.stringify({ content: [], tool_calls: [] })],
      );
      return { content: "mine", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  const { metrics } = await startTestWorker({ llm: conflictLlm });

  await waitFor(async () => !(await jobExists(jobId)), 15_000, "acked");
  expect(metrics.jobs.conflict).toBe(1);
  expect(metrics.appendConflicts).toBe(1);
  expect(errSpy).not.toHaveBeenCalled(); // a conflict is a normal event, not an error
});

it("runs a provision job: provisioning → ready + session_provisioned", async () => {
  const sid = await seedSession({ status: "provisioning" });
  const jobId = await insertTurnJob(sid, "provision");

  await startTestWorker({ llm: doneLlm() });

  await waitFor(
    async () => {
      const { rows } = await pool.query("select status from sessions where id=$1", [sid]);
      return rows[0]?.status === "ready";
    },
    15_000,
    "provisioned",
  );

  const { rows } = await pool.query(
    "select status, resolved_env, sandbox_handle from sessions where id=$1",
    [sid],
  );
  expect(rows[0].status).toBe("ready");
  expect(rows[0].resolved_env).toBeTruthy();
  expect(rows[0].sandbox_handle).toBeTruthy();
  expect(await eventTypes(sid)).toContain("session_provisioned");
  expect(await jobExists(jobId)).toBe(false);
});

it("keeps a long-running turn's lease fresh via the heartbeat (not stolen)", async () => {
  const sid = await seedSession();
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  const { llm, release } = deferredLlm();
  await startTestWorker({ llm, heartbeatMs: 40 }); // shrink the heartbeat so it fires in-test

  // Wait until the worker has claimed the job and parked in the (blocked) inference.
  await waitFor(
    async () => {
      const { rows } = await pool.query("select state from turn_jobs where id=$1", [jobId]);
      return rows[0]?.state === "running";
    },
    15_000,
    "claimed",
  );

  // Simulate a near-expired lease; the heartbeat must push it back out before it can be stolen.
  await pool.query("update turn_jobs set lease_expires_at = now() + interval '1 second' where id=$1", [jobId]);
  await sleep(300); // ~7 heartbeats at 40ms

  expect(await queue.pull()).toBeNull(); // not reclaimable — the heartbeat kept it leased
  const { rows } = await pool.query(
    "select extract(epoch from (lease_expires_at - now())) as ahead from turn_jobs where id=$1",
    [jobId],
  );
  expect(Number(rows[0].ahead)).toBeGreaterThan(30);

  release();
  await waitFor(async () => (await eventTypes(sid)).at(-1) === "turn_completed", 15_000, "completed");
});

it("★ crash-resumes: worker B finishes the turn worker A abandoned, running the tool once", async () => {
  // A provisioned subprocess sandbox both workers share (same session → same workdir).
  const sid = randomUUID();
  const handle = await realSandbox.provision(
    { base_image: "x", persistent_fs: { size_gb: 1 }, egress: { allow: [] } },
    sid,
  );
  await seedSession({ id: sid, status: "ready", handle });
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  // One shared scripted LLM: the single tool turn is consumed by A; B's follow-up inference
  // finds the script exhausted and ends the turn.
  const llm = new FakeLlm({
    scripts: { [sid]: [{ content: "", toolCall: { kind: "exec", cmd: "echo RAN" } }] },
  });

  // Worker A's sandbox blocks forever on exec: A appends the assistant_message (tool call)
  // then stalls BEFORE running the command — a faithful crash right after the log entry.
  const blockingSandbox: SandboxDriver = {
    async provision() {
      return { driver: "subprocess", workdir: "/tmp/funky/unused" };
    },
    async reboot(h) {
      return h;
    },
    async teardown() {},
    connect() {
      return {
        exec: () =>
          (async function* () {
            await new Promise<never>(() => {});
          })(),
        attach: () =>
          (async function* () {
            await new Promise<never>(() => {});
          })(),
        async readFile() {
          return new Uint8Array();
        },
        async writeFile() {},
      };
    },
  };

  const { worker: workerA } = await startTestWorker({ llm, sandbox: blockingSandbox });

  // A appends the assistant_message with the tool call, then hangs in exec.
  await waitFor(
    async () => (await eventTypes(sid)).includes("assistant_message"),
    15_000,
    "A appended the tool call",
  );
  await workerA.kill(); // crash A: heartbeats stop, its in-flight turn is abandoned (awaited
  // so a pull already on the wire lands BEFORE the expiry below — it can't re-lease the job)
  await pool.query("update turn_jobs set lease_expires_at = now() - interval '1 second' where id=$1", [jobId]);

  // Worker B — real sandbox — reclaims the expired lease and finishes the turn.
  await startTestWorker({ llm, sandbox: realSandbox });

  // Job-gone = the terminal event landed AND B acked (the event alone races the ack).
  await waitFor(async () => !(await jobExists(jobId)), 15_000, "B completed and acked");

  const events = await store.readEvents(NS, sid);
  const toolResults = events.filter((e) => e.type === "tool_result");
  expect(toolResults).toHaveLength(1); // the command ran ONCE (one tool_result)
  expect((toolResults[0]!.payload as { output: string }).output).toContain("RAN");
  expect(events.at(-1)?.type).toBe("turn_completed");
});

it("drains: stop() resolves only after the in-flight turn finishes", async () => {
  const sid = await seedSession();
  await appendUser(sid);
  await insertTurnJob(sid);

  const { llm, release } = deferredLlm();
  const { worker, metrics } = await startTestWorker({ llm });

  await waitFor(() => metrics.inFlight === 1, 15_000, "turn in-flight");

  let stopped = false;
  const stopP = worker.stop().then(() => {
    stopped = true;
  });
  await sleep(80);
  expect(stopped).toBe(false); // still draining: the in-flight turn hasn't finished

  release();
  await stopP;
  expect(stopped).toBe(true);
  expect((await eventTypes(sid)).at(-1)).toBe("turn_completed");
});

/** A queue whose FIRST pull() parks before touching the database — the claim is "on the
 *  wire" while the caller does something else (kills the worker). Later pulls pass through. */
class GatedPullQueue extends JobQueue {
  private parked = false;
  constructor(
    dbase: Db,
    private readonly onParked: () => void,
    private readonly gate: Promise<void>,
  ) {
    super(dbase);
  }
  override async pull() {
    if (!this.parked) {
      this.parked = true;
      this.onParked();
      await this.gate;
    }
    return super.pull();
  }
}

it("kill() resolves only after an in-flight pull lands, so post-kill lease edits stick", async () => {
  // The chaos-suite race, made deterministic: kill() cannot cancel a pull already on the
  // wire. If that straggler executes AFTER a test's lease-expiry, it re-claims the job with
  // a fresh 60s lease that the dead loop abandons — starving the replacement worker. The
  // contract under test: kill()'s promise settles only once the loop (and thus any in-flight
  // claim) is done, so `await kill()` before a lease edit makes the edit the last word.
  const sid = await seedSession();
  await appendUser(sid);
  const jobId = await insertTurnJob(sid);

  let parkedResolve!: () => void;
  const parked = new Promise<void>((r) => (parkedResolve = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { worker } = await startTestWorker({
    llm: doneLlm(),
    queue: new GatedPullQueue(db, parkedResolve, gate),
  });
  await parked; // the loop's first pull is now in flight, pre-claim

  let killSettled = false;
  const killP = worker.kill().then(() => (killSettled = true));
  await sleep(80);
  expect(killSettled).toBe(false); // the parked pull hasn't landed — kill must still be pending

  // Release the pull: it claims the job (fresh 60s lease), and the dying loop abandons it
  // between pull and dispatch. Only then does kill() settle — with the claim visible.
  release();
  await killP;
  const { rows } = await pool.query<{ state: string; attempts: number }>(
    "select state, attempts from turn_jobs where id=$1",
    [jobId],
  );
  expect(rows[0]).toMatchObject({ state: "running", attempts: 1 }); // the straggler claim landed first

  // Because kill() was awaited, this expiry cannot be raced; a fresh worker reclaims at once.
  await pool.query("update turn_jobs set lease_expires_at = now() - interval '1 second' where id=$1", [jobId]);
  await startTestWorker({ llm: doneLlm() });
  // Job-gone, not the terminal event: the event lands before the ack, so asserting on the
  // row right after seeing the event would race B's delete.
  await waitFor(async () => !(await jobExists(jobId)), 15_000, "B completed and acked");
  expect((await eventTypes(sid)).at(-1)).toBe("turn_completed");
});

it("wakes on NOTIFY, starting the turn well before the fallback poll", async () => {
  const sid = await seedSession();
  await appendUser(sid);

  await startTestWorker({ llm: doneLlm() });
  await sleep(150); // let the worker settle into its idle wait (LISTEN registered, empty pull)

  const t0 = Date.now();
  const jobId = randomUUID();
  await db.transaction((tx) => queue.enqueue(tx, { id: jobId, namespace: NS, sessionId: sid, kind: "turn" }));

  await waitFor(async () => !(await jobExists(jobId)), 5000, "turn processed");
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(700); // NOTIFY woke it; the fallback poll is 1000ms
});
