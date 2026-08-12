import { z } from "zod";

/**
 * The inference vocabulary — the declarative description of how a
 * session's inference runs: which model serves it and how to sample. The
 * InferenceProvider adapter is the interpreter: `provider` routes within
 * it ("anthropic", "openai", …) the way env recipes route within the
 * SandboxProvider — core does not enumerate vendors.
 */
export const InferenceConfig = z.object({
  provider: z.string(),
  model: z.string(),
  // Absent = the provider's own default — there is no harness value to
  // materialize, so absence is the stored truth too (never null).
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});
export type InferenceConfig = z.infer<typeof InferenceConfig>;
