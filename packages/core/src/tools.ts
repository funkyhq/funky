import { z } from "zod";
import { JsonValue } from "./messages";

/**
 * The serializable declaration of a tool: what the model needs to decide to
 * call it — never how to run it. Executables (the `Tool` interface with an
 * `execute()` body) live in the agent package, executor-side only; specs are
 * what travel in inference requests and to model providers.
 */
export const ToolSpec = z.object({
  name: z.string(),
  description: z.string(),
  // JSON Schema for the tool's arguments. Kept as plain JSON (not zod) so it
  // serializes; executables declare zod schemas and project to this at the edge.
  inputSchema: z.record(z.string(), JsonValue),
});
export type ToolSpec = z.infer<typeof ToolSpec>;
