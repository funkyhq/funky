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

// The harness control plane riding in the log. requestCancel appends one;
// workers check for it behind the tail at boundaries. Seq order scopes it
// precisely: a cancel landing before the run's terminal message addresses
// that run; landing after it, the cancel addresses a run that no longer
// exists and is ignored — the log's total order, not flag timing, decides.
// Never model context: buildContext skips it.
export const ControlEntry = z.object({
  ...EntryBase,
  type: z.literal("control"),
  control: z.literal("cancel"),
});
export type ControlEntry = z.infer<typeof ControlEntry>;

export const SessionEntry = z.discriminatedUnion("type", [
  MessageEntry,
  CustomEntry,
  CompactionEntry,
  ControlEntry,
]);
export type SessionEntry = z.infer<typeof SessionEntry>;
