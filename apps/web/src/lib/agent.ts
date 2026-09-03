// apps/web/src/lib/agent.ts
// An agent config as a form: what a surface holds while one is being
// filled in, and the moves between those fields and the api's `inference`
// block. Shared by the create dialog and the quickstart, which write the
// same three values and must not drift apart in how they read them — the
// same reason lib/network.ts exists for the other config.
import type { InferenceConfig } from "./api";
import { PROVIDERS, type Provider } from "./providers";

/** What a form holds. These three are the create body's REQUIRED shape;
 *  the optional parts of `inference` are left absent, which is what the api
 *  reads as the provider's own default (see toInference). */
export type AgentFields = { provider: string; model: string; systemPrompt: string };

/** A provider by id, or nothing when the stack has no key for it. The
 *  fallback is the caller's to choose: a dialog that only opens with a
 *  provider available and a page that has to say there is none want
 *  different answers to the same absence. */
export const byId = (id: string): Provider | undefined =>
  PROVIDERS.find((entry) => entry.id === id);

/** The fields as they are on a provider: its first model, since the one
 *  that was selected belonged to whichever provider is being left. */
export const onProvider = (provider: Provider, systemPrompt: string): AgentFields => ({
  provider: provider.id,
  model: provider.models[0].id,
  systemPrompt,
});

/** Where a form starts: the first provider this stack has a key for. Empty
 *  when it has none — there is no model to offer under a provider that
 *  can't be named, and a surface with nothing to offer says so rather than
 *  starting the form on a lie. */
export function initialFields(): AgentFields {
  const provider = PROVIDERS[0];
  return provider === undefined
    ? { provider: "", model: "", systemPrompt: "" }
    : onProvider(provider, "");
}

/** The fields as the api's inference block. maxTokens and temperature are
 *  absent rather than defaulted here: they belong to a config being tuned,
 *  not to one being made, and the api resolves them per provider. */
export const toInference = (fields: AgentFields): InferenceConfig => ({
  provider: fields.provider,
  model: fields.model,
});
