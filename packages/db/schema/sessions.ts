// packages/db/schema/sessions.ts — Phase A: sessions, the event log, the turn queue.
//
// The composite PK on session_events (session_id, seq) IS the conditional append:
// a worker inserts with a caller-computed seq; losing a race = PK violation = ErrConflict.
// No other mechanism exists or is needed.

import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentConfigs } from "./configs";
import { envConfigs, type NetworkPolicy } from "./envs"; // ⚠ adjust if the env iteration named this file differently

/** Snapshot captured at sandbox provision; reboots rebuild from THIS, never from the
 *  (mutable) env config. template_id is driver-specific (e.g. E2B template). */
export type ResolvedEnv = {
  template_id?: string;
  network: NetworkPolicy;
};

export type SessionStatus = "provisioning" | "ready" | "failed" | "archived";

/** Committed harness state — opaque outside its own driver, like SandboxHandle.
 *  For claude-code: { driver: "claude-code", sdk_session_id, project_key }.
 *  A cache/audit field: the authoritative resume tip is derived from
 *  harness_transcript_entries (see packages/ports/harness/DESIGN.md §5.2). */
export type HarnessState = { driver: string } & Record<string, unknown>;

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(), // client-suppliable → idempotent create
    namespace: text("namespace").notNull(),

    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfigs.id),
    agentVersion: integer("agent_version").notNull(),

    envConfigId: uuid("env_config_id")
      .notNull()
      .references(() => envConfigs.id),
    resolvedEnv: jsonb("resolved_env").$type<ResolvedEnv>(),
    sandboxHandle: jsonb("sandbox_handle").$type<Record<string, unknown>>(),

    // Harness sessions only (agent version runtime = claude-code). harness_attempt is
    // the WRITE FENCE: the current attempt's token; the transcript store's guarded
    // INSERT checks it, so a zombie worker's mirror batches bounce instead of
    // interleaving. Set transactionally with the harness_attempt_started event.
    harnessAttempt: text("harness_attempt"),
    harnessState: jsonb("harness_state").$type<HarnessState>(),

    status: text("status").$type<SessionStatus>().notNull().default("provisioning"),
    title: text("title"),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("sessions_ns").on(t.namespace)],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    namespace: text("namespace").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export type JobKind = "turn" | "provision";
export type JobState = "queued" | "running" | "done" | "dead";

export const turnJobs = pgTable(
  "turn_jobs",
  {
    id: uuid("id").primaryKey(),
    namespace: text("namespace").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    kind: text("kind").$type<JobKind>().notNull().default("turn"),
    state: text("state").$type<JobState>().notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("turn_jobs_queued").on(t.runAt).where(sql`${t.state} = 'queued'`),
    index("turn_jobs_active_session")
      .on(t.sessionId)
      .where(sql`${t.state} IN ('queued', 'running')`),
  ],
);
