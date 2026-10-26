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

// Shell commands that finish preparing the environment after its
// packages are installed: writing a tool's config, registering a
// stand-in key, putting files on disk. They run in order, each in its
// own shell (a `cd` doesn't carry over), as the user the agent's
// commands run as, and the first to fail fails the environment. They
// are part of the environment, not the session: an adapter may run them
// once and reuse the result for every session that asks for the same
// environment, so they see no credentials, and what they fetch is
// frozen at that first run. Line breaks are allowed (a heredoc writes a
// file); NUL is not, as no shell command can carry it.
export const SetupCommands = z.array(
  z
    .string()
    .regex(/\S/, "must not be blank")
    .refine((command) => !command.includes("\0"), "must not contain NUL"),
);
export type SetupCommands = z.infer<typeof SetupCommands>;

/** A key's name in the namespace's secret store (/v1/secrets). */
export const SecretName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "1-64 characters: letters, digits, _ and -");

const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "letters, digits and _, not starting with a digit");

// A host, or every subdomain of one (*.example.com): lowercase, with no
// scheme, port or path.
const Domain = z
  .string()
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "a lowercase host, such as api.example.com or *.example.com",
  );

// Keys a session's sandbox gets from the namespace's secret store, by
// name: the value is fetched when the sandbox is created and never rides
// in the config. Injected, the one type, keeps the key out of the
// sandbox: `env` holds a placeholder, and on requests to `domains` the
// provider sets `header` to `value`, with `{secret}` replaced by the key.
// The agent can use the key, never read it. `type` is required all the
// same, so another way to deliver a key can join later without changing
// what an existing config means.
//
// Strict: a field the type doesn't take is refused, not dropped, so a key
// pasted into the config is an error rather than silently discarded.
export const Credential = z.strictObject({
  type: z.literal("injected"),
  env: EnvName,
  secret: SecretName,
  domains: z.array(Domain).min(1),
  header: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "an HTTP header name"),
  value: z
    .string()
    .regex(/^[\x20-\x7e]*$/, "printable ASCII, with no line breaks")
    .refine((value) => value.includes("{secret}"), "must contain {secret}"),
});
export type Credential = z.infer<typeof Credential>;

// One credential per env var, and one per header on a domain: of two
// claiming the same slot, which one wins would be left to the adapter.
export const Credentials = z.array(Credential).superRefine((credentials, ctx) => {
  const envs = new Map<string, number>();
  const headers = new Map<string, number>();
  credentials.forEach((credential, i) => {
    const holder = envs.get(credential.env);
    if (holder === undefined) {
      envs.set(credential.env, i);
    } else {
      ctx.addIssue({
        code: "custom",
        path: [i, "env"],
        message: `${credential.env} is already set by credentials.${holder}`,
      });
    }
    for (const domain of credential.domains) {
      const slot = `${domain} ${credential.header.toLowerCase()}`;
      const setter = headers.get(slot);
      if (setter === undefined) {
        headers.set(slot, i);
      } else {
        ctx.addIssue({
          code: "custom",
          path: [i, "domains"],
          message: `${credential.header} on ${domain} is already set by credentials.${setter}`,
        });
      }
    }
  });
});
export type Credentials = z.infer<typeof Credentials>;
