// Read the keys an agent config's credentials name, for the sandbox
// create that delivers them: the one place a key leaves the secret
// store. The worker calls it from ensureSandbox's create options, so
// only a create pays for the read, and pays once: one resolve for every
// name the credentials use.
//
// What it throws decides the run. A key the store doesn't have, or no
// store at all, is a SandboxProvisionError, and the driver ends the run
// with the reason in the batch's results, as for a package that won't
// install: the session's pinned config asks for the same key on every
// claim, so retrying can't help until someone puts it. Anything else
// (the store unreachable, a rate limit) is rethrown as it is, taking the
// bind's crash path like a sandbox provider's outage.

import type { Credential } from "@funky/core";
import { type ResolvedCredential, SandboxProvisionError } from "../ports/sandbox-provider";
import { SecretNotFoundError, type SecretProvider } from "../ports/secret-provider";

export async function resolveCredentials(
  secrets: SecretProvider | null,
  namespace: string,
  credentials: readonly Credential[],
): Promise<ResolvedCredential[]> {
  if (credentials.length === 0) return [];
  if (secrets === null) {
    throw new SandboxProvisionError(
      "no secret store configured: the agent config's credentials need one",
    );
  }
  const names = [...new Set(credentials.map((credential) => credential.secret))];
  const keys = await secrets.resolve(namespace, names).catch((error: unknown) => {
    if (error instanceof SecretNotFoundError) {
      const noun = error.names.length === 1 ? "secret" : "secrets";
      throw new SandboxProvisionError(`${noun} not found: ${error.names.join(", ")}`);
    }
    throw error;
  });
  return credentials.map((credential) => {
    const key = keys.get(credential.secret);
    // The port promises every name or SecretNotFoundError. An adapter
    // breaking that is a bug, and never a sandbox created without a key.
    if (key === undefined) throw new Error(`resolveCredentials: no value for ${credential.secret}`);
    return { credential, key };
  });
}
