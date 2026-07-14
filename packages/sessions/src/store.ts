// packages/sessions/src/store.ts — Phase C: the append-only event log.
//
// The ONLY module that reads or writes session_events. `appendEvent` is the sole
// writer and it is a plain INSERT: losing the (session_id, seq) primary-key race
// surfaces as SQLSTATE 23505, which we translate to ErrConflict — "another worker
// already owns this turn; stand down." There is deliberately NO update or delete
// path; the log is immutable, and exactly-once lives here, not in the queue.

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db, Tx } from "@funky/db";
import { sessionEvents } from "@funky/db/schema";
import { parseEvent, type SessionEvent } from "./events";

/** Thrown when the (session_id, seq) PK is violated — another writer won the race.
 *  Callers treat this as "someone else owns this turn": abort + ack, NOT an error. */
export class ErrConflict extends Error {
  readonly kind = "conflict" as const;
}

/** Test-only fault seam (Phase H). Fired after every successful append so the chaos
 *  suite can crash a worker at a PRECISE log position ("after the Nth append") without
 *  mangling internals. In production it is `undefined`: the `?.` below is the only trace,
 *  so there is no branch and no cost on the hot path. A hook may `worker.kill()` and/or
 *  throw to abandon the turn mid-flight — see tests/chaos. */
export type AppendHook = (e: { sessionId: string; seq: number }) => void | Promise<void>;

export class EventStore {
  constructor(
    private readonly db: Db,
    /** undefined in production; tests/chaos passes a crash injector. See AppendHook. */
    private readonly onAfterAppend?: AppendHook,
  ) {}

  /** Full log, ascending. (v1 sessions are short; API-level pagination uses readPage.) */
  async readEvents(ns: string, sessionId: string, afterSeq?: number): Promise<SessionEvent[]> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.namespace, ns),
          eq(sessionEvents.sessionId, sessionId),
          afterSeq !== undefined ? gt(sessionEvents.seq, afterSeq) : undefined,
        ),
      )
      .orderBy(asc(sessionEvents.seq));
    // parseEvent on every row: a log entry that no longer parses is a bug, not a
    // row to skip — let it throw loudly.
    return rows.map(parseEvent);
  }

  /** Page for the API / SSE replay. Reads limit+1 to decide hasMore without a count. */
  async readPage(
    ns: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: SessionEvent[]; hasMore: boolean }> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.namespace, ns),
          eq(sessionEvents.sessionId, sessionId),
          gt(sessionEvents.seq, afterSeq),
        ),
      )
      .orderBy(asc(sessionEvents.seq))
      .limit(limit + 1);
    return { events: rows.slice(0, limit).map(parseEvent), hasMore: rows.length > limit };
  }

  /** Conditional append. `seq` MUST be caller-computed (lastSeq + 1). Plain INSERT;
   *  on SQLSTATE 23505 → ErrConflict. Fires NOTIFY 'funky_events' with the POINTER
   *  `${sessionId}:${seq}` (the SSE layer re-reads the row — the notification never
   *  carries event data) in the SAME transaction as the insert, so a rollback takes
   *  the wake-up with it and a wake-up only ever means "a committed row exists". */
  async appendEvent(
    ns: string,
    sessionId: string,
    seq: number,
    event: Omit<SessionEvent, "createdAt">,
    tx?: Tx,
  ): Promise<void> {
    const write = async (q: Tx) => {
      try {
        await q.insert(sessionEvents).values({
          sessionId,
          seq,
          namespace: ns,
          type: event.type,
          payload: event.payload,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ErrConflict("seq taken");
        throw err;
      }
      await q.execute(sql`select pg_notify('funky_events', ${`${sessionId}:${seq}`})`);
    };
    // With a caller's tx the append is atomic with their other writes (e.g. the job
    // enqueue). Without one, open a short tx so the insert and its NOTIFY commit —
    // or roll back — together.
    if (tx) {
      await write(tx);
    } else {
      await this.db.transaction(write);
    }
    // Fault seam (Phase H). No-op in production. With a caller's tx it runs before their
    // COMMIT (a throw rolls the append back — the crash-mid-provision case); standalone it
    // runs after COMMIT (the row is durable — the crash-mid-turn case). A hook that throws
    // propagates like any append failure; runTurn's error policy treats it as a transient
    // fault (retry_later) and, having also been `kill()`ed, the worker abandons the job.
    await this.onAfterAppend?.({ sessionId, seq });
  }

  /** Highest seq for a session, 0 if empty. The API uses this to compute the next
   *  seq (lastSeq + 1) for the append. Ordering by the PK makes this an index scan. */
  async lastSeq(ns: string, sessionId: string, tx?: Tx): Promise<number> {
    const q: Pick<Db, "select"> = tx ?? this.db;
    const [row] = await q
      .select({ seq: sessionEvents.seq })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.namespace, ns), eq(sessionEvents.sessionId, sessionId)))
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    return row?.seq ?? 0;
  }
}

/** Postgres unique_violation. drizzle wraps driver errors (DrizzleQueryError),
 *  exposing the underlying pg error as `cause`, so walk the chain. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}
