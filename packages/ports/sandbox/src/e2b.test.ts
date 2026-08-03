// The e2b wrapper's whole job is disambiguating the base provider's swallowed-into-null
// getById (see drivers/e2b.ts). These pin the three probe outcomes on the null path and
// that a live base result skips the probe entirely.

import { SandboxNotFoundError } from "e2b";
import type { SandboxInterface } from "computesdk";
import { describe, expect, it } from "vitest";
import type { ComputeProvider } from "./drivers/computesdk";
import { withProbedGetById } from "./drivers/e2b";

function baseReturning(result: SandboxInterface | null): ComputeProvider {
  return {
    name: "e2b",
    sandbox: {
      create: async () => {
        throw new Error("create is not under test");
      },
      getById: async () => result,
      destroy: async () => {},
    },
  };
}

const liveSandbox = { sandboxId: "sb-1", provider: "e2b" } as unknown as SandboxInterface;

describe("e2b withProbedGetById", () => {
  it("a live base result passes through without probing", async () => {
    let probed = false;
    const provider = withProbedGetById(baseReturning(liveSandbox), async () => {
      probed = true;
    });
    expect(await provider.sandbox.getById("sb-1")).toBe(liveSandbox);
    expect(probed).toBe(false);
  });

  it("null + probe 404 → null (positively gone)", async () => {
    const provider = withProbedGetById(baseReturning(null), async (id) => {
      throw new SandboxNotFoundError(`sandbox ${id} not found`);
    });
    expect(await provider.sandbox.getById("sb-1")).toBeNull();
  });

  it("null + probe transport failure → rejects (unreachable, NOT gone)", async () => {
    const provider = withProbedGetById(baseReturning(null), async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(provider.sandbox.getById("sb-1")).rejects.toThrow("ETIMEDOUT");
  });

  it("null + probe success → rejects (the base's null was a swallowed blip)", async () => {
    const provider = withProbedGetById(baseReturning(null), async () => {});
    await expect(provider.sandbox.getById("sb-1")).rejects.toThrow(
      "exists but the provider could not attach",
    );
  });
});
