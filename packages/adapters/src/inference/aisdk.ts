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
// Vendor continuity data — Anthropic's thinking signatures, OpenAI's
// reasoning items, Gemini's thought signatures — arrives as
// `providerMetadata` on a block's chunks, on whichever chunks the vendor
// chose (Anthropic: an empty reasoning delta; Gemini: every chunk). The
// adapter merges it per block, later chunks winning, hands the merge to
// the engine on the block's end event, and on replay attaches each
// stored part's metadata back as `providerOptions`, verbatim. No vendor
// is named in the process: whatever an SDK attaches is what it gets
// back.
//
// A tool call closes on the SDK's assembled `tool-call` part, not on
// `tool-input-end`: the assembled part is where the metadata lands, and
// some providers (openai-compatible, so Together) stream no input parts
// at all — for those the start and a single delta are synthesized from
// it.

import {
  type AssistantModelMessage,
  type FinishReason,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata as SdkProviderMetadata,
  streamText,
  tool,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import type {
  AgentMessage,
  JsonValue,
  ProviderMetadata,
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
        /** The vendor's continuity data, merged across the block's chunks. */
        metadata?: ProviderMetadata;
      }
      const blocks = new Map<string, Block>();
      let nextIndex = 0;
      const open = (kind: string, id: string, metadata?: SdkProviderMetadata): Block => {
        const block: Block = { index: nextIndex++ };
        blocks.set(`${kind}:${id}`, block);
        absorb(block, metadata);
        return block;
      };
      const at = (kind: string, id: string, metadata?: SdkProviderMetadata): Block => {
        const block = blocks.get(`${kind}:${id}`);
        if (!block) throw new Error(`aisdk: ${kind} part for unopened block ${id}`);
        absorb(block, metadata);
        return block;
      };
      const ended = (block: Block): { providerMetadata?: ProviderMetadata } =>
        block.metadata === undefined ? {} : { providerMetadata: block.metadata };
      // Provider-executed tools (server-side search, code execution) are
      // never declared by this adapter, so no vendor should run one. If
      // one does, the call and its result are the vendor's affair, not a
      // local tool for the driver to schedule: skipped, never surfaced.
      const foreign = new Set<string>();

      let finish:
        | { finishReason: FinishReason; raw: string | undefined; usage: LanguageModelUsage }
        | undefined;

      for await (const part of result.stream) {
        switch (part.type) {
          case "text-start":
            yield {
              type: "text_start" as const,
              contentIndex: open("text", part.id, part.providerMetadata).index,
            };
            break;
          case "text-delta":
            yield {
              type: "text_delta" as const,
              contentIndex: at("text", part.id, part.providerMetadata).index,
              delta: part.text,
            };
            break;
          case "text-end": {
            const block = at("text", part.id, part.providerMetadata);
            yield { type: "text_end" as const, contentIndex: block.index, ...ended(block) };
            break;
          }
          case "reasoning-start":
            yield {
              type: "thinking_start" as const,
              contentIndex: open("reasoning", part.id, part.providerMetadata).index,
            };
            break;
          case "reasoning-delta": {
            // An empty delta is metadata only (Anthropic's signature).
            const block = at("reasoning", part.id, part.providerMetadata);
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
            const block = at("reasoning", part.id, part.providerMetadata);
            yield { type: "thinking_end" as const, contentIndex: block.index, ...ended(block) };
            break;
          }
          case "tool-input-start":
            if (part.providerExecuted) {
              foreign.add(part.id);
              break;
            }
            // The part's id IS the vendor's tool call id.
            yield {
              type: "toolcall_start" as const,
              contentIndex: open("tool", part.id, part.providerMetadata).index,
              toolCallId: part.id,
              toolName: part.toolName,
            };
            break;
          case "tool-input-delta":
            if (foreign.has(part.id)) break;
            yield {
              type: "toolcall_delta" as const,
              contentIndex: at("tool", part.id, part.providerMetadata).index,
              argsDelta: part.delta,
            };
            break;
          case "tool-input-end":
            if (foreign.has(part.id)) break;
            // Metadata only; the assembled tool-call below closes the block.
            at("tool", part.id, part.providerMetadata);
            break;
          case "tool-call": {
            if (part.providerExecuted || foreign.has(part.toolCallId)) break;
            let block = blocks.get(`tool:${part.toolCallId}`);
            if (block === undefined) {
              // No input parts were streamed: the assembled call is all
              // there is, so it becomes the start and a single delta.
              block = open("tool", part.toolCallId);
              yield {
                type: "toolcall_start" as const,
                contentIndex: block.index,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
              };
              yield {
                type: "toolcall_delta" as const,
                contentIndex: block.index,
                argsDelta: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
              };
            }
            absorb(block, part.providerMetadata);
            yield { type: "toolcall_end" as const, contentIndex: block.index, ...ended(block) };
            break;
          }
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
            // start / step markers, tool results and errors of
            // provider-executed tools, sources, files, raw chunks.
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

/** Merge one chunk's metadata into its block: per vendor namespace,
 *  later keys win. An absent value or an empty namespace says nothing
 *  and leaves nothing behind. */
function absorb(
  block: { metadata?: ProviderMetadata },
  metadata: SdkProviderMetadata | undefined,
): void {
  if (metadata === undefined) return;
  for (const [vendor, values] of Object.entries(metadata)) {
    const json = toJsonObject(values);
    if (Object.keys(json).length === 0) continue;
    const merged = (block.metadata ??= {});
    merged[vendor] = { ...merged[vendor], ...json };
  }
}

/** The SDK's JSON allows `undefined` at any depth (the Anthropic package
 *  emits `caller: { toolId: undefined }` on tool calls); the log's
 *  JsonValue does not, and the store validates before it writes. Drop
 *  such keys and null such array slots — what JSON.stringify would do. */
function toJsonObject(values: object): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const json = toJson(value);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "object":
      return Array.isArray(value) ? value.map((item) => toJson(item) ?? null) : toJsonObject(value);
    default:
      return undefined;
  }
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

/** A stored part's metadata, back on the SDK part as `providerOptions`. */
const replayed = (
  metadata: ProviderMetadata | undefined,
): { providerOptions?: ProviderMetadata } =>
  metadata === undefined ? {} : { providerOptions: metadata };

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
            if (part.text !== "") {
              parts.push({ type: "text", text: part.text, ...replayed(part.providerMetadata) });
            }
          } else if (part.type === "thinking") {
            parts.push({
              type: "reasoning",
              text: part.thinking,
              ...replayed(part.providerMetadata ?? legacyAnthropicMetadata(part)),
            });
          } else {
            parts.push({
              type: "tool-call",
              toolCallId: part.id,
              toolName: part.name,
              input: part.arguments,
              ...replayed(part.providerMetadata),
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

/** Rows stored before `providerMetadata` existed (Anthropic only): the
 *  signature, or a redacted block's opaque payload, in the shape
 *  @ai-sdk/anthropic reads. New rows never take this path. */
function legacyAnthropicMetadata(part: ThinkingContent): ProviderMetadata | undefined {
  if (part.thinkingSignature === undefined) return undefined;
  return part.redacted
    ? { anthropic: { redactedData: part.thinkingSignature } }
    : { anthropic: { signature: part.thinkingSignature } };
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
