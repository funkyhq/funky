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
  inference: jsonb("inference").$type<InferenceConfig>().notNull(),
  systemPrompt: text("system_prompt").notNull(),
  metadata: jsonb("metadata").$type<WrappedJson>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const envConfigs = pgTable("env_configs", {
  id: text("id").primaryKey(),
  // Materialized at create — never SQL NULL (resolved decisions, not defaults).
  network: jsonb("network").$type<NetworkPolicy>().notNull(),
  packages: jsonb("packages").$type<Packages>().notNull(),
  metadata: jsonb("metadata").$type<WrappedJson>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  agentConfigId: text("agent_config_id")
    .notNull()
    .references(() => agentConfigs.id),
  envConfigId: text("env_config_id")
    .notNull()
    .references(() => envConfigs.id),
  metadata: jsonb("metadata").$type<WrappedJson>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

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
