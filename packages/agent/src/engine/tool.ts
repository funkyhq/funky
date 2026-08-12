import type { z } from "zod";
import type { ImageContent, JsonValue, TextContent } from "@funky/core";

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
