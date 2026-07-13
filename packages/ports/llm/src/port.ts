// packages/ports/llm/src/port.ts — the LLM port (Phase B).
//
// A plain TypeScript interface, NOT proto/codegen: a same-process contract the worker
// (Phase E) imports directly. Drivers are selected by config at the entrypoint; the
// worker never imports a driver.

import type { ModelConfig } from "@funky/db/schema";
import type { ToolCall } from "@funky/sessions/events";

/** Provider-neutral chat message. content is already flattened to a string here —
 *  the LLM port does not deal in ContentBlocks (that's a log concern). */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCall?: ToolCall }
  | { role: "tool"; idemKey: string; output: string; exitCode: number };

export type LlmResult = {
  content: string;
  toolCall?: ToolCall; // v1 cap: at most ONE (matches the log's tool_calls.max(1))
  usage: { inputTokens: number; outputTokens: number };
};

export type LlmRequest = {
  model: ModelConfig;
  messages: ChatMessage[];
  /** Opaque driver bookkeeping; providers ignore it. The fake reads `sessionId` to pick
   *  its script — identity is NEVER inferred by parsing message content. */
  trace?: { sessionId: string };
};

export interface LlmPort {
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** 429 / 5xx / timeout — worker retries (driver already retried 3× w/ backoff). */
export class LlmTransientError extends Error {
  readonly kind = "llm_transient" as const;
}
/** 4xx / context-length / bad request — no retry; becomes turn_failed(LLM_PERMANENT). */
export class LlmPermanentError extends Error {
  readonly kind = "llm_permanent" as const;
}
