// The in-memory SecretProvider: the conformance suite, plus the one thing
// only this adapter has — an injectable clock.

import { describe, expect, test } from "vitest";
import { createMemorySecretProvider } from "../src/secrets/memory";
import { describeSecretProviderConformance } from "./secret-provider-conformance";

describeSecretProviderConformance("memory", async () => createMemorySecretProvider());

describe("createMemorySecretProvider", () => {
  test("stamps puts from the injected clock", async () => {
    let at = Date.parse("2026-10-21T00:00:00.000Z");
    const secrets = createMemorySecretProvider({ now: () => new Date(at) });
    const ref = { namespace: "default", name: "stripe-live" };

    await secrets.put(ref, "sk_live_1");
    at += 60_000;
    expect(await secrets.put(ref, "sk_live_2")).toEqual({
      name: "stripe-live",
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:01:00.000Z",
    });
  });
});
