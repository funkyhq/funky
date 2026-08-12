import type { AgentMessage, ProviderEvent, ToolSpec } from "@funky/core";

/**
 * The harness's entire knowledge of "there is an AI model somewhere":
 * one request in, one live stream of increments out.
 *
 * Contract for implementations:
 * - Translate `req` to the vendor wire format and the vendor's stream events
 *   to `ProviderEvent`s, one by one, as they arrive. Nothing else: no fold
 *   (the engine assembles the message), no retries (driver policy), no
 *   persistence, no knowledge of sessions/runs/items.
 * - End the stream with exactly one `done` event on provider-reported
 *   completion.
 * - Pass `signal` into the vendor SDK so cancellation severs the HTTP stream
 *   mid-generation; on abort or any failure, just throw — the engine converts
 *   exceptions into `aborted`/`error`-stopped messages.
 * - Each `stream()` call is stateless and independent.
 */
export interface InferenceProvider {
  stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

/** Serializable data only — the (req, signal) split mirrors the engine's. */
export interface StreamRequest {
  model: string;
  system: string;
  context: AgentMessage[];
  tools: ToolSpec[];
}
