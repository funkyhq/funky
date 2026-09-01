// The pg adapter's physical shape. Drizzle types never leave this package:
// `core` types are the only currency crossing the Store port.
//
// Two conventions the domain contract imposes on the SQL:
// - Absence vs JSON null: `metadata` columns store the wrapped form
//   `{ v: <JsonValue> }`; SQL NULL means the caller stored nothing. The
//   wrapper exists because drivers parse jsonb 'null' and SQL NULL to the
//   same JS null — without it, "no metadata" and "metadata: null" would
//   collapse into one spelling on read.
// - Envelope truth lives in the row's domain form: `session_entries.entry`
//   is the full SessionEntry (id, seq, timestamp, payload); the bare `seq`
//   column exists only for the primary key and ordered reads.

import { sql } from "drizzle-orm";
import {
  bigserial,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  EnvConfigSnapshot,
  InferenceConfig,
  JsonValue,
  NetworkPolicy,
  Packages,
  SessionEntry,
  UserMessage,
} from "@funky/core";

/** SQL NULL = absent; `{ v }` = present (v may be JSON null). */
export type WrappedJson = { v: JsonValue };

// Every table carries namespace and is keyed by its full path, namespace
// leading — point reads arrive ref-scoped, and namespace is the key the
// future PARTITION BY needs on every table. Children copy it from their
// parent, made structural by composite FKs; no bare-id UNIQUE exists
// anywhere (see migration.sql).
export const agentConfigs = pgTable(
  "agent_configs",
  {
    // The tenancy boundary (core/store.ts); the caller supplies it on
    // every create — no SQL DEFAULT, no adapter resolution.
    namespace: text("namespace").notNull(),
    id: text("id").notNull(),
    // Pointer to the latest immutable snapshot.
    currentVersion: integer("current_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // The terminal state, set once: null = active. Archiving lives on the
    // identity, not on a version — it retires the config, not a snapshot.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.namespace, t.id] })],
);

// Immutable snapshots of every agent config version. The PK is the
// AgentConfigVersionRef verbatim.
export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    namespace: text("namespace").notNull(),
    agentConfigId: text("agent_config_id").notNull(),
    version: integer("version").notNull(),
    inference: jsonb("inference").$type<InferenceConfig>().notNull(),
    systemPrompt: text("system_prompt").notNull(),
    metadata: jsonb("metadata").$type<WrappedJson>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.agentConfigId, t.version] }),
    foreignKey({
      columns: [t.namespace, t.agentConfigId],
      foreignColumns: [agentConfigs.namespace, agentConfigs.id],
    }),
  ],
);

export const envConfigs = pgTable(
  "env_configs",
  {
    namespace: text("namespace").notNull(),
    id: text("id").notNull(),
    // Materialized at create — never SQL NULL (resolved decisions, not defaults).
    network: jsonb("network").$type<NetworkPolicy>().notNull(),
    packages: jsonb("packages").$type<Packages>().notNull(),
    metadata: jsonb("metadata").$type<WrappedJson>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.namespace, t.id] })],
);

export const sessions = pgTable(
  "sessions",
  {
    namespace: text("namespace").notNull(),
    id: text("id").notNull(),
    agentConfigId: text("agent_config_id").notNull(),
    // Resolved from the agent's latest version at session creation. The
    // composite FK below makes every session's behavior snapshot durable.
    agentConfigVersion: integer("agent_config_version").notNull(),
    envConfigId: text("env_config_id").notNull(),
    // The env recipe resolved at create (core/store.ts EnvConfigSnapshot).
    // Provisioning reads this, never the mutable env_configs row.
    envConfigSnapshot: jsonb("env_config_snapshot").$type<EnvConfigSnapshot>().notNull(),
    // The session's one workspace; null until bindSandbox registers it.
    sandboxId: text("sandbox_id"),
    metadata: jsonb("metadata").$type<WrappedJson>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.id] }),
    // Same-namespace, structural, on both references: the pinned version
    // and the env recipe must live in the session's own namespace.
    foreignKey({
      columns: [t.namespace, t.agentConfigId, t.agentConfigVersion],
      foreignColumns: [
        agentConfigVersions.namespace,
        agentConfigVersions.agentConfigId,
        agentConfigVersions.version,
      ],
    }),
    foreignKey({
      columns: [t.namespace, t.envConfigId],
      foreignColumns: [envConfigs.namespace, envConfigs.id],
    }),
    // The list scan's index (pg.ts listSessions). The PK's second column
    // is a random id, so it cannot order by time: without this, a page
    // reads and sorts the namespace's whole history to return one
    // screenful and the keyset cursor buys nothing. Sessions is the one
    // listed table that grows without bound — the configs beside it are
    // a small fixed set, which is why only this one carries the index.
    // Ascending by choice: a leading equality on namespace lets the
    // newest-first order walk it backwards, so one index serves both.
    index("sessions_list_scan").on(t.namespace, t.createdAt, t.id),
  ],
);

export const sessionEntries = pgTable(
  "session_entries",
  {
    namespace: text("namespace").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    entry: jsonb("entry").$type<SessionEntry>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.sessionId, t.seq] }),
    foreignKey({
      columns: [t.namespace, t.sessionId],
      foreignColumns: [sessions.namespace, sessions.id],
    }),
  ],
);

export const workItems = pgTable(
  "work_items",
  {
    // Copied from the session at mint (core/store.ts): the claim is the
    // one read that starts from nothing, so the claimed row itself must
    // hand the driver the scope its later refs carry. The composite FK
    // below makes the copy structural — it can never diverge.
    namespace: text("namespace").notNull(),
    sessionId: text("session_id").notNull(),
    id: text("id").notNull(),
    type: text("type").notNull(), // ItemType
    status: text("status").notNull(), // ItemStatus
    // Lease bookkeeping — adapter internals, not port vocabulary.
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseMs: integer("lease_ms"),
    // Times claimed; the driver's at-most-once guard for tool side
    // effects keys on attempt > 1.
    attempt: integer("attempt").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.sessionId, t.id] }),
    foreignKey({
      columns: [t.namespace, t.sessionId],
      foreignColumns: [sessions.namespace, sessions.id],
    }),
    // The one-open-item invariant, enforced declaratively: at most one
    // non-done item per session. This index IS "busy". Carries the
    // partition key like every unique index here.
    uniqueIndex("work_items_one_open_per_session")
      .on(t.namespace, t.sessionId)
      .where(sql`${t.status} <> 'done'`),
    // Partial: only live rows, in arrival order — the claim poll is one
    // ordered walk, and the unbounded done majority never enters. The
    // claim query repeats the predicate verbatim (see pg.ts claimItem).
    // Deliberately namespace-free: the claim scan is cross-tenant.
    index("work_items_claim_scan")
      .on(t.createdAt)
      .where(sql`${t.status} <> 'done'`),
  ],
);

export const pendingInputs = pgTable(
  "pending_inputs",
  {
    namespace: text("namespace").notNull(),
    sessionId: text("session_id").notNull(),
    // The port-level name — what consumeInputs targets. In the PK, so an
    // input id is unique within its session by construction.
    id: text("id").notNull(),
    // Drain order — arrival order even under equal timestamps. A global
    // bigserial, gappy and never per-session dense (seq is the
    // hand-minted dense one): plumbing, not contract. Reads scan the PK
    // prefix and order by it.
    ord: bigserial("ord", { mode: "number" }),
    message: jsonb("message").$type<UserMessage>().notNull(),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.sessionId, t.id] }),
    foreignKey({
      columns: [t.namespace, t.sessionId],
      foreignColumns: [sessions.namespace, sessions.id],
    }),
  ],
);
