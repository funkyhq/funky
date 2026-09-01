// The Store port over vanilla postgres. One adapter, many runtimes: the
// composition root binds `db` to PGlite (tests) or a network postgres
// (compose, k8s, managed) — there is no test/prod adapter split.
//
// Concurrency discipline:
// - Per-session write serialization: every writing transaction locks the
//   session row (SELECT … FOR UPDATE) before minting seq numbers, so the
//   per-session log stays gapless and monotonic.
// - Lock order is item → session everywhere an item is involved; no path
//   takes session → item, so no cycle exists.
// - createSession holds FOR SHARE locks on both config rows until it
//   commits, while each config archive method's UPDATE takes its row
//   exclusively: the operations serialize, so no session is born against
//   either archived config. The env lock also makes the recipe snapshot a
//   committed state: a racing updateEnvConfig lands strictly before or after
//   it — never inside. Shared mode lets concurrent creates proceed together.
//   Lock order is agent → env, and no path takes env → agent, so no cycle
//   exists.
// - archiveSession, intake, and the liveness-changing half of commitStep
//   serialize on the session row. Archive sees either idle or one open item,
//   never a stale gap between checking and stamping the terminal state.
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
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  AgentConfig,
  AgentConfigRef,
  AgentConfigVersionRef,
  AgentMessage,
  CreateAgentConfigRequest,
  CreateEnvConfigRequest,
  CreateSessionRequest,
  EnvConfig,
  EnvConfigRef,
  EnvConfigSnapshot,
  IntakeResult,
  type JsonValue,
  ListAgentConfigsRequest,
  ListEnvConfigsRequest,
  ListSessionsRequest,
  PendingInput,
  Session,
  SessionEntry,
  SessionRef,
  UpdateAgentConfigRequest,
  UpdateEnvConfigRequest,
  UserMessage,
  WorkItem,
  WorkItemRef,
} from "@funky/core";
import {
  ArchivedError,
  type CommitStepRequest,
  FencedError,
  SessionNotIdleError,
  type Store,
  VersionConflictError,
} from "@funky/agent";
import {
  agentConfigs,
  agentConfigVersions,
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

type AgentConfigRow = Omit<typeof agentConfigVersions.$inferSelect, "agentConfigId"> & {
  id: string;
  namespace: string;
  createdAt: Date;
  archivedAt: Date | null;
};

const agentConfigColumns = {
  version: agentConfigVersions.version,
  inference: agentConfigVersions.inference,
  systemPrompt: agentConfigVersions.systemPrompt,
  metadata: agentConfigVersions.metadata,
  updatedAt: agentConfigVersions.updatedAt,
  id: agentConfigs.id,
  namespace: agentConfigs.namespace,
  createdAt: agentConfigs.createdAt,
  archivedAt: agentConfigs.archivedAt,
};

const currentAgentVersion = and(
  eq(agentConfigVersions.namespace, agentConfigs.namespace),
  eq(agentConfigVersions.agentConfigId, agentConfigs.id),
  eq(agentConfigVersions.version, agentConfigs.currentVersion),
);

const toAgentConfig = (row: AgentConfigRow): AgentConfig =>
  AgentConfig.parse({
    agentConfigId: row.id,
    inference: row.inference,
    systemPrompt: row.systemPrompt,
    namespace: row.namespace,
    ...unwrapped(row.metadata),
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    // SQL NULL is the absence of an archive, and absence stays absent.
    ...(row.archivedAt === null ? {} : { archivedAt: iso(row.archivedAt) }),
  });

const toEnvConfig = (row: typeof envConfigs.$inferSelect): EnvConfig =>
  EnvConfig.parse({
    envConfigId: row.id,
    network: row.network,
    packages: row.packages,
    namespace: row.namespace,
    ...unwrapped(row.metadata),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(row.archivedAt === null ? {} : { archivedAt: iso(row.archivedAt) }),
  });

const toSession = (row: typeof sessions.$inferSelect): Session =>
  Session.parse({
    sessionId: row.id,
    agentConfigId: row.agentConfigId,
    agentConfigVersion: row.agentConfigVersion,
    envConfigId: row.envConfigId,
    envConfigSnapshot: row.envConfigSnapshot,
    namespace: row.namespace,
    ...(row.sandboxId ? { sandboxId: row.sandboxId } : {}),
    ...unwrapped(row.metadata),
    createdAt: iso(row.createdAt),
    ...(row.archivedAt === null ? {} : { archivedAt: iso(row.archivedAt) }),
  });

export function createPgStore(db: StoreDb, opts: PgStoreOptions = {}): Store {
  const now = opts.now ?? (() => new Date());

  async function lockSession(tx: Tx, ref: SessionRef): Promise<{ archivedAt: Date | null }> {
    const [row] = await tx
      .select({ archivedAt: sessions.archivedAt })
      .from(sessions)
      .where(and(eq(sessions.id, ref.sessionId), eq(sessions.namespace, ref.namespace)))
      .for("update");
    if (row === undefined) throw new Error(`unknown session: ${ref.sessionId}`);
    return row;
  }

  async function lockActiveSession(tx: Tx, ref: SessionRef): Promise<void> {
    const row = await lockSession(tx, ref);
    if (row.archivedAt !== null) {
      throw ArchivedError.forSession(ref);
    }
  }

  /**
   * Every list's page predicate: everything strictly older than the
   * cursor row in (created_at, id) order — a row-value comparison, so the
   * tie-break is one comparison, not a hand-unrolled OR. The cursor is
   * looked up under the caller's `scope`, which makes a foreign id
   * unknown exactly like a nonexistent one. undefined = start at the
   * newest (and drizzle's and() drops it).
   */
  async function olderThanCursor(
    table: typeof agentConfigs | typeof envConfigs | typeof sessions,
    scope: SQL,
    after: string | undefined,
  ): Promise<SQL | undefined> {
    if (after === undefined) return undefined;
    const [cursor] = await db
      .select({ createdAt: table.createdAt })
      .from(table)
      .where(and(scope, eq(table.id, after)));
    if (!cursor) throw new Error(`unknown cursor: ${after}`);
    return sql`(${table.createdAt}, ${table.id}) < (${iso(cursor.createdAt)}::timestamptz, ${after})`;
  }

  /** Mint envelopes and append; caller must hold the session lock. */
  async function appendEntries(
    tx: Tx,
    ref: SessionRef,
    payloads: Array<Record<string, unknown>>,
  ): Promise<void> {
    const { namespace, sessionId } = ref;
    const [tail] = await tx
      .select({ max: sql<number>`coalesce(max(${sessionEntries.seq}), -1)` })
      .from(sessionEntries)
      .where(and(eq(sessionEntries.namespace, namespace), eq(sessionEntries.sessionId, sessionId)));
    let seq = Number(tail?.max ?? -1);
    for (const payload of payloads) {
      seq += 1;
      const entry = SessionEntry.parse({
        id: randomUUID(),
        seq,
        timestamp: iso(now()),
        ...payload,
      });
      await tx.insert(sessionEntries).values({ namespace, sessionId, seq, entry });
    }
  }

  return {
    async createAgentConfig(req) {
      const parsed = CreateAgentConfigRequest.parse(req);
      const id = randomUUID();
      const timestamp = now();
      await db.transaction(async (tx) => {
        await tx.insert(agentConfigs).values({
          id,
          namespace: parsed.namespace,
          currentVersion: 1,
          createdAt: timestamp,
        });
        await tx.insert(agentConfigVersions).values({
          namespace: parsed.namespace,
          agentConfigId: id,
          version: 1,
          inference: parsed.inference,
          systemPrompt: parsed.systemPrompt,
          metadata: wrap(parsed.metadata),
          updatedAt: timestamp,
        });
      });
      return AgentConfigRef.parse({ namespace: parsed.namespace, agentConfigId: id });
    },

    async getAgentConfig(ref) {
      const version =
        "version" in ref && ref.version !== undefined
          ? AgentConfigVersionRef.parse(ref).version
          : undefined;
      const parsed = AgentConfigRef.parse(ref);
      const requestedVersion =
        version !== undefined
          ? and(
              eq(agentConfigVersions.namespace, agentConfigs.namespace),
              eq(agentConfigVersions.agentConfigId, agentConfigs.id),
              eq(agentConfigVersions.version, version),
            )
          : currentAgentVersion;
      const [row] = await db
        .select(agentConfigColumns)
        .from(agentConfigs)
        .innerJoin(agentConfigVersions, requestedVersion)
        .where(
          and(
            eq(agentConfigs.id, parsed.agentConfigId),
            eq(agentConfigs.namespace, parsed.namespace),
          ),
        );
      return row === undefined ? undefined : toAgentConfig(row);
    },

    async updateAgentConfig(ref, req) {
      const { agentConfigId, namespace } = AgentConfigRef.parse(ref);
      const parsed = UpdateAgentConfigRequest.parse(req);
      const scope = and(eq(agentConfigs.id, agentConfigId), eq(agentConfigs.namespace, namespace));
      const target = and(
        scope,
        parsed.version === undefined ? undefined : eq(agentConfigs.currentVersion, parsed.version),
      );
      // Read-only means exactly this: an archived row matches no mutation.
      // The no-op branch keeps reading from `target` — archiving stops
      // writes, not reads.
      const mutable = and(target, isNull(agentConfigs.archivedAt));
      const hasMutation =
        parsed.inference !== undefined ||
        parsed.systemPrompt !== undefined ||
        parsed.metadata !== undefined;

      return db.transaction(async (tx) => {
        if (hasMutation) {
          // Incrementing the identity's pointer locks this config row. That
          // serializes unconditional writers and provides the optional CAS;
          // the new snapshot is inserted before the transaction commits.
          const [identity] = await tx
            .update(agentConfigs)
            .set({
              currentVersion: sql`${agentConfigs.currentVersion} + 1`,
            })
            .where(mutable)
            .returning({
              id: agentConfigs.id,
              namespace: agentConfigs.namespace,
              nextVersion: agentConfigs.currentVersion,
              createdAt: agentConfigs.createdAt,
            });
          if (identity !== undefined) {
            const [previous] = await tx
              .select({
                inference: agentConfigVersions.inference,
                systemPrompt: agentConfigVersions.systemPrompt,
                metadata: agentConfigVersions.metadata,
              })
              .from(agentConfigVersions)
              .where(
                and(
                  eq(agentConfigVersions.namespace, identity.namespace),
                  eq(agentConfigVersions.agentConfigId, identity.id),
                  eq(agentConfigVersions.version, identity.nextVersion - 1),
                ),
              );
            if (previous === undefined) {
              throw new Error(
                `agent config ${identity.id} has no version ${identity.nextVersion - 1}`,
              );
            }

            const version = {
              version: identity.nextVersion,
              inference: parsed.inference ?? previous.inference,
              systemPrompt: parsed.systemPrompt ?? previous.systemPrompt,
              metadata: parsed.metadata === undefined ? previous.metadata : wrap(parsed.metadata),
              updatedAt: now(),
            };
            await tx.insert(agentConfigVersions).values({
              namespace: identity.namespace,
              agentConfigId: identity.id,
              ...version,
            });
            return toAgentConfig({
              id: identity.id,
              namespace: identity.namespace,
              createdAt: identity.createdAt,
              archivedAt: null, // only an unarchived row can match `mutable`
              ...version,
            });
          }
        } else {
          const [row] = await tx
            .select(agentConfigColumns)
            .from(agentConfigs)
            .innerJoin(agentConfigVersions, currentAgentVersion)
            .where(target);
          if (row !== undefined) return toAgentConfig(row);
        }

        // No updated row means unknown/foreign, archived, or a failed version
        // precondition. Resolve under the same namespace so a foreign id never
        // leaks existence.
        const [current] = await tx
          .select({ version: agentConfigs.currentVersion, archivedAt: agentConfigs.archivedAt })
          .from(agentConfigs)
          .where(scope);
        if (current === undefined) return undefined;
        // Archived outranks the version verdict: it is terminal, so
        // "retry with the current version" would be a lie.
        if (current.archivedAt !== null) {
          throw ArchivedError.forAgentConfig({ namespace, agentConfigId });
        }
        if (parsed.version !== undefined) {
          throw new VersionConflictError(parsed.version, current.version);
        }
        throw new Error(`agent config ${agentConfigId} was not updated`);
      });
    },

    async archiveAgentConfig(ref) {
      const { agentConfigId, namespace } = AgentConfigRef.parse(ref);
      const scope = and(eq(agentConfigs.id, agentConfigId), eq(agentConfigs.namespace, namespace));
      return db.transaction(async (tx) => {
        // Idempotent by predicate rather than by read-then-write: only an
        // unarchived row is stamped, so a second archive — or a racing one —
        // keeps the first archivedAt. The state has no exit, so there is
        // nothing else a repeat could mean. This UPDATE is also the row lock
        // createSession's FOR SHARE waits on.
        await tx
          .update(agentConfigs)
          .set({ archivedAt: now() })
          .where(and(scope, isNull(agentConfigs.archivedAt)));
        const [row] = await tx
          .select(agentConfigColumns)
          .from(agentConfigs)
          .innerJoin(agentConfigVersions, currentAgentVersion)
          .where(scope);
        return row === undefined ? undefined : toAgentConfig(row);
      });
    },

    async listAgentConfigs(req) {
      const parsed = ListAgentConfigsRequest.parse(req);
      const scope = eq(agentConfigs.namespace, parsed.namespace);
      const page = await olderThanCursor(agentConfigs, scope, parsed.after);
      const rows = await db
        .select(agentConfigColumns)
        .from(agentConfigs)
        .innerJoin(agentConfigVersions, currentAgentVersion)
        .where(and(scope, page))
        .orderBy(desc(agentConfigs.createdAt), desc(agentConfigs.id))
        .limit(parsed.limit);
      return rows.map(toAgentConfig);
    },

    async createEnvConfig(req) {
      const parsed = CreateEnvConfigRequest.parse(req);
      const id = randomUUID();
      const timestamp = now();
      await db.insert(envConfigs).values({
        id,
        // Materialized at create — resolved decisions, not restatable defaults.
        namespace: parsed.namespace,
        network: parsed.network ?? { type: "unrestricted" },
        packages: parsed.packages ?? {},
        metadata: wrap(parsed.metadata),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return EnvConfigRef.parse({ namespace: parsed.namespace, envConfigId: id });
    },

    async getEnvConfig(ref) {
      const { envConfigId, namespace } = EnvConfigRef.parse(ref);
      const [row] = await db
        .select()
        .from(envConfigs)
        .where(and(eq(envConfigs.id, envConfigId), eq(envConfigs.namespace, namespace)));
      return row === undefined ? undefined : toEnvConfig(row);
    },

    async updateEnvConfig(ref, req) {
      const { envConfigId, namespace } = EnvConfigRef.parse(ref);
      const parsed = UpdateEnvConfigRequest.parse(req);
      const scope = and(eq(envConfigs.id, envConfigId), eq(envConfigs.namespace, namespace));
      const mutable = and(scope, isNull(envConfigs.archivedAt));
      const updates = {
        ...(parsed.network === undefined ? {} : { network: parsed.network }),
        ...(parsed.packages === undefined ? {} : { packages: parsed.packages }),
        ...(parsed.metadata === undefined ? {} : { metadata: wrap(parsed.metadata) }),
      };

      if (Object.keys(updates).length === 0) {
        const [row] = await db.select().from(envConfigs).where(scope);
        return row === undefined ? undefined : toEnvConfig(row);
      }

      const [row] = await db
        .update(envConfigs)
        .set({ ...updates, updatedAt: now() })
        .where(mutable)
        .returning();
      if (row !== undefined) return toEnvConfig(row);

      // An unmatched mutation is either unknown/foreign or archived. Rows
      // are never deleted, so this read resolves the verdict without a race;
      // archive is terminal and therefore always outranks the write.
      const [current] = await db
        .select({ archivedAt: envConfigs.archivedAt })
        .from(envConfigs)
        .where(scope);
      if (current === undefined) return undefined;
      if (current.archivedAt !== null) {
        throw ArchivedError.forEnvConfig({ namespace, envConfigId });
      }
      throw new Error(`env config ${envConfigId} was not updated`);
    },

    async archiveEnvConfig(ref) {
      const { envConfigId, namespace } = EnvConfigRef.parse(ref);
      const scope = and(eq(envConfigs.id, envConfigId), eq(envConfigs.namespace, namespace));
      return db.transaction(async (tx) => {
        // Only the first caller stamps the row. A repeat (or racing archive)
        // leaves the original time untouched, then reads the same terminal
        // state back. The UPDATE's row lock also serializes with the shared
        // lock held by createSession while it copies an active recipe.
        await tx
          .update(envConfigs)
          .set({ archivedAt: now() })
          .where(and(scope, isNull(envConfigs.archivedAt)));
        const [row] = await tx.select().from(envConfigs).where(scope);
        return row === undefined ? undefined : toEnvConfig(row);
      });
    },

    async listEnvConfigs(req) {
      const parsed = ListEnvConfigsRequest.parse(req);
      const scope = eq(envConfigs.namespace, parsed.namespace);
      const page = await olderThanCursor(envConfigs, scope, parsed.after);
      const rows = await db
        .select()
        .from(envConfigs)
        .where(and(scope, page))
        .orderBy(desc(envConfigs.createdAt), desc(envConfigs.id))
        .limit(parsed.limit);
      return rows.map(toEnvConfig);
    },

    async createSession(req) {
      const parsed = CreateSessionRequest.parse(req);
      const { namespace } = parsed;
      const requestedAgentVersion =
        parsed.agentConfigVersion === undefined
          ? currentAgentVersion
          : and(
              eq(agentConfigVersions.namespace, agentConfigs.namespace),
              eq(agentConfigVersions.agentConfigId, agentConfigs.id),
              eq(agentConfigVersions.version, parsed.agentConfigVersion),
            );
      const id = randomUUID();
      // Ids, namespaces, and version snapshots are immutable and configs are
      // never deleted, so existence and ownership cannot go stale; the FK
      // constraints remain as the backstop. The checks are namespace-scoped:
      // a session and its configs always share one namespace, and a foreign
      // config is "unknown" — indistinguishable from nonexistent, so nothing
      // leaks.
      //
      // Archive is the one terminal fact that CAN change under these checks,
      // so both config rows are read FOR SHARE and the locks held through the
      // insert. A concurrent archive waits behind this transaction or is
      // already committed and read here. "New sessions cannot reference an
      // archived config" is therefore structural, not a check/write window.
      //
      // The env recipe is the other mutable fact, and it is not merely
      // checked but COPIED (core/store.ts EnvConfigSnapshot): env configs
      // update in place, so a session that reloaded one could have its world
      // reshaped mid-run. The env lock also makes the copy a committed state
      // — a racing update waits behind this insert or is already in it — and
      // nothing reads env_configs for this session again. Agent → env is the
      // global lock order; neither archive path takes the other config row.
      await db.transaction(async (tx) => {
        const [agent] = await tx
          .select({ version: agentConfigVersions.version, archivedAt: agentConfigs.archivedAt })
          .from(agentConfigs)
          .innerJoin(agentConfigVersions, requestedAgentVersion)
          .where(
            and(eq(agentConfigs.id, parsed.agentConfigId), eq(agentConfigs.namespace, namespace)),
          )
          .for("share", { of: agentConfigs });
        if (!agent) throw new Error(`unknown agent config: ${parsed.agentConfigId}`);
        if (agent.archivedAt !== null) {
          throw ArchivedError.forAgentConfig({ namespace, agentConfigId: parsed.agentConfigId });
        }
        const [env] = await tx
          .select({
            network: envConfigs.network,
            packages: envConfigs.packages,
            archivedAt: envConfigs.archivedAt,
          })
          .from(envConfigs)
          .where(and(eq(envConfigs.id, parsed.envConfigId), eq(envConfigs.namespace, namespace)))
          .for("share", { of: envConfigs });
        if (!env) throw new Error(`unknown env config: ${parsed.envConfigId}`);
        if (env.archivedAt !== null) {
          throw ArchivedError.forEnvConfig({ namespace, envConfigId: parsed.envConfigId });
        }
        await tx.insert(sessions).values({
          id,
          agentConfigId: parsed.agentConfigId,
          agentConfigVersion: agent.version,
          envConfigId: parsed.envConfigId,
          envConfigSnapshot: EnvConfigSnapshot.parse({
            network: env.network,
            packages: env.packages,
          }),
          namespace,
          metadata: wrap(parsed.metadata),
          createdAt: now(),
        });
      });
      return SessionRef.parse({ namespace, sessionId: id });
    },

    async getSession(ref) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.namespace, namespace)));
      return row === undefined ? undefined : toSession(row);
    },

    async archiveSession(ref) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      const scope = and(eq(sessions.id, sessionId), eq(sessions.namespace, namespace));
      return db.transaction(async (tx) => {
        // Every transition that creates or resolves the one open item holds
        // this same row lock. Archive therefore observes one committed state:
        // idle and archivable, or running and refused — never a check/write
        // window in which intake can start a run behind it.
        const [current] = await tx.select().from(sessions).where(scope).for("update");
        if (current === undefined) return undefined;
        if (current.archivedAt !== null) return toSession(current);

        const [open] = await tx
          .select({ id: workItems.id })
          .from(workItems)
          .where(
            and(
              eq(workItems.namespace, namespace),
              eq(workItems.sessionId, sessionId),
              ne(workItems.status, "done"),
            ),
          )
          .limit(1);
        if (open !== undefined) throw new SessionNotIdleError({ namespace, sessionId });

        // A cancelled run parks its pending inputs for the next intake, and
        // archive guarantees there is no next one. Flush them into the log —
        // end_run's append-and-delete without the chained item — so a message
        // the api already accepted becomes history instead of a row nothing
        // can ever read. The session lock appendEntries requires is held.
        const parked = await tx
          .select()
          .from(pendingInputs)
          .where(
            and(eq(pendingInputs.namespace, namespace), eq(pendingInputs.sessionId, sessionId)),
          )
          .orderBy(asc(pendingInputs.ord));
        if (parked.length > 0) {
          await appendEntries(
            tx,
            { namespace, sessionId },
            parked.map((p) => ({ type: "message", message: p.message })),
          );
          await tx
            .delete(pendingInputs)
            .where(
              and(eq(pendingInputs.namespace, namespace), eq(pendingInputs.sessionId, sessionId)),
            );
        }

        const [archived] = await tx
          .update(sessions)
          .set({ archivedAt: now() })
          .where(and(scope, isNull(sessions.archivedAt)))
          .returning();
        if (archived === undefined) {
          throw new Error(`session ${sessionId} was not archived`);
        }
        return toSession(archived);
      });
    },

    async bindSandbox(ref, sandboxId, previous) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      const scope = and(eq(sessions.id, sessionId), eq(sessions.namespace, namespace));
      // The CAS: one UPDATE guarded by the expected current value — at
      // most one writer ever matches, whatever the interleaving.
      const expected =
        previous === undefined ? isNull(sessions.sandboxId) : eq(sessions.sandboxId, previous);
      const [bound] = await db
        .update(sessions)
        .set({ sandboxId })
        .where(and(scope, isNull(sessions.archivedAt), expected))
        .returning({ sandboxId: sessions.sandboxId });
      if (bound?.sandboxId) return bound.sandboxId;
      const [row] = await db
        .select({ sandboxId: sessions.sandboxId, archivedAt: sessions.archivedAt })
        .from(sessions)
        .where(scope);
      if (row === undefined) throw new Error(`unknown session: ${sessionId}`);
      if (row.archivedAt !== null) throw ArchivedError.forSession({ namespace, sessionId });
      if (!row.sandboxId) throw new Error(`unknown session: ${sessionId}`);
      return row.sandboxId;
    },

    async listSessions(req) {
      const parsed = ListSessionsRequest.parse(req);
      const scope = eq(sessions.namespace, parsed.namespace);
      const page = await olderThanCursor(sessions, scope, parsed.after);
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            scope,
            parsed.includeArchived === true ? undefined : isNull(sessions.archivedAt),
            page,
          ),
        )
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(parsed.limit);
      return rows.map(toSession);
    },

    async readEntries(ref, after) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      // A foreign ref reads exactly like an unknown session: empty.
      const rows = await db
        .select({ entry: sessionEntries.entry })
        .from(sessionEntries)
        .where(
          and(
            eq(sessionEntries.namespace, namespace),
            eq(sessionEntries.sessionId, sessionId),
            after === undefined ? undefined : gt(sessionEntries.seq, after),
          ),
        )
        .orderBy(asc(sessionEntries.seq));
      return rows.map((r) => SessionEntry.parse(r.entry));
    },

    async listItems(ref) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      const rows = await db
        .select()
        .from(workItems)
        .where(and(eq(workItems.sessionId, sessionId), eq(workItems.namespace, namespace)))
        .orderBy(asc(workItems.createdAt));
      return rows.map((r) =>
        WorkItem.parse({
          namespace: r.namespace,
          sessionId: r.sessionId,
          itemId: r.id,
          type: r.type,
          status: r.status,
          attempt: r.attempt,
        }),
      );
    },

    async pendingInputs(ref) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      // A foreign ref reads exactly like an unknown session: empty.
      const rows = await db
        .select({
          id: pendingInputs.id,
          sessionId: pendingInputs.sessionId,
          message: pendingInputs.message,
          arrivedAt: pendingInputs.arrivedAt,
        })
        .from(pendingInputs)
        .where(and(eq(pendingInputs.namespace, namespace), eq(pendingInputs.sessionId, sessionId)))
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
        // "Expired" iff leaseExpiresAt <= now. The leading conjunct is
        // redundant with the OR, but it matches the partial claim-scan
        // index's predicate verbatim, so the planner's proof that the
        // index applies is trivial rather than inferred.
        const claimable = and(
          ne(workItems.status, "done"),
          or(
            eq(workItems.status, "ready"),
            and(eq(workItems.status, "leased"), lte(workItems.leaseExpiresAt, t)),
          ),
        );
        const scope =
          req.session === undefined
            ? undefined
            : and(
                eq(workItems.sessionId, SessionRef.parse(req.session).sessionId),
                eq(workItems.namespace, req.session.namespace),
              );
        const [candidate] = await tx
          .select({
            id: workItems.id,
            namespace: workItems.namespace,
            sessionId: workItems.sessionId,
            type: workItems.type,
            attempt: workItems.attempt,
          })
          .from(workItems)
          .where(and(claimable, scope))
          .orderBy(asc(workItems.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!candidate) return undefined;
        const token = randomUUID(); // fresh per claim — never re-issued
        // The row is locked, so read-and-increment cannot race.
        const attempt = candidate.attempt + 1;
        await tx
          .update(workItems)
          .set({
            status: "leased",
            leaseToken: token,
            leaseMs: req.leaseMs,
            leaseExpiresAt: new Date(t.getTime() + req.leaseMs),
            attempt,
          })
          .where(
            // The full path, so the write rides the PK — the bare id has
            // no index of its own under the composite key.
            and(
              eq(workItems.namespace, candidate.namespace),
              eq(workItems.sessionId, candidate.sessionId),
              eq(workItems.id, candidate.id),
            ),
          );
        return {
          item: WorkItem.parse({
            namespace: candidate.namespace,
            sessionId: candidate.sessionId,
            itemId: candidate.id,
            type: candidate.type,
            status: "leased",
            attempt,
          }),
          token,
        };
      });
    },

    async heartbeat(ref, token) {
      const { namespace, sessionId, itemId } = WorkItemRef.parse(ref);
      const t = now();
      const rows = await db
        .update(workItems)
        .set({
          leaseExpiresAt: sql`${iso(t)}::timestamptz + ${workItems.leaseMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            // The full path is the address: a mismatched parent or a
            // foreign namespace misses exactly like an unknown item.
            eq(workItems.id, itemId),
            eq(workItems.sessionId, sessionId),
            eq(workItems.namespace, namespace),
            eq(workItems.leaseToken, token),
            eq(workItems.status, "leased"),
            gt(workItems.leaseExpiresAt, t), // expired = lost, even if unclaimed
          ),
        )
        .returning({ id: workItems.id });
      return rows.length > 0;
    },

    async requestCancel(ref) {
      const parsed = SessionRef.parse(ref);
      await db.transaction(async (tx) => {
        await lockActiveSession(tx, parsed);
        await appendEntries(tx, parsed, [{ type: "control", control: "cancel" }]);
      });
    },

    async intake(ref, message) {
      const { namespace, sessionId } = SessionRef.parse(ref);
      const msg = UserMessage.parse(message);
      return db.transaction(async (tx) => {
        await lockActiveSession(tx, { namespace, sessionId }); // the race referee
        const open = await tx
          .select({ id: workItems.id })
          .from(workItems)
          .where(
            and(
              eq(workItems.namespace, namespace),
              eq(workItems.sessionId, sessionId),
              ne(workItems.status, "done"),
            ),
          )
          .limit(1);
        if (open.length > 0) {
          const inputId = randomUUID();
          await tx
            .insert(pendingInputs)
            .values({ namespace, sessionId, id: inputId, message: msg, arrivedAt: now() });
          return IntakeResult.parse({ kind: "queued", inputId });
        }
        await appendEntries(tx, { namespace, sessionId }, [{ type: "message", message: msg }]);
        const itemId = randomUUID();
        await tx.insert(workItems).values({
          id: itemId,
          namespace,
          sessionId,
          type: "inference",
          status: "ready",
          createdAt: now(),
        });
        return IntakeResult.parse({ kind: "started", itemId });
      });
    },

    async commitStep(req: CommitStepRequest) {
      const { namespace, sessionId, itemId } = WorkItemRef.parse(req.itemRef);
      const messages = req.append.map((m) => AgentMessage.parse(m));
      await db.transaction(async (tx) => {
        const [item] = await tx
          .select()
          .from(workItems)
          .where(
            // The full path is the address: a mismatched parent session or
            // a foreign namespace is unknown, exactly like a missing row.
            and(
              eq(workItems.id, itemId),
              eq(workItems.sessionId, sessionId),
              eq(workItems.namespace, namespace),
            ),
          )
          .for("update");
        if (!item) throw new Error(`commitStep: unknown item ${itemId}`);
        if (item.status === "done") {
          if (item.leaseToken !== req.token)
            throw new FencedError(
              `commitStep: fenced — ${itemId} was finished under another claim`,
            );
          return; // idempotent re-commit (crash-after-commit recovery)
        }
        if (item.status !== "leased" || item.leaseToken !== req.token)
          throw new FencedError(`commitStep: fenced — stale token for ${itemId}`);
        if (item.leaseExpiresAt === null || item.leaseExpiresAt.getTime() <= now().getTime())
          throw new FencedError(`commitStep: fenced — ${itemId}'s lease expired before commit`);
        await lockSession(tx, { namespace, sessionId });
        await appendEntries(
          tx,
          { namespace, sessionId },
          messages.map((m) => ({ type: "message", message: m })),
        );
        if (req.consumeInputs !== undefined && req.consumeInputs.length > 0) {
          const drained = await tx
            .delete(pendingInputs)
            .where(
              and(
                eq(pendingInputs.namespace, namespace),
                eq(pendingInputs.sessionId, sessionId),
                inArray(pendingInputs.id, req.consumeInputs),
              ),
            )
            .returning({ id: pendingInputs.id });
          if (drained.length !== req.consumeInputs.length)
            throw new Error("commitStep: consumeInputs names an unknown or already-consumed input");
        }
        await tx
          .update(workItems)
          .set({ status: "done" })
          .where(
            and(
              eq(workItems.namespace, item.namespace),
              eq(workItems.sessionId, item.sessionId),
              eq(workItems.id, item.id),
            ),
          );
        if (req.next.kind !== "end_run") {
          await tx.insert(workItems).values({
            id: randomUUID(),
            namespace: item.namespace,
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
          .where(
            and(eq(pendingInputs.namespace, namespace), eq(pendingInputs.sessionId, sessionId)),
          )
          .orderBy(asc(pendingInputs.ord));
        if (parked.length === 0) return;
        await appendEntries(
          tx,
          { namespace, sessionId },
          parked.map((p) => ({ type: "message", message: p.message })),
        );
        await tx.delete(pendingInputs).where(
          and(
            eq(pendingInputs.namespace, namespace),
            eq(pendingInputs.sessionId, sessionId),
            inArray(
              pendingInputs.id,
              parked.map((p) => p.id),
            ),
          ),
        );
        await tx.insert(workItems).values({
          id: randomUUID(),
          namespace: item.namespace,
          sessionId: item.sessionId,
          type: "inference",
          status: "ready",
          createdAt: now(),
        });
      });
    },
  };
}
