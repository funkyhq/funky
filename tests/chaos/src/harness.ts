// tests/chaos/src/harness.ts — buildWorld() and the invariants it lets scenarios assert.
//
// Everything offline: testcontainers Postgres + the real subprocess sandbox + a scripted,
// log-aware LLM. No API keys, no network, deterministic. One Postgres container is shared
// per test FILE (starting one is the slow part); resetDb() truncates the session tables
// between tests so pull()/depth() — which are global — never leak jobs across scenarios.
//
// A "world" is one provisioned, ready session plus the machinery to enqueue a turn, start
// and crash workers against it, and read back the log + the side-effect marker.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { createDb, type Db } from "@funky/db";
import type { ResolvedEnv } from "@funky/db/schema";
import type { FakeTurn, LlmPort } from "@funky/llm";
import { type SandboxDriver, type SandboxHandle, SubprocessDriver } from "@funky/sandbox";
import {
  EventStore,
  type AppendHook,
  type Job,
  JobQueue,
  makeEvent,
  type SessionEvent,
  textContent,
  type TurnDeps,
} from "@funky/sessions";
import { createMetrics, type Metrics, startWorker, type WorkerHandle } from "worker/worker";
import { countMarkerLines, removeMarker, scriptedLlm, sideEffectCmd } from "./fixtures";

// testcontainers' Ryuk reaper pulls its own image over the network; disable it and rely on
// explicit stop(). Must be set before any container starts.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

const NS = "chaos-ns";
// Shared FK parents — an agent (v1) and an env config. Seeded once; survive resetDb().
const AGENT_ID = randomUUID();
const ENV_ID = randomUUID();

const realSandbox: SandboxDriver = new SubprocessDriver();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared Postgres — memoised per test-file process.
// ---------------------------------------------------------------------------
type Pg = { container: StartedPostgreSqlContainer; pool: Pool; db: Db; uri: string };
let pgPromise: Promise<Pg> | null = null;

async function startPg(): Promise<Pg> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const uri = container.getConnectionUri();
  const pool = new Pool({ connectionString: uri, max: 20 });

  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  await pool.query("insert into agent_configs (id, namespace, name) values ($1,$2,$3)", [
    AGENT_ID,
    NS,
    "chaos-agent",
  ]);
  // The PINNED version runTurn reads for system prompt + model + iteration budget.
  await pool.query(
    `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model)
     values ($1, 1, $2, $3, $4::jsonb)`,
    [AGENT_ID, NS, "You are a chaos test agent.", JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" })],
  );
  await pool.query(
    "insert into env_configs (id, namespace, name) values ($1,$2,$3)",
    [ENV_ID, NS, "chaos-env"],
  );

  return { container, pool, db: createDb(pool), uri };
}

async function sharedPg(): Promise<Pg> {
  return (pgPromise ??= startPg());
}

/** beforeEach: wipe the per-session tables so a leftover job can't leak into the next
 *  scenario. The FK parents (agent/env) are left intact. */
export async function resetDb(): Promise<void> {
  const pg = await sharedPg();
  await pg.pool.query("truncate table session_events, turn_jobs, sessions cascade");
}

/** afterAll: stop the container. */
export async function stopPg(): Promise<void> {
  if (!pgPromise) return;
  const pg = await pgPromise;
  await pg.pool.end();
  await pg.container.stop();
  pgPromise = null;
}

// ---------------------------------------------------------------------------
// The reference log — the I1 assertion in one value.
// ---------------------------------------------------------------------------
/** normalize(): strip everything that legitimately varies between runs (created_at, token
 *  usage, message text) and everything session-specific. What remains is the shape the
 *  reducer is obliged to reproduce at every crash point: event types, dense seqs, and — for
 *  tool results — the log-derived idem_key (session prefix stripped) and exit code. */
export function normalize(events: SessionEvent[]): Array<Record<string, unknown>> {
  return events.map((e) => {
    if (e.type === "tool_result") {
      const p = e.payload as { idem_key: string; exit_code: number };
      return {
        type: e.type,
        seq: e.seq,
        // idem_key is `${sessionId}:${assistantSeq}:${index}`; drop the (per-world) sessionId
        // so the reference is session-independent. UUIDs contain no ':'.
        idem_key: p.idem_key.split(":").slice(1).join(":"),
        exit_code: p.exit_code,
      };
    }
    return { type: e.type, seq: e.seq };
  });
}

/** The happy-path log for the single-tool-call script. Validated by reference.test.ts; every
 *  crash scenario for that script must reproduce it exactly. */
export const REFERENCE_LOG: Array<Record<string, unknown>> = [
  { type: "user_message", seq: 1 },
  { type: "assistant_message", seq: 2 },
  { type: "tool_result", seq: 3, idem_key: "2:0", exit_code: 0 },
  { type: "assistant_message", seq: 4 },
  { type: "turn_completed", seq: 5 },
];

/** The default script: one exec of the side-effect command, then a closing message. */
export function singleToolScript(runId: string, opts: { sleepSec?: number } = {}): FakeTurn[] {
  return [
    { content: "", toolCall: { kind: "exec", cmd: sideEffectCmd(runId, opts) } },
    { content: "ran the command; wrapping up" },
  ];
}

// ---------------------------------------------------------------------------
// buildWorld
// ---------------------------------------------------------------------------
export type StartWorkerOpts = {
  llm?: LlmPort; // defaults to the world's log-aware scripted LLM
  store?: EventStore; // defaults to the world's clean (un-hooked) store
  sandbox?: SandboxDriver; // defaults to the real subprocess driver
  concurrency?: number;
  heartbeatMs?: number;
};

export type RunningWorker = { worker: WorkerHandle; metrics: Metrics };

export type World = {
  ns: string;
  sessionId: string;
  runId: string;
  db: Db;
  pool: Pool;
  uri: string;
  store: EventStore; // clean store (no append hook)
  queue: JobQueue;
  sandbox: SandboxDriver; // real subprocess
  handle: SandboxHandle | null; // null when built with provisioned:false (H6)
  llm: LlmPort; // default log-aware scripted LLM for this session
  script: FakeTurn[];

  /** A store carrying a crash-injection hook (the one allowed production seam). */
  hookedStore(hook: AppendHook): EventStore;
  /** Deps for calling runTurn/runProvision directly (the double-delivery scenario). */
  turnDeps(over?: Partial<TurnDeps>): TurnDeps;

  /** Seed the user_message at seq 1 (via a clean store — not counted by any hook). */
  seedUserMessage(text?: string): Promise<void>;
  /** Insert a turn job. maxAttempts defaults high so a crash never trips last-attempt. */
  enqueueTurnJob(opts?: { id?: string; maxAttempts?: number }): Promise<string>;
  enqueueProvisionJob(opts?: { id?: string; maxAttempts?: number }): Promise<string>;

  startWorker(opts?: StartWorkerOpts): Promise<RunningWorker>;

  /** Backdate a job's lease so it is reclaimable NOW (instead of sleeping out LEASE_MS).
   *  Callers must first `await kill()` on any worker that might still have a pull() on the
   *  wire — a straggler claim landing after this expiry would re-lease the job for 60s. */
  expireLease(jobId: string): Promise<void>;
  jobState(jobId: string): Promise<string | null>;
  jobExists(jobId: string): Promise<boolean>;
  sessionStatus(): Promise<string | null>;

  readEvents(): Promise<SessionEvent[]>;
  eventTypes(): Promise<string[]>;
  markerLines(): Promise<number>;

  cleanup(): Promise<void>;
};

export async function buildWorld(
  opts: { script?: FakeTurn[]; runId?: string; provisioned?: boolean } = {},
): Promise<World> {
  const pg = await sharedPg();
  const { pool, db, uri } = pg;
  const runId = opts.runId ?? randomUUID();
  const sessionId = randomUUID();
  const script = opts.script ?? singleToolScript(runId);
  const provisioned = opts.provisioned ?? true;

  const store = new EventStore(db);
  const queue = new JobQueue(db);
  const llm = scriptedLlm({ [sessionId]: script });

  const resolvedEnv: ResolvedEnv = {
    egress: { allow: [] },
  };
  // Most scenarios seed the session ALREADY provisioned — provisioning is not what they
  // test. H6 sets provisioned:false so the worker runs runProvision (and can crash in it).
  const handle: SandboxHandle | null = provisioned
    ? await realSandbox.provision(resolvedEnv, sessionId)
    : null;
  if (provisioned) {
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id,
                             status, resolved_env, sandbox_handle)
       values ($1,$2,$3,$4,$5,'ready',$6::jsonb,$7::jsonb)`,
      [sessionId, NS, AGENT_ID, 1, ENV_ID, JSON.stringify(resolvedEnv), JSON.stringify(handle)],
    );
  } else {
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status)
       values ($1,$2,$3,$4,$5,'provisioning')`,
      [sessionId, NS, AGENT_ID, 1, ENV_ID],
    );
  }

  const cleanups: Array<() => Promise<void> | void> = [];

  const world: World = {
    ns: NS,
    sessionId,
    runId,
    db,
    pool,
    uri,
    store,
    queue,
    sandbox: realSandbox,
    handle,
    llm,
    script,

    hookedStore: (hook) => new EventStore(db, hook),
    turnDeps: (over = {}) => ({ store, llm, sandbox: realSandbox, db, ...over }),

    async seedUserMessage(text = "hello") {
      await store.appendEvent(
        NS,
        sessionId,
        1,
        makeEvent({ sessionId, namespace: NS, seq: 1 }, "user_message", { content: textContent(text) }),
      );
    },

    async enqueueTurnJob(o = {}) {
      const id = o.id ?? randomUUID();
      await pool.query(
        "insert into turn_jobs (id, namespace, session_id, kind, max_attempts) values ($1,$2,$3,'turn',$4)",
        [id, NS, sessionId, o.maxAttempts ?? 20],
      );
      return id;
    },

    async enqueueProvisionJob(o = {}) {
      const id = o.id ?? randomUUID();
      await pool.query(
        "insert into turn_jobs (id, namespace, session_id, kind, max_attempts) values ($1,$2,$3,'provision',$4)",
        [id, NS, sessionId, o.maxAttempts ?? 20],
      );
      return id;
    },

    async startWorker(o = {}) {
      const listenClient = new Client({ connectionString: uri });
      await listenClient.connect();
      const metrics = createMetrics();
      const worker = startWorker({
        queue,
        store: o.store ?? store,
        db,
        llm: o.llm ?? llm,
        sandbox: o.sandbox ?? realSandbox,
        listenClient,
        concurrency: o.concurrency ?? 25,
        metrics,
        ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      });
      cleanups.push(async () => {
        await worker.kill(); // await the loop's exit so no straggler pull outlives the test
        await listenClient.end().catch(() => {});
      });
      return { worker, metrics };
    },

    async expireLease(jobId) {
      await pool.query(
        "update turn_jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
        [jobId],
      );
    },

    async jobState(jobId) {
      const { rows } = await pool.query<{ state: string }>(
        "select state from turn_jobs where id = $1",
        [jobId],
      );
      return rows[0]?.state ?? null;
    },

    async jobExists(jobId) {
      const { rows } = await pool.query("select 1 from turn_jobs where id = $1", [jobId]);
      return rows.length > 0;
    },

    async sessionStatus() {
      const { rows } = await pool.query<{ status: string }>(
        "select status from sessions where id = $1",
        [sessionId],
      );
      return rows[0]?.status ?? null;
    },

    async readEvents() {
      return store.readEvents(NS, sessionId);
    },

    async eventTypes() {
      return (await store.readEvents(NS, sessionId)).map((e) => e.type);
    },

    async markerLines() {
      return countMarkerLines(runId);
    },

    async cleanup() {
      for (const c of cleanups.splice(0)) await c();
      await sleep(25); // let any in-flight pull settle before the next truncate
      if (handle) await realSandbox.teardown(handle).catch(() => {});
      // The workdir is sessionId-derived; a provision crash may have created it without a
      // handle on the row. Remove it either way so no dir is orphaned across scenarios.
      await fs.rm(`/tmp/funky/${sessionId}`, { recursive: true, force: true }).catch(() => {});
      await removeMarker(runId);
    },
  };

  return world;
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------
export function makeJob(over: Partial<Job> & Pick<Job, "id" | "sessionId">): Job {
  return {
    namespace: NS,
    kind: "turn",
    attempts: 1,
    maxAttempts: 20,
    ...over,
  };
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

export { NS };
