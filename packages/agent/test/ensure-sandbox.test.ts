// ensure-on-claim over a fake provider: find by session metadata and
// connect (which revives), create stamped with the session id when
// nothing exists, and converge deterministically when a race left two.

import { describe, expect, test } from "vitest";
import { ensureSandbox } from "../src/driver/ensure-sandbox";
import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
} from "../src/ports/sandbox-provider";

function stub(sandboxId: string): Sandbox {
  return { sandboxId } as Sandbox;
}

function fakeProvider(existing: SandboxInfo[]) {
  const calls = {
    list: [] as ({ metadata?: Record<string, string> } | undefined)[],
    connect: [] as string[],
    create: [] as (CreateSandboxOptions | undefined)[],
  };
  const provider: SandboxProvider = {
    create: async (opts) => {
      calls.create.push(opts);
      return stub("sbx_created");
    },
    connect: async (sandboxId) => {
      calls.connect.push(sandboxId);
      return stub(sandboxId);
    },
    list: async (filter) => {
      calls.list.push(filter);
      return existing;
    },
  };
  return { provider, calls };
}

const info = (sandboxId: string): SandboxInfo => ({
  sandboxId,
  state: "paused",
  metadata: { sessionId: "s1" },
});

describe("ensureSandbox", () => {
  test("connects to the sandbox found by session metadata", async () => {
    const { provider, calls } = fakeProvider([info("sbx_a")]);

    const sandbox = await ensureSandbox(provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_a");
    expect(calls.list).toEqual([{ metadata: { sessionId: "s1" } }]);
    expect(calls.connect).toEqual(["sbx_a"]);
    expect(calls.create).toEqual([]);
  });

  test("creates with the session stamped into metadata when none exists", async () => {
    const { provider, calls } = fakeProvider([]);

    const sandbox = await ensureSandbox(provider, "s1", {
      timeoutMs: 60_000,
      network: { type: "none" },
      metadata: { tier: "test" },
    });
    expect(sandbox.sandboxId).toBe("sbx_created");
    expect(calls.connect).toEqual([]);
    expect(calls.create).toEqual([
      {
        timeoutMs: 60_000,
        network: { type: "none" },
        metadata: { tier: "test", sessionId: "s1" },
      },
    ]);
  });

  test("converges on the lexicographically first sandbox when a race left two", async () => {
    const { provider, calls } = fakeProvider([info("sbx_z"), info("sbx_a")]);

    const sandbox = await ensureSandbox(provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_a");
    expect(calls.connect).toEqual(["sbx_a"]);
    expect(calls.create).toEqual([]);
  });
});
