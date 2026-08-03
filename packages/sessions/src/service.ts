// packages/sessions/src/service.ts — Phase F: the sessions resource.
//
// All business rules for /v1/sessions. Like the configs services, every query is scoped
// by ctx.namespace and this is one of the few files that touch Drizzle. It composes the
// two Phase-C data-access modules (EventStore + JobQueue) so the two rules that shape the
// API hold:
//   Rule 1 — accepting a message is ONE transaction (append user_message + enqueue turn).
//   Rule 2 — the log is the stream (SSE re-reads session_events; see apps/api/src/sse.ts).
//
// resolved_env and sandbox_handle are internal and NEVER exposed by toSession().

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { AuthContext } from "@funky/configs";
import { ConflictError, NotFoundError } from "@funky/configs";
import type { Db, Tx } from "@funky/db";
import {
  agentConfigs,
  agentConfigVersions,
  envConfigs,
  sessions,
  type SessionStatus,
} from "@funky/db/schema";
import {
  type EventPayload,
  type EventType,
  makeEvent,
  type SessionEvent,
  textContent,
} from "./events";
import type { ActiveTurnJob, JobQueue } from "./queue";
import { ErrConflict, type EventStore } from "./store";

// ---------------------------------------------------------------- API shapes

/** The Session object — the API's response shape. Internal columns (resolved_env,
 *  sandbox_handle) are deliberately absent. */
export type Session = {
  type: "session";
  id: string;
  status: SessionStatus;
  /** Derived at read time from the event log + job queue — never stored. */
  activity: SessionActivity;
  agent: { id: string; version: number };
  environment_id: string;
  title: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** What the agent is doing right now, as a pure function of durable state:
 *    idle         — waiting for input; nothing queued or running.
 *    running      — a turn is queued for dispatch or actively executing on a worker.
 *    rescheduling — a delivery failed transiently (or its worker died); the queue is
 *                   backing off before retrying automatically.
 *    terminated   — the session has ended (status failed/archived) and accepts nothing.
 *  DERIVED, never stored: a worker-maintained copy would go stale the moment a worker
 *  died mid-turn, and the log + queue already hold the truth (see worker.ts's header). */
export type SessionActivity = "idle" | "running" | "rescheduling" | "terminated";

/** An event as the API and SSE stream expose it (§3 of the handoff). */
export type ApiSessionEvent = {
  type: EventType;
  seq: number;
  session_id: string;
  created_at: string;
  payload: EventPayload<EventType>;
};

export type AgentRef = string | { id: string; version: number };

export type CreateSessionInput = {
  id?: string;
  agent: AgentRef;
  environment_id: string;
  title?: string | null;
  metadata?: Record<string, string>;
};

export type SessionPage = { data: Session[]; has_more: boolean; last_id?: string };

type SessionRow = typeof sessions.$inferSelect;

export class SessionsService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly queue: JobQueue,
  ) {}

  // ---------------------------------------------------------------- create
  async create(
    ctx: AuthContext,
    input: CreateSessionInput,
  ): Promise<{ session: Session; created: boolean }> {
    const id = input.id ?? uuidv7();

    // Resolve BOTH references first (outside the tx): a bare agent id means "latest
    // version, resolved once, now" — the concrete number is pinned on the row and never
    // re-resolved. 404 if missing in this namespace, 409 if archived.
    const { agentConfigId, agentVersion } = await this.resolveAgent(ctx, input.agent);
    const envConfigId = await this.resolveEnv(ctx, input.environment_id);

    try {
      return await this.db.transaction(async (tx) => {
        if (input.id) {
          const existing = await this.findRaw(tx, ctx, input.id);
          if (existing) {
            return await this.resolveIdempotentCreate(ctx, existing, input, agentConfigId, agentVersion, envConfigId);
          }
        }
        await tx.insert(sessions).values({
          id,
          namespace: ctx.namespace,
          agentConfigId,
          agentVersion,
          envConfigId,
          status: "provisioning",
          title: input.title ?? null,
          metadata: input.metadata ?? {},
        });
        // One transaction: the session row + the provision job land together.
        await this.queue.enqueue(tx, {
          id: uuidv7(),
          namespace: ctx.namespace,
          sessionId: id,
          kind: "provision",
        });
        const created = await this.findRaw(tx, ctx, id);
        // A fresh session has no turn job by construction (only the provision job,
        // which activity ignores) — no queue read needed: it is idle.
        return { session: toSession(created!, deriveActivity(created!, undefined)), created: true };
      });
    } catch (err) {
      // Two same-id creates raced: loser hits the PK. Re-resolve via idempotency.
      if (isUniqueViolation(err) && input.id) {
        const existing = await this.findRaw(this.db, ctx, input.id);
        if (existing) {
          return await this.resolveIdempotentCreate(ctx, existing, input, agentConfigId, agentVersion, envConfigId);
        }
      }
      throw err;
    }
  }

  private async resolveIdempotentCreate(
    ctx: AuthContext,
    existing: SessionRow,
    input: CreateSessionInput,
    agentConfigId: string,
    agentVersion: number,
    envConfigId: string,
  ): Promise<{ session: Session; created: boolean }> {
    const same =
      existing.agentConfigId === agentConfigId &&
      existing.agentVersion === agentVersion &&
      existing.envConfigId === envConfigId &&
      (existing.title ?? null) === (input.title ?? null) &&
      jsonEq(existing.metadata, input.metadata ?? {});
    if (!same) {
      throw new ConflictError("a session with this id exists with a different configuration");
    }
    return { session: toSession(existing, await this.activityOf(ctx, existing)), created: false };
  }

  // ------------------------------------------------------------------- get
  async get(ctx: AuthContext, id: string): Promise<Session> {
    const row = await this.findRaw(this.db, ctx, id);
    if (!row) throw new NotFoundError("session not found");
    return toSession(row, await this.activityOf(ctx, row));
  }

  // ------------------------------------------------------------------ list
  async list(
    ctx: AuthContext,
    opts: { limit: number; afterId?: string; includeArchived: boolean },
  ): Promise<SessionPage> {
    const where = [eq(sessions.namespace, ctx.namespace)];
    if (opts.afterId) where.push(lt(sessions.id, opts.afterId));
    if (!opts.includeArchived) where.push(isNull(sessions.archivedAt));

    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(...where))
      .orderBy(desc(sessions.id)) // uuidv7 ≈ newest first
      .limit(opts.limit + 1);

    const page = rows.slice(0, opts.limit);
    // ONE queue read for the whole page, not one per row.
    const jobs = await this.queue.activeTurnJobStates(
      ctx.namespace,
      page.map((r) => r.id),
    );
    return {
      data: page.map((r) => toSession(r, deriveActivity(r, jobs.get(r.id)))),
      has_more: rows.length > opts.limit,
      last_id: page.at(-1)?.id,
    };
  }

  // --------------------------------------------------------------- archive
  async archive(ctx: AuthContext, id: string): Promise<Session> {
    // Idempotent + permanent: keeps the original archived_at if already set. Blocks new
    // messages (status → archived); does NOT tear down the sandbox (a non-goal for now).
    await this.db
      .update(sessions)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.namespace, ctx.namespace),
          isNull(sessions.archivedAt),
        ),
      );
    return this.get(ctx, id); // throws NotFound if it never existed in this ns
  }

  // ----------------------------------------------------------- send message
  /** The money path. Append the user_message event AND enqueue the turn job in ONE
   *  transaction — Rule 1. One in-flight turn per session (409 otherwise). Allowed while
   *  provisioning: the turn job nacks with backoff until the sandbox is ready. */
  async sendMessage(
    ctx: AuthContext,
    id: string,
    content: string,
  ): Promise<{ turn: "queued"; seq: number }> {
    // A concurrent message can steal the seq (e.g. a provision worker appending
    // session_provisioned at the same seq). Retry the whole transaction once; a second
    // conflict becomes a 409.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const [session] = await tx
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, id), eq(sessions.namespace, ctx.namespace)))
            .for("update");
          if (!session) throw new NotFoundError("session not found");
          if (session.status === "archived" || session.status === "failed") {
            throw new ConflictError(`session is ${session.status} and cannot accept messages`);
          }
          if (await this.queue.hasActiveTurn(ctx.namespace, id, tx)) {
            throw new ConflictError("a turn is already in progress for this session");
          }

          const seq = (await this.store.lastSeq(ctx.namespace, id, tx)) + 1;
          const evt = makeEvent({ sessionId: id, namespace: ctx.namespace, seq }, "user_message", {
            content: textContent(content),
          });
          await this.store.appendEvent(ctx.namespace, id, seq, evt, tx);
          await this.queue.enqueue(tx, {
            id: uuidv7(),
            namespace: ctx.namespace,
            sessionId: id,
            kind: "turn",
          });
          return { turn: "queued" as const, seq };
        });
      } catch (err) {
        if (err instanceof ErrConflict) {
          if (attempt === 0) continue; // retry the whole transaction once
          throw new ConflictError("a concurrent message won the sequence; retry");
        }
        throw err;
      }
    }
  }

  // ------------------------------------------------------------- read events
  async getEvents(
    ctx: AuthContext,
    id: string,
    opts: { afterSeq: number; limit: number },
  ): Promise<{ data: ApiSessionEvent[]; has_more: boolean; last_seq: number }> {
    await this.assertExists(ctx, id); // 404 — identical to a cross-namespace read
    const { events, hasMore } = await this.store.readPage(
      ctx.namespace,
      id,
      opts.afterSeq,
      opts.limit,
    );
    const lastSeq = await this.store.lastSeq(ctx.namespace, id);
    return { data: events.map(toApiEvent), has_more: hasMore, last_seq: lastSeq };
  }

  // --------------------------------------------------------------- helpers
  private async findRaw(
    db: Pick<Db, "select">,
    ctx: AuthContext,
    id: string,
  ): Promise<SessionRow | undefined> {
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.namespace, ctx.namespace)));
    return row;
  }

  private async assertExists(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.findRaw(this.db, ctx, id);
    if (!row) throw new NotFoundError("session not found");
  }

  private async activityOf(ctx: AuthContext, row: SessionRow): Promise<SessionActivity> {
    const jobs = await this.queue.activeTurnJobStates(ctx.namespace, [row.id]);
    return deriveActivity(row, jobs.get(row.id));
  }

  private async resolveAgent(
    ctx: AuthContext,
    ref: AgentRef,
  ): Promise<{ agentConfigId: string; agentVersion: number }> {
    const agentConfigId = typeof ref === "string" ? ref : ref.id;
    const [ident] = await this.db
      .select()
      .from(agentConfigs)
      .where(and(eq(agentConfigs.id, agentConfigId), eq(agentConfigs.namespace, ctx.namespace)));
    if (!ident) throw new NotFoundError("agent not found");
    if (ident.archivedAt) {
      throw new ConflictError("agent is archived and cannot start new sessions");
    }

    // Bare id → latest, resolved once, now. Explicit version → verify it exists.
    if (typeof ref === "string") {
      return { agentConfigId, agentVersion: ident.latestVersion };
    }
    const [version] = await this.db
      .select({ version: agentConfigVersions.version })
      .from(agentConfigVersions)
      .where(
        and(
          eq(agentConfigVersions.agentConfigId, agentConfigId),
          eq(agentConfigVersions.namespace, ctx.namespace),
          eq(agentConfigVersions.version, ref.version),
        ),
      );
    if (!version) throw new NotFoundError("agent version not found");
    return { agentConfigId, agentVersion: ref.version };
  }

  private async resolveEnv(ctx: AuthContext, envConfigId: string): Promise<string> {
    const [env] = await this.db
      .select()
      .from(envConfigs)
      .where(and(eq(envConfigs.id, envConfigId), eq(envConfigs.namespace, ctx.namespace)));
    if (!env) throw new NotFoundError("environment not found");
    if (env.archivedAt) {
      throw new ConflictError("environment is archived and cannot start new sessions");
    }
    return envConfigId;
  }
}

// ------------------------------------------------------------ pure helpers

/** Session status + its active turn job (if any) → activity. Exported for tests; the
 *  full state table lives on SessionActivity's doc comment. */
export function deriveActivity(
  row: Pick<SessionRow, "status">,
  job: ActiveTurnJob | undefined,
): SessionActivity {
  if (row.status === "failed" || row.status === "archived") return "terminated";
  if (!job) return "idle";
  if (job.state === "running") {
    // A live lease is a worker actively driving the turn. An expired one is a dead
    // worker whose job the queue will hand out again — retrying, effectively.
    return job.leaseExpired ? "rescheduling" : "running";
  }
  // queued: attempts=0 is the just-enqueued dispatch sliver (a worker is about to pick
  // it up); attempts>0 means a delivery came back and the queue is backing off first.
  return job.attempts > 0 ? "rescheduling" : "running";
}

function toSession(row: SessionRow, activity: SessionActivity): Session {
  return {
    type: "session",
    id: row.id,
    status: row.status,
    activity,
    agent: { id: row.agentConfigId, version: row.agentVersion },
    environment_id: row.envConfigId,
    title: row.title,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

/** Map a log event to the API/SSE shape. Shared by GET /events and the SSE stream. */
export function toApiEvent(e: SessionEvent): ApiSessionEvent {
  return {
    type: e.type,
    seq: e.seq,
    session_id: e.sessionId,
    created_at: e.createdAt.toISOString(),
    payload: e.payload,
  };
}

/** Key-order-insensitive deep equality for the jsonb metadata column. */
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .sort(([k1], [k2]) => k1.localeCompare(k2))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return x;
}

/** Postgres unique_violation. drizzle wraps driver errors, exposing the pg error as
 *  `cause`, so walk the chain. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}
