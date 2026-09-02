// apps/worker/src/providers.ts — the vendor table: every model provider
// this worker can serve, one entry each. An entry is the id a config's
// `inference.provider` names, the env var its key is read from, and the
// AI SDK vendor package that turns the key into a model factory. Two
// readers: config.ts reads the keys through it, main.ts wires an
// inference adapter per key found — so adding a vendor is one entry
// here (plus its package), then one in the console's own table
// (apps/web/src/lib/providers.ts) to offer it.
//
// Keys are handed over explicitly, not left for each SDK to find in the
// environment: config.ts is the one place env is read, and a key the
// worker never saw is a provider it never wired.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import type { LanguageModel } from "ai";
import { createAiSdkProvider } from "@funky/adapters";
import type { InferenceProvider } from "@funky/agent";

export interface Vendor {
  /** What a config's `inference.provider` names. */
  id: string;
  /** The env var the key is read from. */
  envKey: string;
  /** The vendor's AI SDK provider function bound to a key: the model
   *  factory the adapter calls with each request's model id. */
  languageModel: (apiKey: string) => (modelId: string) => LanguageModel;
}

/** Ids follow the AI SDK package suffix (`@ai-sdk/togetherai` → `togetherai`)
 *  so a config author can guess them; env vars follow each SDK's own
 *  convention so a key already exported for that SDK works unchanged. */
export const VENDORS: readonly Vendor[] = [
  {
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    languageModel: (apiKey) => createAnthropic({ apiKey }),
  },
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    languageModel: (apiKey) => createOpenAI({ apiKey }),
  },
  {
    id: "google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    languageModel: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  },
  {
    id: "togetherai",
    envKey: "TOGETHER_API_KEY",
    languageModel: (apiKey) => createTogetherAI({ apiKey }),
  },
];

/**
 * One inference adapter per key: the registry the driver routes on
 * (`StepDeps.providers`), whose keys are exactly the providers this
 * worker serves. `keys` is by vendor id — config.ts's `providerKeys`.
 */
export function wireProviders(keys: ReadonlyMap<string, string>): Map<string, InferenceProvider> {
  const providers = new Map<string, InferenceProvider>();
  for (const vendor of VENDORS) {
    const apiKey = keys.get(vendor.id);
    if (apiKey === undefined) continue;
    providers.set(vendor.id, createAiSdkProvider({ languageModel: vendor.languageModel(apiKey) }));
  }
  return providers;
}
