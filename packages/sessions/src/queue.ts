// packages/sessions/src/queue.ts — Phase C: the turn/provision job queue.
//
// Postgres IS the queue (the turn_jobs table + SELECT … FOR UPDATE SKIP LOCKED),
// never an external broker: enqueue must be atomic with the caller's event append,
// and one database means one transaction. The queue only promises at-least-once
// delivery — exactly-once lives in the event log (see store.ts). A row is a bare
// dispatch token ("session X needs attention"); it carries no payload, so
// delivering it twice is harmless.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Client } from "pg";
import type { Db, Tx } from "@funky/db";
import { turnJobs, type JobKind } from "@funky/db/schema";

// The worker imports these — it must not invent its own.
export const LEASE_MS = 60_000; // the claim sets lease = now + 60s
export const HEARTBEAT_MS = 15_000; // worker extends every 15s → 4× headroom
export const POLL_INTERVAL_MS = 1_000; // fallback poll when a NOTIFY is missed

// The lease as a SQL interval, derived from LEASE_MS so the two never drift. The
// value is a trusted numeric constant, hence sql.raw (not a bound param, whose type
// PG would have to infer under make_interval).
const leaseInterval = sql`make_interval(secs => ${sql.raw(String(LEASE_MS / 1000))})`;

export type Job = {
  id: string;
  namespace: string;
  sessionId: string;
  kind: JobKind;
  attempts: number; // AFTER the increment performed by the claim
  maxAttempts: number;
};

/** What the activity derivation (service.ts) needs to know about a session's active
 *  turn job. Read-only queue introspection; never used to drive work. */
export type ActiveTurnJob = {
  state: "queued" | "running";
  attempts: number;
  leaseExpired: boolean;
};

export class JobQueue {
  constructor(private readonly db: Db) {}

  /** MUST take the caller's tx — the enqueue is atomic with the caller's event
   *  append. Also fires pg_notify('funky_turns', '') INSIDE that tx, so the wake-up
   *  reaches listeners only if the transaction commits. */
  async enqueue(
    tx: Tx,
    job: { id: string; namespace: string; sessionId: string; kind: JobKind; runAt?: Date },
  ): Promise<void> {
    await tx.insert(turnJobs).values({
      id: job.id,
      namespace: job.namespace,
      sessionId: job.sessionId,
      kind: job.kind,
      ...(job.runAt ? { runAt: job.runAt } : {}),
    });
    await tx.execute(sql`select pg_notify('funky_turns', '')`);
  }

  /** The canonical claim: one committed UPDATE whose subquery locks a single row
   *  with FOR UPDATE SKIP LOCKED. Contention becomes *skip*, not *wait*, so a pool
   *  of pullers never convoys. The single statement IS the transaction — never wrap
   *  it in an explicit one (that reintroduces the convoy SKIP LOCKED exists to kill).
   *  Reclaims rows whose lease expired: a crashed worker's job becomes claimable. */
  async pull(): Promise<Job | null> {
    const res = await this.db.execute<{
      id: string;
      namespace: string;
      session_id: string;
      kind: JobKind;
      attempts: number;
      max_attempts: number;
    }>(sql`
      update turn_jobs
      set    state = 'running',
             lease_expires_at = now() + ${leaseInterval},
             attempts = attempts + 1
      where  id = (
        select id from turn_jobs
        where  (state = 'queued'  and run_at <= now())
           or  (state = 'running' and lease_expires_at < now())
        order  by run_at
        for update skip locked
        limit  1
      )
      returning id, namespace, session_id, kind, attempts, max_attempts
    `);
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      namespace: row.namespace,
      sessionId: row.session_id,
      kind: row.kind,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
    };
  }

  /** Heartbeat: push the lease out by LEASE_MS while the turn keeps running, so a
   *  live worker's job is never mistaken for a dead one and reclaimed. */
  async extendLease(jobId: string): Promise<void> {
    await this.db.execute(
      sql`update turn_jobs set lease_expires_at = now() + ${leaseInterval} where id = ${jobId}`,
    );
  }

  /** Success: drop the row (there is no job-history table in v1). */
  async ack(jobId: string): Promise<void> {
    await this.db.delete(turnJobs).where(eq(turnJobs.id, jobId));
  }

  /** Failure: exponential backoff, or → 'dead' once attempts reach max_attempts.
   *  `attempts` was already incremented by the claim, so 2^attempts = 2,4,8,16,32s.
   *  A dead row stays put — it IS the dead-letter queue — and pull() never sees it. */
  async nack(jobId: string): Promise<void> {
    await this.db.execute(sql`
      update turn_jobs
      set    state  = case when attempts >= max_attempts then 'dead' else 'queued' end,
             run_at = case when attempts >= max_attempts then run_at
                           else now() + make_interval(secs => power(2, attempts)) end,
             lease_expires_at = null
      where  id = ${jobId}
    `);
  }

  /** The activity read (service.ts): each session's single active turn job (queued or
   *  running — sendMessage's 409 guard keeps it to at most one), if any. leaseExpired
   *  is computed against the DATABASE clock — the same clock pull() reclaims by — so
   *  the API never disagrees with the queue about worker liveness. */
  async activeTurnJobStates(
    ns: string,
    sessionIds: string[],
    tx?: Tx,
  ): Promise<Map<string, ActiveTurnJob>> {
    if (sessionIds.length === 0) return new Map();
    const q: Pick<Db, "select"> = tx ?? this.db;
    const rows = await q
      .select({
        sessionId: turnJobs.sessionId,
        state: turnJobs.state,
        attempts: turnJobs.attempts,
        leaseExpired: sql<boolean>`coalesce(${turnJobs.leaseExpiresAt} < now(), false)`,
      })
      .from(turnJobs)
      .where(
        and(
          eq(turnJobs.namespace, ns),
          inArray(turnJobs.sessionId, sessionIds),
          eq(turnJobs.kind, "turn"),
          inArray(turnJobs.state, ["queued", "running"]),
        ),
      );
    const out = new Map<string, ActiveTurnJob>();
    for (const r of rows) {
      if (r.state !== "queued" && r.state !== "running") continue; // narrowed by the query
      out.set(r.sessionId, {
        state: r.state,
        attempts: Number(r.attempts),
        leaseExpired: r.leaseExpired,
      });
    }
    return out;
  }

  /** The API's one-in-flight-turn-per-session guard (→ 409). Counts only turn jobs
   *  that are queued or running; provision jobs are ignored. */
  async hasActiveTurn(ns: string, sessionId: string, tx?: Tx): Promise<boolean> {
    const q: Pick<Db, "select"> = tx ?? this.db;
    const [row] = await q
      .select({ id: turnJobs.id })
      .from(turnJobs)
      .where(
        and(
          eq(turnJobs.namespace, ns),
          eq(turnJobs.sessionId, sessionId),
          eq(turnJobs.kind, "turn"),
          inArray(turnJobs.state, ["queued", "running"]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Autoscaling signal + metric — global across namespaces (the worker pool is
   *  shared). 'done' is never used (ack deletes), so it's absent from the result. */
  async depth(): Promise<{ queued: number; running: number; dead: number }> {
    const rows = await this.db
      .select({ state: turnJobs.state, count: sql<number>`count(*)::int` })
      .from(turnJobs)
      .groupBy(turnJobs.state);
    const out = { queued: 0, running: 0, dead: 0 };
    for (const r of rows) {
      if (r.state === "queued" || r.state === "running" || r.state === "dead") {
        out[r.state] = Number(r.count);
      }
    }
    return out;
  }
}

/** Wake-up subscription. `client` MUST be a dedicated pg.Client (NEVER a pooled
 *  connection — the pool recycles it and the listener silently stops receiving).
 *  The app owns the client's lifecycle; this only registers the handler + LISTENs.
 *  The payload is ignored: a NOTIFY is a wake-up, and pull() re-reads the table. */
export async function onWake(client: Client, cb: () => void): Promise<void> {
  client.on("notification", (msg) => {
    if (msg.channel === "funky_turns") cb();
  });
  await client.query("listen funky_turns");
}
