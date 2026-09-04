// apps/web/src/lib/providers.ts
// Which providers this console offers, and the models each one serves.
//
// A provider is offered only when TWO different things are true, and they
// are worth keeping apart:
//
//  - There is a key for it. vite.config.ts reads the monorepo root .env when
//    it starts and injects the ids it found a non-empty key for. Only the
//    IDS cross into the bundle — no key value ever does, same rule as
//    FUNKY_AUTH_TOKEN.
//  - The worker can route to it. apps/worker/src/main.ts wires one
//    inference adapter per vendor into a registry keyed by provider id,
//    and the driver resolves config.inference.provider against it on
//    every claim (packages/agent/src/driver/loop.ts). A config naming a
//    provider the worker didn't wire ends its run in error — it never
//    runs on some other vendor.
//
// The second fact is why this is a registry and not a scan of whatever keys
// happen to be in .env: an entry here is a claim that the worker serves it.
// Adding one is two changes, not one — wire the adapter in the worker's
// composition root first, then add the entry.

export type ProviderModel = { id: string; label: string };

export type Provider = {
  /** What lands in `inference.provider`. */
  id: string;
  label: string;
  /** The env var the stack reads its key from; mirrored in vite.config.ts. */
  envKey: string;
  /** Newest of each tier. Ids are complete as written — no date suffix. */
  models: ProviderModel[];
};

/** Every provider the worker can serve, key or no key. */
export const KNOWN_PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
  },
  {
    id: "google",
    label: "Google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    models: [
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
    ],
  },
  {
    // Together's catalog is open-ended; these are current open models
    // with tool calling. Any Together model id works through the api.
    id: "togetherai",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro-0813", label: "DeepSeek V4 Pro" },
      { id: "zai-org/GLM-5.3", label: "GLM-5.3" },
      { id: "moonshotai/Kimi-K3", label: "Kimi K3" },
    ],
  },
  {
    // One release line rather than tiers, so only the newest is listed.
    // Any xAI model id works through the api.
    id: "xai",
    label: "xAI",
    envKey: "XAI_API_KEY",
    models: [{ id: "grok-4.6", label: "Grok 4.6" }],
  },
];

// Replaced at build time by vite.config.ts (`define`), so this is a literal
// array in the bundle rather than a lookup. Read once, at module load: the
// dev server read .env once too, when it started.
declare const __FUNKY_PROVIDERS__: string[];

/** Those with a key configured — the ones a config can actually name. */
export const PROVIDERS: Provider[] = KNOWN_PROVIDERS.filter((provider) =>
  __FUNKY_PROVIDERS__.includes(provider.id),
);
