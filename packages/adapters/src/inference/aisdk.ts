// The InferenceProvider port over the Vercel AI SDK — one adapter, N
// vendors.
// The composition root's vendor choice arrives as the injected
// `languageModel` factory (e.g. `createAnthropic({ apiKey })`), so this
// file depends only on the vendor-neutral `ai` package.
//
// A dumb translator, per the port contract: StreamRequest → one
// streamText call, TextStreamPart → ProviderEvent one by one, and every
// failure is a throw — error and abort parts become exceptions, the
// engine assigns stopReasons. maxRetries is 0: retry policy belongs to
// the driver (v1: none). The SDK's parts address blocks by string id;
// the port addresses them by contentIndex — ids are mapped to indexes
// in order of first appearance, which is also the block order the
// engine's fold reconstructs.
//
// The one vendor-specific patch: Anthropic's extended-thinking protocol
// requires signatures (and redacted payloads) to round-trip verbatim,
// and the AI SDK carries them in the `anthropic` provider-metadata
// namespace — signatures arrive as empty reasoning deltas, redacted
// blocks as reasoning-start metadata, and replay wants the same values
// back as reasoning-part providerOptions. Capturing and re-attaching
// that namespace is inert for every other vendor.

import {
  type AssistantModelMessage,
  type FinishReason,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  streamText,
  tool,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import type {
  AgentMessage,
  ProviderStopReason,
  ThinkingContent,
  ToolResultMessage,
  ToolSpec,
  Usage,
} from "@funky/core";
import type { InferenceProvider, StreamRequest } from "@funky/agent";

export interface AiSdkProviderOptions {
  /** The request's model string → an AI SDK model. This injection IS the
   *  composition root's vendor choice — a vendor package's provider
   *  function (`createAnthropic({ apiKey })`) fits directly. */
  languageModel: (modelId: string) => LanguageModel;
}

export function createAiSdkProvider(opts: AiSdkProviderOptions): InferenceProvider {
  return {
    async *stream(req: StreamRequest, signal: AbortSignal) {
      const result = streamText({
        model: opts.languageModel(req.model),
        // ai@7 takes the system prompt as `instructions`, never in messages.
        instructions: req.system === "" ? undefined : req.system,
        messages: toModelMessages(req.context),
        tools: toToolSet(req.tools),
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
        abortSignal: signal,
        maxRetries: 0,
      });

      interface Block {
        index: number;
        signature?: string;
        redactedData?: string;
      }
      const blocks = new Map<string, Block>();
      let nextIndex = 0;
      const open = (kind: string, id: string): Block => {
        const block: Block = { index: nextIndex++ };
        blocks.set(`${kind}:${id}`, block);
        return block;
      };
      const at = (kind: string, id: string): Block => {
        const block = blocks.get(`${kind}:${id}`);
        if (!block) throw new Error(`aisdk: ${kind} part for unopened block ${id}`);
        return block;
      };

      let finish:
        | { finishReason: FinishReason; raw: string | undefined; usage: LanguageModelUsage }
        | undefined;

      for await (const part of result.stream) {
        switch (part.type) {
          case "text-start":
            yield { type: "text_start" as const, contentIndex: open("text", part.id).index };
            break;
          case "text-delta":
            yield {
              type: "text_delta" as const,
              contentIndex: at("text", part.id).index,
              delta: part.text,
            };
            break;
          case "text-end":
            yield { type: "text_end" as const, contentIndex: at("text", part.id).index };
            break;
          case "reasoning-start": {
            const block = open("reasoning", part.id);
            block.redactedData = anthropicString(part.providerMetadata, "redactedData");
            yield { type: "thinking_start" as const, contentIndex: block.index };
            break;
          }
          case "reasoning-delta": {
            const block = at("reasoning", part.id);
            const signature = anthropicString(part.providerMetadata, "signature");
            if (signature !== undefined) block.signature = signature;
            if (part.text !== "") {
              yield {
                type: "thinking_delta" as const,
                contentIndex: block.index,
                delta: part.text,
              };
            }
            break;
          }
          case "reasoning-end": {
            const block = at("reasoning", part.id);
            const signature =
              anthropicString(part.providerMetadata, "signature") ?? block.signature;
            yield block.redactedData !== undefined
              ? {
                  type: "thinking_end" as const,
                  contentIndex: block.index,
                  signature: block.redactedData,
                  redacted: true,
                }
              : { type: "thinking_end" as const, contentIndex: block.index, signature };
            break;
          }
          case "tool-input-start":
            // The part's id IS the vendor's tool call id.
            yield {
              type: "toolcall_start" as const,
              contentIndex: open("tool", part.id).index,
              toolCallId: part.id,
              toolName: part.toolName,
            };
            break;
          case "tool-input-delta":
            yield {
              type: "toolcall_delta" as const,
              contentIndex: at("tool", part.id).index,
              argsDelta: part.delta,
            };
            break;
          case "tool-input-end":
            yield { type: "toolcall_end" as const, contentIndex: at("tool", part.id).index };
            break;
          case "finish":
            finish = {
              finishReason: part.finishReason,
              raw: part.rawFinishReason,
              usage: part.totalUsage,
            };
            break;
          case "error":
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          case "abort":
            throw new DOMException("The operation was aborted.", "AbortError");
          default:
            // start / step markers, assembled tool-call parts (already
            // streamed as input parts), sources, files, raw chunks.
            break;
        }
      }

      // No finish part → the generator just ends, and the engine treats a
      // stream without done as an error.
      if (finish) {
        yield {
          type: "done" as const,
          stopReason: toStopReason(finish.finishReason, finish.raw),
          usage: toUsage(finish.usage),
        };
      }
    },
  };
}

function toToolSet(specs: ToolSpec[]): ToolSet {
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      // No execute: the model's calls come back to the driver; nothing
      // runs inside the SDK.
      tool({
        description: spec.description,
        inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
}

type AssistantPart = Exclude<AssistantModelMessage["content"], string>[number];

function toModelMessages(context: AgentMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of context) {
    switch (message.role) {
      case "user":
        out.push({
          role: "user",
          content: message.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "image" as const, image: part.data, mediaType: part.mimeType },
          ),
        });
        break;
      case "assistant": {
        const parts: AssistantPart[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            // Vendors reject empty text blocks; an empty part carries nothing.
            if (part.text !== "") parts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking") {
            parts.push(toReasoningPart(part));
          } else {
            parts.push({
              type: "tool-call",
              toolCallId: part.id,
              toolName: part.name,
              input: part.arguments,
            });
          }
        }
        if (parts.length > 0) out.push({ role: "assistant", content: parts });
        break;
      }
      case "toolResult":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: toToolOutput(message),
            },
          ],
        });
        break;
    }
  }
  return out;
}

/** Replay of a thinking part: signed → an Anthropic thinking block,
 *  redacted → redacted_thinking (the opaque payload rides in
 *  `thinkingSignature`, see core). @ai-sdk/anthropic reads exactly these
 *  providerOptions keys; unsigned parts ride as plain reasoning text. */
function toReasoningPart(part: ThinkingContent): AssistantPart {
  if (part.redacted && part.thinkingSignature !== undefined) {
    return {
      type: "reasoning",
      text: "",
      providerOptions: { anthropic: { redactedData: part.thinkingSignature } },
    };
  }
  if (part.thinkingSignature !== undefined) {
    return {
      type: "reasoning",
      text: part.thinking,
      providerOptions: { anthropic: { signature: part.thinkingSignature } },
    };
  }
  return { type: "reasoning", text: part.thinking };
}

function toToolOutput(message: ToolResultMessage): ToolResultPart["output"] {
  const images = message.content.some((part) => part.type === "image");
  if (!images) {
    const value = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    return message.isError ? { type: "error-text", value } : { type: "text", value };
  }
  // The content form has no error variant; isError is dropped for image
  // results — the text of the result still says what failed.
  return {
    type: "content",
    value: message.content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image-data" as const, data: part.data, mediaType: part.mimeType },
    ),
  };
}

function toStopReason(reason: FinishReason, raw: string | undefined): ProviderStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool-calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      // Outside the port's vocabulary (content-filter, error, other): no
      // silent coercion — the throw becomes an error-stopped message.
      throw new Error(`provider finished with ${reason}${raw ? ` (${raw})` : ""}`);
  }
}

function toUsage(usage: LanguageModelUsage): Usage {
  const reasoning = usage.outputTokenDetails.reasoningTokens;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function anthropicString(metadata: ProviderMetadata | undefined, key: string): string | undefined {
  const value = metadata?.["anthropic"]?.[key];
  return typeof value === "string" ? value : undefined;
}
