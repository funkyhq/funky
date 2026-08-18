import { z } from "zod";
import type { ImageContent, JsonValue, TextContent, ToolSpec } from "@funky/core";

/**
 * The executable half of a tool — deliberately a different type from
 * `ToolSpec` (core), with no structural overlap: an executable can never
 * accidentally ride into a serializable request or across a process
 * boundary. Executables exist only where tools actually run (executor,
 * local driver); everything else sees specs.
 */
export interface Tool {
  name: string;
  description: string;
  /** Zod schema for arguments; projected to the spec's JSON Schema at the edge. */
  input: z.ZodType;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * The declaration half of a Tool — everything but `execute`. Tool modules
 * export their definition as a static constant and bind the executable
 * separately, so specs project from the same source as the executable
 * (drift is impossible) without needing one.
 */
export type ToolDefinition = Pick<Tool, "name" | "description" | "input">;

/**
 * The one projection from executable to declaration — "the edge" the type
 * comments on both sides refer to. `io: "input"` because the spec
 * describes what the model writes: the schema's pre-transform input side.
 */
export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, JsonValue>,
  };
}

/**
 * Execution control handed to execute(), never stored.
 *
 * There is deliberately no workspace/location here: tools always run inside
 * the session's dedicated sandbox (in tests too — real containers), so the
 * process cwd IS the session's workspace. Tools use relative paths and
 * process.cwd(). If a non-sandbox execution context ever appears, this is
 * the decision to revisit.
 */
export interface ToolContext {
  signal: AbortSignal;
  /** Incremental output (e.g. bash stdout). Fire-and-forget decoration. */
  onChunk?: (chunk: string) => void;
}

/** What a tool returns. The engine wraps this into a ToolResultMessage. */
export interface ToolOutcome {
  content: (TextContent | ImageContent)[];
  /** Structured payload for UI rendering; never sent to the model. */
  details?: JsonValue;
  /** Tool-reported failure (e.g. non-zero exit). Defaults to false. */
  isError?: boolean;
}
