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
//  - The worker can route to it. apps/worker/src/main.ts constructs ONE
//    inference adapter at composition (`createAnthropic`), and the driver
//    never reads config.inference.provider — "picked the adapter at
//    composition and is not part of the request"
//    (packages/agent/src/driver/loop.ts). A config naming a provider the
//    worker didn't wire would still run on the one it did.
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
];

// Replaced at build time by vite.config.ts (`define`), so this is a literal
// array in the bundle rather than a lookup. Read once, at module load: the
// dev server read .env once too, when it started.
declare const __FUNKY_PROVIDERS__: string[];

/** Those with a key configured — the ones a config can actually name. */
export const PROVIDERS: Provider[] = KNOWN_PROVIDERS.filter((provider) =>
  __FUNKY_PROVIDERS__.includes(provider.id),
);
