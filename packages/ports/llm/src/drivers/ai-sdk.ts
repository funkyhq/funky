// packages/ports/llm/src/drivers/ai-sdk.ts — real providers via the Vercel AI SDK.
//
// Single tool (`exec`) exposed to the model; its tool call is translated back into our
// ToolCall. Transient failures are retried 3× with exponential backoff INSIDE the driver
// so the worker sees at most one LlmTransientError after the driver has exhausted its
// retries; non-retryable failures surface immediately as LlmPermanentError.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  generateText,
  tool,
} from "ai";
import { z } from "zod";
import type { ModelConfig } from "@funky/db/schema";
import type { ToolCall } from "@funky/sessions/events";
import { incrCounter } from "../metrics";
import {
  type ChatMessage,
  type LlmPort,
  LlmPermanentError,
  type LlmRequest,
  type LlmResult,
  LlmTransientError,
} from "../port";

const EXEC_TOOL = "exec";
const MAX_ATTEMPTS = 3;

// No `execute`: the model's exec call is returned and generation stops after one step
// (generateText's default). The worker runs the command in the sandbox, not the SDK.
const execTool = tool({
  description:
    "Run a shell command in the session's sandbox and return its combined stdout/stderr and exit code.",
  inputSchema: z.object({
    cmd: z.string().min(1).describe("The shell command to run."),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(600_000)
      .optional()
      .describe("Optional wall-clock timeout in milliseconds."),
  }),
});

export class AiSdkLlm implements LlmPort {
  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = resolveModel(req.model);
    const { instructions, messages } = toModelMessages(req.messages);
    const providerOptions = parallelToolUseOff(req.model);

    let lastTransient: LlmTransientError | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const result = await generateText({
          model,
          instructions, // the system prompt: ai@7 forbids it inside `messages`
          messages,
          tools: { [EXEC_TOOL]: execTool },
          providerOptions, // disables parallel tool use so the model plans sequentially
          maxOutputTokens: req.model.maxTokens,
          temperature: req.model.temperature,
          maxRetries: 0, // we own the retry loop below (with our error taxonomy)
        });
        return {
          content: result.text,
          toolCall: pickSingleToolCall(result.toolCalls),
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        };
      } catch (err) {
        const classified = classify(err);
        if (classified instanceof LlmPermanentError) throw classified;
        lastTransient = classified;
        if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt));
      }
    }
    // Retries exhausted: hand the worker one transient error to retry at its own layer.
    throw lastTransient ?? new LlmTransientError("llm transient failure");
  }
}

function resolveModel(cfg: ModelConfig): LanguageModel {
  switch (cfg.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(cfg.model);
    case "openai":
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(cfg.model);
    default:
      // v1 ships anthropic + openai; the others are wired identically when needed.
      throw new LlmPermanentError(`llm provider not supported in v1: ${cfg.provider}`);
  }
}

// Layer 1 of the v1 tool-call cap: tell the provider to plan sequentially so it never
// emits a batch in the first place — no intent is dropped. Anthropic and OpenAI spell it
// differently; both go through the AI SDK's per-provider providerOptions.
function parallelToolUseOff(cfg: ModelConfig): Record<string, Record<string, boolean>> | undefined {
  switch (cfg.provider) {
    case "anthropic":
      return { anthropic: { disableParallelToolUse: true } };
    case "openai":
      return { openai: { parallelToolCalls: false } };
    default:
      return undefined;
  }
}

// Layer 2 — defensive truncation: if a provider ignores the flag above and returns a
// batch, keep calls[0] and drop the rest so we never exceed the log's tool_calls.max(1).
// The drop counter is the signal that it's time to lift the cap. This is only safe because
// buildContext (Phase D) rebuilds messages from OUR event log — which recorded one call —
// never from provider-native response objects, so the next request stays internally
// consistent (one tool_use answered by one tool_result).
function pickSingleToolCall(
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>,
): ToolCall | undefined {
  if (toolCalls.length === 0) return undefined;
  if (toolCalls.length > 1) {
    incrCounter("llm_tool_calls_dropped_total", toolCalls.length - 1);
  }
  const first = toolCalls[0]!;
  if (first.toolName !== EXEC_TOOL) return undefined;
  const input = first.input as { cmd?: unknown; timeout_ms?: unknown };
  if (typeof input?.cmd !== "string" || input.cmd.length === 0) return undefined;
  return typeof input.timeout_ms === "number"
    ? { kind: "exec", cmd: input.cmd, timeout_ms: input.timeout_ms }
    : { kind: "exec", cmd: input.cmd };
}

// ChatMessage[] → the AI SDK's top-level `instructions` (the system prompt) + ModelMessage[].
// ai@7 forbids system-role messages inside `messages` (allowSystemInMessages defaults to
// false → "System messages are not allowed… Use the instructions option instead"), so the
// system prompt must travel as the separate `instructions` option. We collect every system
// message (normally exactly one, at the head) and join them.
//
// An assistant tool call and its paired tool result must share a toolCallId; we reuse the
// tool message's idemKey as that id (the log already pairs result → call by idemKey), so the
// reconstruction round-trips cleanly.
function toModelMessages(messages: ChatMessage[]): { instructions?: string; messages: ModelMessage[] } {
  const systemParts: string[] = [];
  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    switch (m.role) {
      case "system":
        systemParts.push(m.content);
        break;
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant": {
        if (m.toolCall) {
          const next = messages[i + 1];
          const id = next && next.role === "tool" ? toolUseId(next.idemKey) : `call-${i}`;
          const parts: Array<TextPart | ToolCallPart> = [];
          if (m.content) parts.push({ type: "text", text: m.content });
          parts.push({ type: "tool-call", toolCallId: id, toolName: EXEC_TOOL, input: execInput(m.toolCall) });
          out.push({ role: "assistant", content: parts });
        } else {
          out.push({ role: "assistant", content: m.content });
        }
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolUseId(m.idemKey),
              toolName: EXEC_TOOL,
              output: { type: "text", value: m.output },
            },
          ],
        });
        break;
    }
  }
  return {
    instructions: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

// Anthropic requires tool_use ids to match ^[a-zA-Z0-9_-]+$; our idemKey is
// `sessionId:seq:index`, whose colons are rejected. Map every disallowed char to `_`.
// Applied identically to the assistant tool-call and its paired tool-result so the two
// still reference the same id (the pairing is by this value, within one request).
function toolUseId(idemKey: string): string {
  return idemKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function execInput(tc: ToolCall): { cmd: string; timeout_ms?: number } {
  return tc.timeout_ms !== undefined ? { cmd: tc.cmd, timeout_ms: tc.timeout_ms } : { cmd: tc.cmd };
}

// Map SDK/provider failures onto the port's two-class taxonomy. 429 / 5xx / network /
// timeout → transient (retry). Everything else (4xx, context-length, bad request) →
// permanent (no retry; becomes turn_failed(LLM_PERMANENT)).
function classify(err: unknown): LlmTransientError | LlmPermanentError {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (err.isRetryable || status === 429 || (status !== undefined && status >= 500)) {
      return new LlmTransientError(err.message);
    }
    return new LlmPermanentError(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(msg)) {
    return new LlmTransientError(msg);
  }
  return new LlmPermanentError(msg);
}

function backoffMs(attempt: number): number {
  return 2 ** attempt * 200; // 200ms, 400ms, ...
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
