import { z } from "zod";

/**
 * The environment vocabulary — the declarative description of the world a
 * session runs in. Described here, instantiated elsewhere: the
 * SandboxProvider port (deferred) turns descriptions into running
 * sandboxes, and its adapters are the interpreters. Only converged intent
 * belongs in this file, and it arrives one promoted field at a time —
 * there is deliberately no opaque options bag: a capability enters the
 * recipe together with the adapter contract that interprets it.
 */

// Intent, not mechanism: adapters translate to whatever their provider
// enforces and MUST reject create() when they cannot enforce it — never
// silently run more open than asked.
export const NetworkPolicy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unrestricted") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("allowlist"), domains: z.array(z.string()) }),
]);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

// Keyed by package manager ("pip", "npm", "apt", "cargo", …) — open like
// InferenceConfig.provider: core doesn't enumerate managers, and an
// adapter that cannot guarantee one MUST reject create(). Spec strings
// keep each ecosystem's native syntax ("pandas==2.2.0", "express@4.18.0",
// "rails:7.1.0") — the map names the interpreter; the string stays native
// to it, so no invented cross-ecosystem version grammar to translate.
export const Packages = z.record(z.string(), z.array(z.string()));
export type Packages = z.infer<typeof Packages>;
