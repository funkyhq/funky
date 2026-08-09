import { z } from "zod";

/**
 * The message vocabulary of the harness — the provider-facing payload types.
 *
 * These schemas are the persistence format: entries wrap these messages and
 * stored sessions must parse forever. Evolution rules:
 * - adding an optional field is backward compatible; removing or renaming
 *   one is a migration — fields must earn their way in
 * - the union stays closed (user | assistant | toolResult); app
 *   extensibility lives in entries, never here
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

// --- content parts ---

export const TextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextContent = z.infer<typeof TextContent>;

export const ImageContent = z.object({
  type: z.literal("image"),
  data: z.string(), // base64
  mimeType: z.string(), // e.g. "image/png"
});
export type ImageContent = z.infer<typeof ImageContent>;

export const ThinkingContent = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  // Anthropic extended thinking: the signature must round-trip to the API
  // for multi-turn continuity. When `redacted` is true, `thinking` is empty
  // and the opaque encrypted payload rides in `thinkingSignature`.
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
export type ThinkingContent = z.infer<typeof ThinkingContent>;

export const ToolCall = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), JsonValue),
});
export type ToolCall = z.infer<typeof ToolCall>;

// --- usage and stop reasons ---

// Token counts only. Cost is computed at metering/display time from pricing
// tables — never persisted, so price changes don't invalidate stored sessions.
export const Usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  // Subset of `output`; present only when the provider reports a breakdown.
  reasoning: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const StopReason = z.enum([
  // provider outcomes
  "end_turn",
  "tool_use",
  "max_tokens",
  // harness outcomes — such messages are kept in the log but filtered from
  // model context by buildContext
  "aborted",
  "error",
]);
export type StopReason = z.infer<typeof StopReason>;

// --- messages ---

export const UserMessage = z.object({
  role: z.literal("user"),
  // Always an array; plain strings are normalized at intake.
  content: z.array(z.discriminatedUnion("type", [TextContent, ImageContent])),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.array(z.discriminatedUnion("type", [TextContent, ThinkingContent, ToolCall])),
  model: z.string(),
  stopReason: StopReason,
  // Absent when the stream died before the provider reported usage.
  usage: Usage.optional(),
  // Set when stopReason === "error".
  errorMessage: z.string().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const ToolResultMessage = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.discriminatedUnion("type", [TextContent, ImageContent])),
  // Tool-specific structured payload for UI rendering; never sent to the model.
  details: JsonValue.optional(),
  isError: z.boolean(),
});
export type ToolResultMessage = z.infer<typeof ToolResultMessage>;

export const AgentMessage = z.discriminatedUnion("role", [
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;
