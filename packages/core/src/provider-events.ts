import type { ProviderMetadata, StopReason, Usage } from "./messages";

/**
 * Streaming increments from a model provider.
 *
 * The taxonomy follows pi's `AssistantMessageEvent` (per-kind start/delta/end
 * tags, `contentIndex` addressing the part being generated) — but events are
 * pure increments: nothing ever carries an assembled or partial
 * `AssistantMessage`. The engine owns the fold — accumulating parts, parsing
 * tool-call arguments at `toolcall_end`, synthesizing aborted/error outcomes —
 * so the "exactly one message per inference" invariant lives in one place
 * instead of in every provider adapter. Adapters are dumb translators: vendor
 * SDK event in, `ProviderEvent` out, exceptions propagate (there is no error
 * event).
 *
 * Ephemeral (never persisted, never parsed from untrusted input), so plain
 * types rather than zod schemas.
 */

/** Outcomes a provider can report. `aborted`/`error` are assigned by the engine, never by a provider. */
export type ProviderStopReason = Extract<StopReason, "end_turn" | "tool_use" | "max_tokens">;

/**
 * The `*_end` events may carry the vendor's continuity data for the
 * finished part (`ProviderMetadata` in messages): the adapter merges
 * whatever the vendor attached across the part's chunks, the fold
 * attaches it to the part, replay hands it back verbatim. A redacted
 * thinking block never streams deltas — an empty start/end pair whose
 * metadata carries the opaque payload.
 */
export type ProviderEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; providerMetadata?: ProviderMetadata }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; providerMetadata?: ProviderMetadata }
  /** Tool identity is known before arguments stream — required here, so UIs can show the call early. */
  | { type: "toolcall_start"; contentIndex: number; toolCallId: string; toolName: string }
  /** Arguments stream as partial JSON text; the fold buffers and parses at `toolcall_end`. */
  | { type: "toolcall_delta"; contentIndex: number; argsDelta: string }
  | { type: "toolcall_end"; contentIndex: number; providerMetadata?: ProviderMetadata }
  /** Terminal marker. Carries the provider outcome and usage — never a message. */
  | { type: "done"; stopReason: ProviderStopReason; usage: Usage };
