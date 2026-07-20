// packages/sessions/src/events.ts — Phase A: the event model.
//
// The DB stores {type: text, payload: jsonb} untyped; THIS file is the contract.
// Every append goes through makeEvent(); every read through parseEvent().
//
// Two shapes are deliberately future-proofed (log format must never break):
//  - message content is ContentBlock[] (multimodal becomes an additive block kind)
//  - assistant tool calls are an ARRAY, runtime-capped at 1 for v1 (parallel tool
//    use later = lift the cap, no migration)

import { z } from "zod";

// ---------------------------------------------------------------------------
// Content blocks — text today; image/document/... are additive variants.
// ---------------------------------------------------------------------------
export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(100_000),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/** Convenience: wrap a plain string as content blocks. */
export function textContent(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

/** Convenience: flatten blocks to plain text (for LLM context building, logs). */
export function plainText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

// ---------------------------------------------------------------------------
// Tool calls — v1 has exactly one tool: run a shell command in the sandbox.
// A discriminated union from day one so file/browser/etc. tools are additive.
// ---------------------------------------------------------------------------
export const toolCallSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exec"),
    cmd: z.string().min(1),
    timeout_ms: z.number().int().min(1).max(600_000).optional(),
  }),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;

// ---------------------------------------------------------------------------
// Payload schema per event type
// ---------------------------------------------------------------------------
export const eventPayloadSchemas = {
  user_message: z.object({
    content: z.array(contentBlockSchema).min(1).max(50),
  }),

  assistant_message: z.object({
    content: z.array(contentBlockSchema).max(50), // may be [] when going straight to a tool
    // v1 CAP: at most one call per message. The log format supports N — lifting the
    // cap for parallel tool use is a runtime change, not a schema migration.
    tool_calls: z.array(toolCallSchema).max(1).default([]),
    usage: z
      .object({ input_tokens: z.number().int(), output_tokens: z.number().int() })
      .optional(),
  }),

  tool_result: z.object({
    idem_key: z.string(), // pairs result → its call; see idemKeyFor()
    output: z.string().max(200_000), // exec output is text; truncate in the executor
    exit_code: z.number().int(),
    truncated: z.boolean().default(false),
  }),

  turn_completed: z.object({}),

  turn_failed: z.object({
    error_class: z.enum([
      "LLM_PERMANENT",
      "SANDBOX_FATAL",
      "BUDGET",
      "HARNESS", // permanent harness failure (bad config, auth) — harness sessions only
      "INTERNAL",
    ]), // transient classes never reach the log — they retry
    message: z.string(),
  }),

  session_provisioned: z.object({}),

  // Harness sessions only (bookkeeping; skipped by buildContext). Appending this at
  // lastSeq+1 IS acquiring the turn attempt: losing the seq race means another worker
  // owns the turn. `attempt` is the write-fence token mirrored onto the session row
  // (sessions.harness_attempt) in the same transaction. See ports/harness/DESIGN.md §5.
  harness_attempt_started: z.object({
    attempt: z.string().min(1),
    /** The Claude session id this attempt resumes from; null on a session's first turn. */
    resumed_from: z.string().nullable(),
  }),
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;

// ---------------------------------------------------------------------------
// The envelope — what the reducer and the SSE stream consume
// ---------------------------------------------------------------------------
export type SessionEvent<T extends EventType = EventType> = {
  sessionId: string;
  seq: number; // dense, from 1; SSE `id:` and cursor everywhere
  namespace: string;
  type: T;
  payload: EventPayload<T>;
  createdAt: Date;
};

/** Construct + validate before append. Throws ZodError on programmer error. */
export function makeEvent<T extends EventType>(
  base: { sessionId: string; namespace: string; seq: number },
  type: T,
  payload: EventPayload<T>,
): Omit<SessionEvent<T>, "createdAt"> {
  return { ...base, type, payload: eventPayloadSchemas[type].parse(payload) as EventPayload<T> };
}

/** Validate a DB row into a typed event. Parsing on read means a bad deploy can't
 *  feed the reducer garbage silently. */
export function parseEvent(row: {
  sessionId: string;
  seq: number;
  namespace: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}): SessionEvent {
  const type = row.type as EventType;
  const schema = eventPayloadSchemas[type];
  if (!schema) throw new Error(`unknown event type in log: ${row.type} (seq ${row.seq})`);
  return {
    sessionId: row.sessionId,
    seq: row.seq,
    namespace: row.namespace,
    type,
    payload: schema.parse(row.payload),
    createdAt: row.createdAt,
  } as SessionEvent;
}

/** Idempotency key for a tool call, derived from LOG POSITION — a resumed worker
 *  regenerates the identical key. Never replace with a random uuid.
 *  `index` = position within the assistant_message's tool_calls (always 0 in v1;
 *  present now so parallel tool use never changes the key format). */
export function idemKeyFor(sessionId: string, assistantSeq: number, index = 0): string {
  return `${sessionId}:${assistantSeq}:${index}`;
}
