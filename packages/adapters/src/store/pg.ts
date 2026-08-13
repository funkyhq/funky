// The Store port over vanilla postgres. One adapter, many runtimes: the
// composition root binds `db` to PGlite (tests, local REPL) or a network
// postgres (compose, k8s, managed) — there is no test/prod adapter split.
//
// Concurrency discipline:
// - Per-session write serialization: every writing transaction locks the
//   session row (SELECT … FOR UPDATE) before minting seq numbers, so the
//   per-session log stays gapless and monotonic.
// - Lock order is item → session everywhere an item is involved; no path
//   takes session → item, so no cycle exists.
// - claimItem uses FOR UPDATE SKIP LOCKED: contended claimers never
//   queue behind each other, exactly one wins a given item.
// - Fencing is token + live lease, symmetric across heartbeat and
//   commitStep: a stale token or an expired lease rejects the write,
//   even if nobody reclaimed the item (strict expiry, 2026-08-12).
//   The token is minted here, fresh per claim, so credential
//   uniqueness is structural — a re-claim always re-issues, and a
//   previous holder's zombie can never present valid credentials.
//   After expiry an item's fate always belongs to its next claimer —
//   late work is discarded, never merged, and the P4 reaper can
//   synthesize over an expired item without racing a slow worker.
//
// The clock is injected (`now`) so lease expiry is testable; all time
// comparisons use it — never SQL now().

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  AgentConfig,
  AgentMessage,
  CreateAgentConfigRequest,
  CreateEnvConfigRequest,
  CreateSessionRequest,
  EnvConfig,
  IntakeResult,
  type JsonValue,
  PendingInput,
  Session,
  SessionEntry,
  UserMessage,
  WorkItem,
} from "@funky/core";
import type { CommitStepRequest, Store } from "@funky/agent";
import {
  agentConfigs,
  envConfigs,
  pendingInputs,
  sessionEntries,
  sessions,
  workItems,
  type WrappedJson,
} from "./schema";

/** Any drizzle pg database — PGlite and node-postgres instances both fit. */
export type StoreDb = PgAsyncDatabase<PgQueryResultHKT>;
type Tx = Parameters<Parameters<StoreDb["transaction"]>[0]>[0];

export interface PgStoreOptions {
  /** Injected clock; defaults to wall time. All lease math uses it. */
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString();
const wrap = (v: JsonValue | undefined): WrappedJson | null => (v === undefined ? null : { v });
const unwrapped = (w: WrappedJson | null): { metadata?: JsonValue } =>
  w === null ? {} : { metadata: w.v };

export function createPgStore(db: StoreDb, opts: PgStoreOptions = {}): Store {
  const now = opts.now ?? (() => new Date());

  async function lockSession(tx: Tx, sessionId: string): Promise<void> {
    const rows = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    if (rows.length === 0) throw new Error(`unknown session: ${sessionId}`);
  }

  /** Mint envelopes and append; caller must hold the session lock. */
  async function appendEntries(
    tx: Tx,
    sessionId: string,
    payloads: Array<Record<string, unknown>>,
  ): Promise<void> {
    const [tail] = await tx
      .select({ max: sql<number>`coalesce(max(${sessionEntries.seq}), -1)` })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId));
    let seq = Number(tail?.max ?? -1);
    for (const payload of payloads) {
      seq += 1;
      const entry = SessionEntry.parse({
        id: randomUUID(),
        seq,
        timestamp: iso(now()),
        ...payload,
      });
      await tx.insert(sessionEntries).values({ sessionId, seq, entry });
    }
  }

  return {
    async createAgentConfig(req) {
      const parsed = CreateAgentConfigRequest.parse(req);
      const id = randomUUID();
      await db.insert(agentConfigs).values({
        id,
        inference: parsed.inference,
        systemPrompt: parsed.systemPrompt,
        metadata: wrap(parsed.metadata),
        createdAt: now(),
      });
      return id;
    },

    async getAgentConfig(id) {
      const [row] = await db.select().from(agentConfigs).where(eq(agentConfigs.id, id));
      if (!row) return undefined;
      return AgentConfig.parse({
        id: row.id,
        inference: row.inference,
        systemPrompt: row.systemPrompt,
        ...unwrapped(row.metadata),
        createdAt: iso(row.createdAt),
      });
    },

    async createEnvConfig(req) {
      const parsed = CreateEnvConfigRequest.parse(req);
      const id = randomUUID();
      await db.insert(envConfigs).values({
        id,
        // Materialized at create — resolved decisions, not restatable defaults.
        network: parsed.network ?? { type: "unrestricted" },
        packages: parsed.packages ?? {},
        metadata: wrap(parsed.metadata),
        createdAt: now(),
      });
      return id;
    },

    async getEnvConfig(id) {
      const [row] = await db.select().from(envConfigs).where(eq(envConfigs.id, id));
      if (!row) return undefined;
      return EnvConfig.parse({
        id: row.id,
        network: row.network,
        packages: row.packages,
        ...unwrapped(row.metadata),
        createdAt: iso(row.createdAt),
      });
    },

    async createSession(req) {
      const parsed = CreateSessionRequest.parse(req);
      // Configs are write-once and never deleted, so this pre-check cannot
      // go stale; the FK constraints remain as the structural backstop.
      const [agent] = await db
        .select({ id: agentConfigs.id })
        .from(agentConfigs)
        .where(eq(agentConfigs.id, parsed.agentConfigId));
      if (!agent) throw new Error(`unknown agent config: ${parsed.agentConfigId}`);
      const [env] = await db
        .select({ id: envConfigs.id })
        .from(envConfigs)
        .where(eq(envConfigs.id, parsed.envConfigId));
      if (!env) throw new Error(`unknown env config: ${parsed.envConfigId}`);
      const id = randomUUID();
      await db.insert(sessions).values({
        id,
        agentConfigId: parsed.agentConfigId,
        envConfigId: parsed.envConfigId,
        metadata: wrap(parsed.metadata),
        createdAt: now(),
      });
      return id;
    },

    async getSession(id) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      if (!row) return undefined;
      return Session.parse({
        id: row.id,
        agentConfigId: row.agentConfigId,
        envConfigId: row.envConfigId,
        ...unwrapped(row.metadata),
        createdAt: iso(row.createdAt),
      });
    },

    async readEntries(sessionId, after) {
      const rows = await db
        .select({ entry: sessionEntries.entry })
        .from(sessionEntries)
        .where(
          after === undefined
            ? eq(sessionEntries.sessionId, sessionId)
            : and(eq(sessionEntries.sessionId, sessionId), gt(sessionEntries.seq, after)),
        )
        .orderBy(asc(sessionEntries.seq));
      return rows.map((r) => SessionEntry.parse(r.entry));
    },

    async listItems(sessionId) {
      const rows = await db
        .select()
        .from(workItems)
        .where(eq(workItems.sessionId, sessionId))
        .orderBy(asc(workItems.createdAt));
      return rows.map((r) =>
        WorkItem.parse({ id: r.id, sessionId: r.sessionId, type: r.type, status: r.status }),
      );
    },

    async pendingInputs(sessionId) {
      const rows = await db
        .select()
        .from(pendingInputs)
        .where(eq(pendingInputs.sessionId, sessionId))
        .orderBy(asc(pendingInputs.ord));
      return rows.map((r) =>
        PendingInput.parse({
          id: r.id,
          sessionId: r.sessionId,
          message: r.message,
          arrivedAt: iso(r.arrivedAt),
        }),
      );
    },

    async claimItem(req) {
      return db.transaction(async (tx) => {
        const t = now();
        // "Expired" has one spelling everywhere: live iff now < leaseExpiresAt.
        // Equality is dead — heartbeat and commitStep agree, so the instant
        // the old holder loses authority is the instant a claimer gains it.
        const claimable = or(
          eq(workItems.status, "ready"),
          and(eq(workItems.status, "leased"), lte(workItems.leaseExpiresAt, t)),
        );
        const [candidate] = await tx
          .select({ id: workItems.id, sessionId: workItems.sessionId, type: workItems.type })
          .from(workItems)
          .where(
            req.sessionId === undefined
              ? claimable
              : and(claimable, eq(workItems.sessionId, req.sessionId)),
          )
          .orderBy(asc(workItems.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!candidate) return undefined;
        const token = randomUUID(); // fresh per claim — never re-issued
        await tx
          .update(workItems)
          .set({
            status: "leased",
            leaseToken: token,
            leaseMs: req.leaseMs,
            leaseExpiresAt: new Date(t.getTime() + req.leaseMs),
          })
          .where(eq(workItems.id, candidate.id));
        return {
          item: WorkItem.parse({
            id: candidate.id,
            sessionId: candidate.sessionId,
            type: candidate.type,
            status: "leased",
          }),
          token,
        };
      });
    },

    async heartbeat(itemId, token) {
      const t = now();
      const rows = await db
        .update(workItems)
        .set({
          leaseExpiresAt: sql`${iso(t)}::timestamptz + ${workItems.leaseMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(workItems.id, itemId),
            eq(workItems.leaseToken, token),
            eq(workItems.status, "leased"),
            gt(workItems.leaseExpiresAt, t), // expired = lost, even if unclaimed
          ),
        )
        .returning({ id: workItems.id });
      return rows.length > 0;
    },

    async requestCancel(sessionId) {
      await db.transaction(async (tx) => {
        await lockSession(tx, sessionId);
        await appendEntries(tx, sessionId, [{ type: "control", control: "cancel" }]);
      });
    },

    async intake(sessionId, message) {
      const msg = UserMessage.parse(message);
      return db.transaction(async (tx) => {
        await lockSession(tx, sessionId); // the race referee
        const open = await tx
          .select({ id: workItems.id })
          .from(workItems)
          .where(and(eq(workItems.sessionId, sessionId), ne(workItems.status, "done")))
          .limit(1);
        if (open.length > 0) {
          const inputId = randomUUID();
          await tx
            .insert(pendingInputs)
            .values({ id: inputId, sessionId, message: msg, arrivedAt: now() });
          return IntakeResult.parse({ kind: "queued", inputId });
        }
        await appendEntries(tx, sessionId, [{ type: "message", message: msg }]);
        const itemId = randomUUID();
        await tx
          .insert(workItems)
          .values({ id: itemId, sessionId, type: "inference", status: "ready", createdAt: now() });
        return IntakeResult.parse({ kind: "started", itemId });
      });
    },

    async commitStep(req: CommitStepRequest) {
      const messages = req.append.map((m) => AgentMessage.parse(m));
      await db.transaction(async (tx) => {
        const [item] = await tx
          .select()
          .from(workItems)
          .where(eq(workItems.id, req.itemId))
          .for("update");
        if (!item) throw new Error(`commitStep: unknown item ${req.itemId}`);
        if (item.status === "done") {
          if (item.leaseToken !== req.token)
            throw new Error(`commitStep: fenced — ${req.itemId} was finished under another claim`);
          return; // idempotent re-commit (crash-after-commit recovery)
        }
        if (item.status !== "leased" || item.leaseToken !== req.token)
          throw new Error(`commitStep: fenced — stale token for ${req.itemId}`);
        if (item.leaseExpiresAt === null || item.leaseExpiresAt.getTime() <= now().getTime())
          throw new Error(`commitStep: fenced — ${req.itemId}'s lease expired before commit`);
        await lockSession(tx, item.sessionId);
        await appendEntries(
          tx,
          item.sessionId,
          messages.map((m) => ({ type: "message", message: m })),
        );
        if (req.consumeInputs !== undefined && req.consumeInputs.length > 0) {
          const drained = await tx
            .delete(pendingInputs)
            .where(
              and(
                eq(pendingInputs.sessionId, item.sessionId),
                inArray(pendingInputs.id, req.consumeInputs),
              ),
            )
            .returning({ id: pendingInputs.id });
          if (drained.length !== req.consumeInputs.length)
            throw new Error("commitStep: consumeInputs names an unknown or already-consumed input");
        }
        await tx.update(workItems).set({ status: "done" }).where(eq(workItems.id, item.id));
        if (req.next.kind !== "end_run") {
          await tx.insert(workItems).values({
            id: randomUUID(),
            sessionId: item.sessionId,
            type: req.next.kind,
            status: "ready",
            createdAt: now(),
          });
          return;
        }
        // end_run: the run's end is the atomic NON-creation of a next item.
        // Pending inputs auto-chain a new run in this same transaction —
        // except after a cancel, which parks them for the next intake.
        if (req.next.status === "cancelled") return;
        const parked = await tx
          .select()
          .from(pendingInputs)
          .where(eq(pendingInputs.sessionId, item.sessionId))
          .orderBy(asc(pendingInputs.ord));
        if (parked.length === 0) return;
        await appendEntries(
          tx,
          item.sessionId,
          parked.map((p) => ({ type: "message", message: p.message })),
        );
        await tx.delete(pendingInputs).where(
          inArray(
            pendingInputs.ord,
            parked.map((p) => p.ord),
          ),
        );
        await tx.insert(workItems).values({
          id: randomUUID(),
          sessionId: item.sessionId,
          type: "inference",
          status: "ready",
          createdAt: now(),
        });
      });
    },
  };
}
