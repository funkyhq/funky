import { z } from "zod";
import { AgentMessage, JsonValue } from "./messages";

/**
 * The session log's row type — the envelope around the payloads.
 *
 * Messages are what the model sees; entries are what the store owns. The
 * store mints the envelope (id, seq, timestamp) inside its transaction —
 * callers hand it payloads, never entries. sessionId is not repeated per
 * row: every read and every wire stream is already session-scoped.
 *
 * Evolution rules match messages.ts: this is persistence format. Adding an
 * entry type is backward compatible (old sessions parse fine); removing or
 * renaming one is a migration. App extensibility lives in `custom` entries
 * — the message union stays closed.
 */

const EntryBase = {
  id: z.string(),
  // Per-session ordering; assigned by the store, gapless within a session.
  seq: z.number().int().nonnegative(),
  // Attribution, not ownership: entries belong to the session; null for
  // entries written outside any run.
  runId: z.string().nullable(),
  timestamp: z.iso.datetime(),
};

export const MessageEntry = z.object({
  ...EntryBase,
  type: z.literal("message"),
  message: AgentMessage,
});
export type MessageEntry = z.infer<typeof MessageEntry>;

// App-defined payload riding in the log; invisible to the model. UIs and
// services filter by namespace; buildContext skips these entirely.
export const CustomEntry = z.object({
  ...EntryBase,
  type: z.literal("custom"),
  namespace: z.string(),
  data: JsonValue,
});
export type CustomEntry = z.infer<typeof CustomEntry>;

// Reserved: schema now, semantics later. Will mark entries with
// seq <= upToSeq as superseded, with `summary` rendered into context as
// user-role text. buildContext treats it as a no-op until then.
export const CompactionEntry = z.object({
  ...EntryBase,
  type: z.literal("compaction"),
  summary: z.string(),
  upToSeq: z.number().int().nonnegative(),
});
export type CompactionEntry = z.infer<typeof CompactionEntry>;

export const SessionEntry = z.discriminatedUnion("type", [
  MessageEntry,
  CustomEntry,
  CompactionEntry,
]);
export type SessionEntry = z.infer<typeof SessionEntry>;
