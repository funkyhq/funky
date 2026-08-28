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
  InferenceConfig,
  JsonValue,
  NetworkPolicy,
  Packages,
  SessionEntry,
  UserMessage,
} from "@funky/core";

/** SQL NULL = absent; `{ v }` = present (v may be JSON null). */
export type WrappedJson = { v: JsonValue };

export const agentConfigs = pgTable("agent_configs", {
  id: text("id").primaryKey(),
  // The tenancy boundary (core/store.ts) — the adapter materializes the
  // default; no SQL DEFAULT, so the resolution lives in exactly one place.
  namespace: text("namespace").notNull(),
  // Pointer to the latest immutable snapshot.
  currentVersion: integer("current_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// Immutable snapshots of every agent config version.
export const agentConfigVersions = pgTable(
  "agent_config_versions",
  {
    agentConfigId: text("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id),
    version: integer("version").notNull(),
    inference: jsonb("inference").$type<InferenceConfig>().notNull(),
    systemPrompt: text("system_prompt").notNull(),
    metadata: jsonb("metadata").$type<WrappedJson>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentConfigId, t.version] })],
);

export const envConfigs = pgTable("env_configs", {
  id: text("id").primaryKey(),
  // Materialized at create — never SQL NULL (resolved decisions, not defaults).
  network: jsonb("network").$type<NetworkPolicy>().notNull(),
  packages: jsonb("packages").$type<Packages>().notNull(),
  namespace: text("namespace").notNull(),
  metadata: jsonb("metadata").$type<WrappedJson>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentConfigId: text("agent_config_id").notNull(),
    // Resolved from the agent's latest version at session creation. The
    // composite FK below makes every session's behavior snapshot durable.
    agentConfigVersion: integer("agent_config_version").notNull(),
    envConfigId: text("env_config_id")
      .notNull()
      .references(() => envConfigs.id),
    namespace: text("namespace").notNull(),
    // The session's one workspace; null until bindSandbox registers it.
    sandboxId: text("sandbox_id"),
    metadata: jsonb("metadata").$type<WrappedJson>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.agentConfigId, t.agentConfigVersion],
      foreignColumns: [agentConfigVersions.agentConfigId, agentConfigVersions.version],
    }),
  ],
);

export const sessionEntries = pgTable(
  "session_entries",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: integer("seq").notNull(),
    entry: jsonb("entry").$type<SessionEntry>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
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
    // The one-open-item invariant, enforced declaratively: at most one
    // non-done item per session. This index IS "busy".
    uniqueIndex("work_items_one_open_per_session")
      .on(t.sessionId)
      .where(sql`${t.status} <> 'done'`),
    index("work_items_claim_scan").on(t.status, t.createdAt),
  ],
);

export const pendingInputs = pgTable(
  "pending_inputs",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    // Drain order — arrival order even under equal timestamps. The key
    // shape mimics session_entries, but ord is plumbing, not contract:
    // a global bigserial, gappy and never per-session dense (seq is the
    // hand-minted dense one). The composite PK is the access path for
    // the session-scoped reads that are this table's only queries.
    ord: bigserial("ord", { mode: "number" }),
    // The port-level name — what consumeInputs targets.
    id: text("id").notNull().unique(),
    message: jsonb("message").$type<UserMessage>().notNull(),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.ord] })],
);
