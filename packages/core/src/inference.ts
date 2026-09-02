import { z } from "zod";

/**
 * The inference vocabulary — the declarative description of how a
 * session's inference runs: which provider serves it, which model, and
 * how to sample.
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
