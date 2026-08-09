import type { StopReason, Usage } from "./messages";

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

export type ProviderEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  /** Anthropic delivers the signature at block end; the fold attaches it to the part.
   *  Redacted blocks never stream deltas: adapters emit an empty start/end pair with
   *  `redacted: true` and the opaque encrypted payload in `signature`; the fold sets
   *  the part's `redacted` flag so replay reconstructs a `redacted_thinking` block. */
  | { type: "thinking_end"; contentIndex: number; signature?: string; redacted?: boolean }
  /** Tool identity is known before arguments stream — required here, so UIs can show the call early. */
  | { type: "toolcall_start"; contentIndex: number; toolCallId: string; toolName: string }
  /** Arguments stream as partial JSON text; the fold buffers and parses at `toolcall_end`. */
  | { type: "toolcall_delta"; contentIndex: number; argsDelta: string }
  | { type: "toolcall_end"; contentIndex: number }
  /** Terminal marker. Carries the provider outcome and usage — never a message. */
  | { type: "done"; stopReason: ProviderStopReason; usage: Usage };
