// resolveCredentials over a fake secret store: one resolve for every name
// the credentials use, each credential handed back with its key; a key
// the store doesn't have, or no store at all, is a SandboxProvisionError
// (the run ends), and any other failure passes through untyped (the
// crash path).

import { describe, expect, test } from "vitest";
import type { Credential } from "@funky/core";
import { resolveCredentials } from "../src/driver/resolve-credentials";
import { SandboxProvisionError } from "../src/ports/sandbox-provider";
import { SecretNotFoundError, type SecretProvider } from "../src/ports/secret-provider";

const STRIPE: Credential = {
  type: "injected",
  env: "STRIPE_API_KEY",
  secret: "stripe-live",
  domains: ["api.stripe.com"],
  header: "Authorization",
  value: "Bearer {secret}",
};
const GITHUB: Credential = {
  type: "injected",
  env: "GH_TOKEN",
  secret: "github",
  domains: ["api.github.com"],
  header: "Authorization",
  value: "Bearer {secret}",
};
// The same key as STRIPE, under another env and header.
const STRIPE_FILES: Credential = {
  ...STRIPE,
  env: "STRIPE_FILES_KEY",
  domains: ["files.stripe.com"],
  header: "X-Api-Key",
  value: "{secret}",
};

/** A store holding `stored`, recording each resolve; `failure` makes
 *  every resolve throw it instead. */
function fakeSecrets(stored: Record<string, string>, failure?: Error) {
  const resolves: { namespace: string; names: readonly string[] }[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("resolveCredentials only resolves");
  };
  const secrets: SecretProvider = {
    put: unused,
    delete: unused,
    list: unused,
    resolve: async (namespace, names) => {
      resolves.push({ namespace, names });
      if (failure) throw failure;
      const found = new Map(Object.entries(stored).filter(([name]) => names.includes(name)));
      const missing = names.filter((name) => !found.has(name));
      if (missing.length > 0) throw new SecretNotFoundError(namespace, missing);
      return found;
    },
  };
  return { secrets, resolves };
}

describe("resolveCredentials", () => {
  test("hands back each credential with its key, from one resolve", async () => {
    // The store answers in its own order, not the order asked.
    const { secrets, resolves } = fakeSecrets({
      github: "ghp_1",
      unrelated: "x",
      "stripe-live": "sk_live_1",
    });

    const resolved = await resolveCredentials(secrets, "tenant-a", [STRIPE, GITHUB, STRIPE_FILES]);
    expect(resolved).toEqual([
      { credential: STRIPE, key: "sk_live_1" },
      { credential: GITHUB, key: "ghp_1" },
      { credential: STRIPE_FILES, key: "sk_live_1" },
    ]);
    // Each name asked for once, in the namespace given.
    expect(resolves).toEqual([{ namespace: "tenant-a", names: ["stripe-live", "github"] }]);
  });

  test("reads nothing when there are no credentials, store or not", async () => {
    const { secrets, resolves } = fakeSecrets({});
    expect(await resolveCredentials(secrets, "tenant-a", [])).toEqual([]);
    expect(resolves).toEqual([]);
    expect(await resolveCredentials(null, "tenant-a", [])).toEqual([]);
  });

  test("ends the run when a key is not in the store", async () => {
    const { secrets } = fakeSecrets({ "stripe-live": "sk_live_1" });

    const one = resolveCredentials(secrets, "tenant-a", [STRIPE, GITHUB]);
    await expect(one).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(one).rejects.toThrow(/^secret not found: github$/);

    const { secrets: empty } = fakeSecrets({});
    await expect(resolveCredentials(empty, "tenant-a", [STRIPE, GITHUB])).rejects.toThrow(
      /^secrets not found: stripe-live, github$/,
    );
  });

  test("ends the run when there is no store to read from", async () => {
    const run = resolveCredentials(null, "tenant-a", [STRIPE]);
    await expect(run).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(run).rejects.toThrow(
      "no secret store configured: the agent config's credentials need one",
    );
  });

  test("passes any other failure through untyped", async () => {
    const outage = new Error("Infisical answered 503");
    const { secrets } = fakeSecrets({ "stripe-live": "sk_live_1" }, outage);
    await expect(resolveCredentials(secrets, "tenant-a", [STRIPE])).rejects.toBe(outage);
  });

  test("refuses a store that answers without a key it was asked for", async () => {
    const { secrets } = fakeSecrets({});
    secrets.resolve = async () => new Map();

    const run = resolveCredentials(secrets, "tenant-a", [STRIPE]);
    await expect(run).rejects.toThrow("resolveCredentials: no value for stripe-live");
    await expect(run).rejects.not.toBeInstanceOf(SandboxProvisionError);
  });
});
