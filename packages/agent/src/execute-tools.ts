import type { ToolCall, ToolResultMessage } from "@funky/core";
import type { Tool } from "./tool";

export interface ExecuteToolsDeps {
  tools: Map<string, Tool>;
  /** Sync fire-and-forget tap for incremental tool output. Failures are swallowed. */
  onUpdate?: (update: ToolUpdate) => void;
}

export interface ToolUpdate {
  toolCallId: string;
  toolName: string;
  chunk: string;
}

export type ToolExecutionMode = "sequential" | "parallel";

/** Serializable data only — loggable, replayable. */
export interface ExecuteToolsRequest {
  calls: ToolCall[];
  /** Defaults to "parallel". Sequential guarantees a call starts only after
   *  the previous one finished — and that calls after an abort never start. */
  mode?: ToolExecutionMode;
}

/**
 * Execute one assistant message's tool calls and return exactly one
 * ToolResultMessage per tool_call_id — in call order, no matter what.
 *
 * Parallel (default) starts every call immediately; result order is still
 * call order, not completion order. Tools are an isolation boundary:
 * unknown tool, invalid arguments, and thrown exceptions all become error
 * results, never engine failures. If the signal fires, in-flight calls
 * resolve to interrupted results and (in sequential mode) not-yet-started
 * calls get one without running — the transcript never contains a dangling
 * tool_call_id; the model sees what didn't run and decides recovery. The
 * engine executes each call at most once; never-retry is a ledger rule
 * that starts here.
 */
export async function executeTools(
  deps: ExecuteToolsDeps,
  req: ExecuteToolsRequest,
  signal: AbortSignal,
): Promise<ToolResultMessage[]> {
  if (req.mode === "sequential") {
    const results: ToolResultMessage[] = [];
    for (const call of req.calls) {
      results.push(signal.aborted ? interruptedResult(call) : await executeOne(deps, call, signal));
    }
    return results;
  }
  return Promise.all(
    req.calls.map((call) =>
      signal.aborted ? interruptedResult(call) : executeOne(deps, call, signal),
    ),
  );
}

async function executeOne(
  deps: ExecuteToolsDeps,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolResultMessage> {
  const tool = deps.tools.get(call.name);
  if (!tool) return errorResult(call, `tool not found: ${call.name}`);

  const onChunk = (chunk: string): void => {
    if (!deps.onUpdate) return;
    try {
      deps.onUpdate({ toolCallId: call.id, toolName: call.name, chunk });
    } catch {
      // Decoration never breaks the step; logging belongs to the caller's
      // wrapper, which has the ids and the logger.
    }
  };

  try {
    // Inside the try: safeParse only converts *validation* failures into a
    // result — an exception thrown from a schema's transform/refine body
    // propagates, and must become an error result like any other.
    const parsed = tool.input.safeParse(call.arguments);
    if (!parsed.success) {
      return errorResult(call, `invalid arguments for ${call.name}: ${parsed.error.message}`);
    }
    const outcome = await tool.execute(parsed.data, { signal, onChunk });
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: outcome.content,
      isError: outcome.isError ?? false,
      ...(outcome.details !== undefined ? { details: outcome.details } : {}),
    };
  } catch (err) {
    if (signal.aborted) return interruptedResult(call);
    return errorResult(call, err instanceof Error ? err.message : String(err));
  }
}

function errorResult(call: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function interruptedResult(call: ToolCall): ToolResultMessage {
  return errorResult(call, "Tool execution was interrupted.");
}
