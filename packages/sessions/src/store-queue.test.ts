// packages/sessions/src/store-queue.test.ts
// Integration tests for the event log (store.ts) and the job queue (queue.ts)
// against a REAL Postgres (testcontainers) — not PGlite. The whole design turns on
// behaviour a single-connection engine can't exhibit: FOR UPDATE SKIP LOCKED across
// concurrent pullers, unique-violation races on (session_id, seq), and LISTEN/NOTIFY
// across connections. So the tests must run on the same engine production does.
//
// One container serves the file. Each test truncates the log + queue and mints a
// fresh session — pull()/depth() are global, so leftover jobs would leak otherwise.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import { turnJobs, type JobKind } from "@funky/db/schema";
import { makeEvent, textContent } from "./events";
import { JobQueue, onWake } from "./queue";
import { ErrConflict, EventStore } from "./store";

// testcontainers' Ryuk reaper pulls its own image over the network to garbage-
// collect leaked containers; disable it and rely on afterAll → container.stop().
// Must be set before any container starts — top-level runs before beforeAll.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let store: EventStore;
let queue: JobQueue;
let connectionUri: string;

// FK parents shared by every session (the FKs are on id only, so namespace is
// irrelevant here).
const agentConfigId = randomUUID();
const envConfigId = randomUUID();

const NS = "test-ns";
let sessionId: string; // a fresh session per test

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  connectionUri = container.getConnectionUri();
  pool = new Pool({ connectionString: connectionUri });

  // Apply the real migrations in order (breakpoint lines are `--` comments, so the
  // whole file runs as one multi-statement query).
  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  await pool.query("insert into agent_configs (id, namespace, name) values ($1, $2, $3)", [
    agentConfigId,
    NS,
    "test-agent",
  ]);
  await pool.query(
    "insert into env_configs (id, namespace, name) values ($1, $2, $3)",
    [envConfigId, NS, "test-env"],
  );

  db = createDb(pool);
  store = new EventStore(db);
  queue = new JobQueue(db);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("truncate table session_events, turn_jobs, sessions cascade");
  sessionId = randomUUID();
  await pool.query(
    "insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id) values ($1, $2, $3, $4, $5)",
    [sessionId, NS, agentConfigId, 1, envConfigId],
  );
});

// --------------------------------------------------------------------- helpers

/** A committed turn event at a caller-computed seq. */
function completed(seq: number) {
  return makeEvent({ sessionId, namespace: NS, seq }, "turn_completed", {});
}

/** Insert a job directly (bypassing enqueue) so a test can pin kind/maxAttempts. */
async function insertJob(
  o: Partial<{ id: string; kind: JobKind; maxAttempts: number; runAt: Date }> = {},
): Promise<string> {
  const id = o.id ?? randomUUID();
  await db.insert(turnJobs).values({
    id,
    namespace: NS,
    sessionId,
    kind: o.kind ?? "turn",
    ...(o.maxAttempts != null ? { maxAttempts: o.maxAttempts } : {}),
    ...(o.runAt ? { runAt: o.runAt } : {}),
  });
  return id;
}

/** Enqueue through the real path (its own committed transaction → pg_notify). */
function enqueue(kind: JobKind = "turn"): Promise<string> {
  const id = randomUUID();
  return db
    .transaction((tx) => queue.enqueue(tx, { id, namespace: NS, sessionId, kind }))
    .then(() => id);
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ==================================================================== EventStore

describe("EventStore", () => {
  it("appends seq 1,2,3 and reads them back in order, parsed", async () => {
    for (const seq of [1, 2, 3]) {
      const evt = makeEvent({ sessionId, namespace: NS, seq }, "user_message", {
        content: textContent(`m${seq}`),
      });
      await store.appendEvent(NS, sessionId, seq, evt);
    }

    const events = await store.readEvents(NS, sessionId);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual(["user_message", "user_message", "user_message"]);
    expect(events[0]!.payload).toEqual({ content: [{ type: "text", text: "m1" }] });
    expect(events[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("throws ErrConflict when appending at an existing seq", async () => {
    await store.appendEvent(NS, sessionId, 1, completed(1));
    await expect(store.appendEvent(NS, sessionId, 1, completed(1))).rejects.toBeInstanceOf(
      ErrConflict,
    );
  });

  // The most important test in this phase: the (session_id, seq) PK is the entire
  // concurrency-control mechanism. Fire both inserts truly concurrently.
  it("lets exactly one of two concurrent same-seq appends win; the other ErrConflicts", async () => {
    const results = await Promise.allSettled([
      store.appendEvent(NS, sessionId, 1, completed(1)),
      store.appendEvent(NS, sessionId, 1, completed(1)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ErrConflict);
    expect(await store.readEvents(NS, sessionId)).toHaveLength(1); // only the winner
  });

  it("does not persist an appendEvent whose caller transaction rolls back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await store.appendEvent(NS, sessionId, 1, completed(1), tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.readEvents(NS, sessionId)).toEqual([]);
  });

  it("never returns another namespace's rows", async () => {
    await store.appendEvent(NS, sessionId, 1, completed(1));
    expect(await store.readEvents("other-ns", sessionId)).toEqual([]);
  });

  it("lastSeq is 0 for an empty session and tracks the max otherwise", async () => {
    expect(await store.lastSeq(NS, sessionId)).toBe(0);
    await store.appendEvent(NS, sessionId, 1, completed(1));
    await store.appendEvent(NS, sessionId, 2, completed(2));
    expect(await store.lastSeq(NS, sessionId)).toBe(2);
  });

  it("readPage paginates forward and reports hasMore", async () => {
    for (const seq of [1, 2, 3, 4, 5]) await store.appendEvent(NS, sessionId, seq, completed(seq));

    const page1 = await store.readPage(NS, sessionId, 0, 2);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.hasMore).toBe(true);

    const page2 = await store.readPage(NS, sessionId, 2, 2);
    expect(page2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page2.hasMore).toBe(true);

    const page3 = await store.readPage(NS, sessionId, 4, 2);
    expect(page3.events.map((e) => e.seq)).toEqual([5]);
    expect(page3.hasMore).toBe(false);
  });
});

// ====================================================================== JobQueue

describe("JobQueue", () => {
  // The atomic-dispatch property the whole design rests on: accepting a message
  // appends the event AND enqueues the job in one transaction — or neither happens.
  it("rolls back both the event and the job when the shared transaction aborts", async () => {
    const evt = makeEvent({ sessionId, namespace: NS, seq: 1 }, "user_message", {
      content: textContent("hi"),
    });
    await expect(
      db.transaction(async (tx) => {
        await store.appendEvent(NS, sessionId, 1, evt, tx);
        await queue.enqueue(tx, { id: randomUUID(), namespace: NS, sessionId, kind: "turn" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await store.readEvents(NS, sessionId)).toEqual([]);
    expect(await queue.depth()).toEqual({ queued: 0, running: 0, dead: 0 });
  });

  it("claims every job exactly once across two concurrent pullers, without blocking", async () => {
    const ids = Array.from({ length: 100 }, () => randomUUID());
    await db.insert(turnJobs).values(
      ids.map((id) => ({ id, namespace: NS, sessionId, kind: "turn" as JobKind })),
    );

    const drain = async (claimed: string[]) => {
      for (;;) {
        const job = await queue.pull();
        if (!job) return; // SKIP LOCKED → an empty result means "nothing left", never "blocked"
        claimed.push(job.id);
      }
    };
    const a: string[] = [];
    const b: string[] = [];
    await Promise.all([drain(a), drain(b)]);

    const all = [...a, ...b];
    expect(all).toHaveLength(100); // every job claimed
    expect(new Set(all).size).toBe(100); // none claimed twice
    expect([...all].sort()).toEqual([...ids].sort());
  });

  it("returns null from pull() on an empty queue", async () => {
    expect(await queue.pull()).toBeNull();
  });

  it("reclaims a job whose lease has expired, incrementing attempts", async () => {
    const id = await insertJob();
    const first = await queue.pull();
    expect(first?.id).toBe(id);
    expect(first?.attempts).toBe(1);

    // simulate a crashed worker: force the lease into the past
    await pool.query(
      "update turn_jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
      [id],
    );
    const second = await queue.pull();
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);
  });

  it("extendLease keeps a heartbeating job from being reclaimed", async () => {
    const id = await insertJob();
    await queue.pull(); // running, lease ≈ now + 60s

    // shrink the lease to almost-now, then heartbeat it far back out
    await pool.query(
      "update turn_jobs set lease_expires_at = now() + interval '1 second' where id = $1",
      [id],
    );
    await queue.extendLease(id);

    const { rows } = await pool.query<{ ahead: string }>(
      "select extract(epoch from (lease_expires_at - now())) as ahead from turn_jobs where id = $1",
      [id],
    );
    expect(Number(rows[0]!.ahead)).toBeGreaterThan(30); // pushed back toward +60s
    expect(await queue.pull()).toBeNull(); // not reclaimable while leased
  });

  it("nack backs off by 2^attempts, then dead-letters at max_attempts", async () => {
    const id = await insertJob();
    await queue.pull(); // attempts = 1
    await queue.nack(id);

    const backoff = await pool.query<{ state: string; delay: string; lease: Date | null }>(
      "select state, extract(epoch from (run_at - now())) as delay, lease_expires_at as lease from turn_jobs where id = $1",
      [id],
    );
    expect(backoff.rows[0]!.state).toBe("queued");
    expect(backoff.rows[0]!.lease).toBeNull();
    expect(Number(backoff.rows[0]!.delay)).toBeGreaterThan(0.5);
    expect(Number(backoff.rows[0]!.delay)).toBeLessThanOrEqual(2); // ≈ 2^1 = 2s

    // drive it to the dead-letter: attempts == max_attempts → 'dead'
    await pool.query("update turn_jobs set attempts = max_attempts where id = $1", [id]);
    await queue.nack(id);
    const dead = await pool.query<{ state: string }>(
      "select state from turn_jobs where id = $1",
      [id],
    );
    expect(dead.rows[0]!.state).toBe("dead");
    expect(await queue.pull()).toBeNull(); // a dead job is never handed out again
  });

  it("ack deletes the job row", async () => {
    const id = await insertJob();
    await queue.pull();
    await queue.ack(id);
    const { rows } = await pool.query("select 1 from turn_jobs where id = $1", [id]);
    expect(rows).toHaveLength(0);
  });

  it("hasActiveTurn tracks queued/running turns, clears on ack, and ignores provision", async () => {
    const id = await insertJob({ kind: "turn" });
    expect(await queue.hasActiveTurn(NS, sessionId)).toBe(true); // queued
    await queue.pull();
    expect(await queue.hasActiveTurn(NS, sessionId)).toBe(true); // running
    await queue.ack(id);
    expect(await queue.hasActiveTurn(NS, sessionId)).toBe(false);

    await insertJob({ kind: "provision" }); // a provision job is not an active turn
    expect(await queue.hasActiveTurn(NS, sessionId)).toBe(false);
  });

  it("onWake fires the callback when a job is enqueued from another connection", async () => {
    const listener = new Client({ connectionString: connectionUri });
    await listener.connect();
    try {
      let fired = 0;
      await onWake(listener, () => {
        fired += 1;
      });
      await enqueue(); // committed on the pool → pg_notify reaches the dedicated client
      await waitFor(() => fired > 0, 1_000);
      expect(fired).toBeGreaterThan(0);
    } finally {
      await listener.end();
    }
  });
});
