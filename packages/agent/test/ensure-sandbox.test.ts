// ensure-on-claim over fakes: connect when the Store already registered
// the session's sandbox, create-and-register when none exists, kill the
// duplicate and join the winner when the registration CAS is lost, and
// replace a binding only when the provider says it is definitively gone.

import { describe, expect, test } from "vitest";
import type { Session } from "@funky/core";
import { ensureSandbox } from "../src/driver/ensure-sandbox";
import {
  type CreateSandboxOptions,
  type Sandbox,
  SandboxNotFoundError,
  type SandboxProvider,
} from "../src/ports/sandbox-provider";

function fakeProvider(opts?: { deadIds?: string[]; connectError?: Error }) {
  const calls = { connect: [] as string[], create: [] as (CreateSandboxOptions | undefined)[] };
  let killed = 0;
  const provider: SandboxProvider = {
    create: async (createOpts) => {
      calls.create.push(createOpts);
      return {
        sandboxId: "sbx_created",
        kill: async () => {
          killed++;
        },
      } as Sandbox;
    },
    connect: async (sandboxId) => {
      calls.connect.push(sandboxId);
      if (opts?.connectError) throw opts.connectError;
      if (opts?.deadIds?.includes(sandboxId)) {
        throw new SandboxNotFoundError(`sandbox ${sandboxId} not found`);
      }
      return { sandboxId } as Sandbox;
    },
    list: async () => [],
  };
  return { provider, calls, killed: () => killed };
}

function fakeStore(opts?: { sandboxId?: string; winner?: string }) {
  const binds: { candidate: string; previous?: string }[] = [];
  const session: Session = {
    id: "s1",
    agentConfigId: "a1",
    agentConfigVersion: 1,
    envConfigId: "e1",
    namespace: "default",
    createdAt: "2026-08-18T00:00:00.000Z",
    ...(opts?.sandboxId ? { sandboxId: opts.sandboxId } : {}),
  };
  return {
    binds,
    getSession: async (id: string) => (id === "s1" ? session : undefined),
    bindSandbox: async (_sessionId: string, candidate: string, previous?: string) => {
      binds.push({ candidate, previous });
      return opts?.winner ?? candidate;
    },
  };
}

describe("ensureSandbox", () => {
  test("connects to the registered sandbox without creating or binding", async () => {
    const store = fakeStore({ sandboxId: "sbx_bound" });
    const { provider, calls } = fakeProvider();

    const sandbox = await ensureSandbox(store, provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_bound");
    expect(calls.connect).toEqual(["sbx_bound"]);
    expect(calls.create).toEqual([]);
    expect(store.binds).toEqual([]);
  });

  test("throws on an unknown session", async () => {
    const { provider } = fakeProvider();
    await expect(ensureSandbox(fakeStore(), provider, "nope")).rejects.toThrow("unknown session");
  });

  test("creates, stamps the session into metadata, and registers", async () => {
    const store = fakeStore();
    const { provider, calls, killed } = fakeProvider();

    const sandbox = await ensureSandbox(store, provider, "s1", {
      timeoutMs: 60_000,
      network: { type: "none" },
      metadata: { tier: "test" },
    });
    expect(sandbox.sandboxId).toBe("sbx_created");
    expect(calls.create).toEqual([
      {
        timeoutMs: 60_000,
        network: { type: "none" },
        metadata: { tier: "test", sessionId: "s1" },
      },
    ]);
    expect(store.binds).toEqual([{ candidate: "sbx_created", previous: undefined }]);
    expect(calls.connect).toEqual([]);
    expect(killed()).toBe(0);
  });

  test("kills its duplicate and joins the winner when the CAS is lost", async () => {
    const store = fakeStore({ winner: "sbx_theirs" });
    const { provider, calls, killed } = fakeProvider();

    const sandbox = await ensureSandbox(store, provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_theirs");
    expect(store.binds).toEqual([{ candidate: "sbx_created", previous: undefined }]);
    expect(killed()).toBe(1);
    expect(calls.connect).toEqual(["sbx_theirs"]);
  });

  test("replaces a binding the provider reports definitively gone", async () => {
    const store = fakeStore({ sandboxId: "sbx_dead" });
    const { provider, calls, killed } = fakeProvider({ deadIds: ["sbx_dead"] });

    const sandbox = await ensureSandbox(store, provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_created");
    expect(calls.connect).toEqual(["sbx_dead"]);
    // The CAS names the dead binding it expects to replace.
    expect(store.binds).toEqual([{ candidate: "sbx_created", previous: "sbx_dead" }]);
    expect(killed()).toBe(0);
  });

  test("joins whoever replaced the dead binding first", async () => {
    const store = fakeStore({ sandboxId: "sbx_dead", winner: "sbx_theirs" });
    const { provider, calls, killed } = fakeProvider({ deadIds: ["sbx_dead"] });

    const sandbox = await ensureSandbox(store, provider, "s1");
    expect(sandbox.sandboxId).toBe("sbx_theirs");
    expect(store.binds).toEqual([{ candidate: "sbx_created", previous: "sbx_dead" }]);
    expect(killed()).toBe(1);
    expect(calls.connect).toEqual(["sbx_dead", "sbx_theirs"]);
  });

  test("propagates a transient connect failure without touching the binding", async () => {
    const store = fakeStore({ sandboxId: "sbx_bound" });
    const { provider, calls } = fakeProvider({ connectError: new Error("fetch failed") });

    await expect(ensureSandbox(store, provider, "s1")).rejects.toThrow("fetch failed");
    expect(calls.create).toEqual([]);
    expect(store.binds).toEqual([]);
  });
});
