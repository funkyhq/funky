import { z } from "zod";

/**
 * The inference vocabulary — the declarative description of how a
 * session's inference runs: which provider serves it, which model, and
 * how to sample. `provider` ("anthropic", "openai", …) names the
 * interpreting adapter and is consumed picking it (2026-08-15) — the
 * composition root today, a registry when a second vendor exists; it is
 * not part of the StreamRequest. model/maxTokens/temperature ride the
 * request for the chosen adapter to map. Core does not enumerate
 * vendors.
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
