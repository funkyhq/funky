// packages/db/schema/harness-transcript.ts — the harness transcript store.
//
// One row per agent-SDK transcript entry (JSONL line), persisted VERBATIM as an
// opaque blob — see packages/ports/harness/DESIGN.md §8. This table is the backing
// store an agent SDK's SessionStore adapter mirrors into (Claude Code is the first
// driver); it is NOT the event log. The event log (session_events) remains the API/SSE
// source of truth; this table is what lets a stateless worker rehydrate the closed
// harness binary's own session format on resume. Column names are SDK-neutral so a
// second driver can reuse the table unchanged.
//
// Writes are FENCED: the adapter inserts with a guard against sessions.harness_attempt
// (see DrizzleSessionStore), so a zombie worker's batches are rejected instead of
// interleaving with the current attempt's. Because fenced writes never land, the
// max-ord main-transcript row IS the resume tip for a session.

import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./sessions";

export const harnessTranscriptEntries = pgTable(
  "harness_transcript_entries",
  {
    /** SDK SessionKey.projectKey — sanitized cwd; deterministic per Funky session. */
    projectKey: text("project_key").notNull(),
    /** SDK SessionKey.sessionId — the agent SDK's own session id, e.g. Claude Code's
     *  session UUID (NOT the Funky session id). */
    sdkSessionId: text("sdk_session_id").notNull(),
    /** '' = main transcript; e.g. 'subagents/agent-<id>' for subagent transcripts. */
    subpath: text("subpath").notNull().default(""),
    /** Append order within a key; load() replays ORDER BY ord. */
    ord: bigserial("ord", { mode: "number" }).primaryKey(),
    /** Dedupe key — mirror retries may re-deliver a batch. Null for uuid-less entries. */
    entryUuid: text("entry_uuid"),
    /** The SessionStoreEntry, verbatim. Opaque: never interpreted, only round-tripped. */
    entry: jsonb("entry").$type<Record<string, unknown>>().notNull(),

    namespace: text("namespace").notNull(),
    funkySessionId: uuid("funky_session_id")
      .notNull()
      .references(() => sessions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // load() path: one key's entries in append order.
    index("harness_entries_key").on(t.projectKey, t.sdkSessionId, t.subpath, t.ord),
    // Idempotent append: a re-delivered entry hits this and is skipped, never duplicated.
    uniqueIndex("harness_entries_dedupe")
      .on(t.sdkSessionId, t.subpath, t.entryUuid)
      .where(sql`${t.entryUuid} is not null`),
    // Lineage tip + GC by Funky session.
    index("harness_entries_session").on(t.funkySessionId, t.ord),
  ],
);
