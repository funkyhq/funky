import type {
  AgentMessage,
  AssistantMessage,
  JsonValue,
  ProviderEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolSpec,
  Usage,
} from "@funky/core";
import type { InferenceProvider } from "./inference-provider";

export interface InferenceDeps {
  provider: InferenceProvider;
  /** Sync fire-and-forget tap. Failures are swallowed: decoration never breaks the step. */
  onDelta?: (e: ProviderEvent) => void;
}

/** Serializable data only — loggable, replayable. */
export interface InferenceRequest {
  model: string;
  system: string;
  context: AgentMessage[];
  tools: ToolSpec[];
}

type DraftPart = TextContent | ThinkingContent | ToolCall;

/**
 * The fold: consume the provider's event stream, accumulate a draft
 * AssistantMessage, return it.
 *
 * Contract: exactly one message per call; never throws for domain outcomes.
 * `stopReason` discriminates — provider outcomes come from `done`; `aborted`
 * (signal fired; partial content preserved) and `error` (provider threw, or
 * the stream was malformed) are assigned here and only here. The driver
 * decides what to do with an error message (commit vs. discard-and-retry);
 * no retry policy lives in the engine.
 */
export async function inference(
  deps: InferenceDeps,
  req: InferenceRequest,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const parts: (DraftPart | undefined)[] = [];
  const argBuffers = new Map<number, string>();
  let done: { stopReason: AssistantMessage["stopReason"]; usage: Usage } | undefined;
  let failure: string | undefined;

  const tap = (event: ProviderEvent): void => {
    if (!deps.onDelta) return;
    try {
      deps.onDelta(event);
    } catch {
      // Intentionally silent containment, not just "no logging yet": the
      // engine has no ids to correlate a log line with (by design), and a
      // throwing tap throws per-event at token frequency. Logging belongs
      // in the caller's wrapper, which owns the sink, the ids, and the
      // logger. Decoration never breaks the step.
    }
  };

  const partAt = <T extends DraftPart["type"]>(
    contentIndex: number,
    type: T,
  ): Extract<DraftPart, { type: T }> => {
    const part = parts[contentIndex];
    if (!part || part.type !== type) {
      throw new Error(`malformed stream: expected open ${type} part at index ${contentIndex}`);
    }
    return part as Extract<DraftPart, { type: T }>;
  };

  try {
    for await (const event of deps.provider.stream(req, signal)) {
      tap(event);
      switch (event.type) {
        case "text_start":
          parts[event.contentIndex] = { type: "text", text: "" };
          break;
        case "text_delta":
          partAt(event.contentIndex, "text").text += event.delta;
          break;
        case "text_end":
          break;
        case "thinking_start":
          parts[event.contentIndex] = { type: "thinking", thinking: "" };
          break;
        case "thinking_delta":
          partAt(event.contentIndex, "thinking").thinking += event.delta;
          break;
        case "thinking_end": {
          const part = partAt(event.contentIndex, "thinking");
          if (event.signature !== undefined) part.thinkingSignature = event.signature;
          if (event.redacted) {
            // Redacted blocks carry no visible thinking; the opaque payload
            // rides in the signature so replay reconstructs redacted_thinking.
            part.redacted = true;
            part.thinking = "";
          }
          break;
        }
        case "toolcall_start":
          parts[event.contentIndex] = {
            type: "toolCall",
            id: event.toolCallId,
            name: event.toolName,
            arguments: {},
          };
          argBuffers.set(event.contentIndex, "");
          break;
        case "toolcall_delta": {
          partAt(event.contentIndex, "toolCall");
          const buffer = argBuffers.get(event.contentIndex) ?? "";
          argBuffers.set(event.contentIndex, buffer + event.argsDelta);
          break;
        }
        case "toolcall_end": {
          const part = partAt(event.contentIndex, "toolCall");
          part.arguments = parseArguments(argBuffers.get(event.contentIndex) ?? "");
          break;
        }
        case "done":
          done = { stopReason: event.stopReason, usage: event.usage };
          break;
      }
    }
    if (!done) failure = "malformed stream: ended without done";
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // Sparse slots (an adapter skipped an index) simply drop out of the message.
  const content = parts.filter((part): part is DraftPart => part !== undefined);
  const base = { role: "assistant", content, model: req.model } as const;

  // A completed generation stands even if the signal fired during teardown.
  if (done) return { ...base, stopReason: done.stopReason, usage: done.usage };
  // An interrupted one is aborted regardless of how the interruption surfaced
  // (SDK throw, clean stream end) — the partial draft is the message.
  if (signal.aborted) return { ...base, stopReason: "aborted" };
  return { ...base, stopReason: "error", errorMessage: failure ?? "unknown provider failure" };
}

/** Providers stream tool arguments as JSON text; an empty buffer means no arguments. */
function parseArguments(buffer: string): Record<string, JsonValue> {
  if (buffer.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer);
  } catch {
    throw new Error("malformed stream: tool-call arguments are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("malformed stream: tool-call arguments are not an object");
  }
  return parsed as Record<string, JsonValue>;
}
