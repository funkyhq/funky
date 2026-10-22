// The pinned environment end to end: the real pg store, the real
// ensureSandbox, and a fake provider that records what each create was
// asked to enforce. The invariant under test is the whole point of
// pinning — an agent config edit reaches sessions created after it and
// nothing else, including across a sandbox replacement, which is the one
// moment a running session provisions a second time.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_NAMESPACE, type NetworkPolicy, type SessionRef } from "@funky/core";
import {
  type CreateSandboxOptions,
  ensureSandbox,
  type Sandbox,
  SandboxNotFoundError,
  type SandboxProvider,
  type Store,
} from "@funky/agent";
import { createPgStore, type StoreDb } from "../src";
import { storeDdl } from "./store-ddl";

let client: PGlite;
let store: Store;

// Booting PGlite can outlast the 10s default when crash-resume's
// subprocesses share the CPU.
beforeAll(async () => {
  client = new PGlite();
  await client.exec(storeDdl);
  store = createPgStore(drizzle({ client }) as unknown as StoreDb);
}, 60_000);

afterAll(async () => {
  await client.close();
});

/** Hands out a fresh id per create, and can declare any id dead so the
 *  next acquire has to replace it — the sandbox-restart path. */
function fakeProvider() {
  const created: CreateSandboxOptions[] = [];
  const dead = new Set<string>();
  let n = 0;
  const provider: SandboxProvider = {
    create: async (opts) => {
      created.push(opts ?? {});
      return { sandboxId: `sbx_${++n}`, kill: async () => {} } as Sandbox;
    },
    connect: async (sandboxId) => {
      if (dead.has(sandboxId)) throw new SandboxNotFoundError(`${sandboxId} is gone`);
      return { sandboxId } as Sandbox;
    },
    list: async () => [],
  };
  return { provider, created, kill: (id: string) => dead.add(id) };
}

/** What the worker's bindTools does: read the session, provision from
 *  the agent config version it pinned. */
async function provision(
  ref: SessionRef,
  provider: SandboxProvider,
): Promise<{ sandboxId: string; network: NetworkPolicy }> {
  const session = await store.getSession(ref);
  if (!session) throw new Error("no session");
  const config = await store.getAgentConfig({
    namespace: session.namespace,
    agentConfigId: session.agentConfigId,
    version: session.agentConfigVersion,
  });
  if (!config) throw new Error("no agent config");
  const sandbox = await ensureSandbox(store, provider, ref, {
    network: config.network,
    packages: config.packages,
  });
  return { sandboxId: sandbox.sandboxId, network: config.network };
}

describe("provisioning from the session's pinned agent config version", () => {
  it("holds session 1 to its version across an agent update and a sandbox restart", async () => {
    const agent = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
      network: { type: "none" },
      packages: { pip: ["numpy"] },
      credentials: [],
    });
    const newSession = (agentConfigVersion?: number) =>
      store.createSession({
        namespace: DEFAULT_NAMESPACE,
        agentConfigId: agent.agentConfigId,
        ...(agentConfigVersion === undefined ? {} : { agentConfigVersion }),
      });

    // 1. session 1 pins version 1 and has provisioned once.
    const s1 = await newSession();
    const { provider, created, kill } = fakeProvider();
    const first = await provision(s1, provider);
    expect(first.network).toEqual({ type: "none" });
    expect(created[0]).toMatchObject({ network: { type: "none" }, packages: { pip: ["numpy"] } });

    // 2. the agent config is updated underneath it — a new version 2.
    await store.updateAgentConfig(agent, {
      network: { type: "allowlist", domains: ["example.com"] },
      packages: { npm: ["zod"] },
    });

    // 3. session 1's sandbox dies; the next claim must replace it. The
    //    replacement is provisioned from version 1, not the new one.
    kill(first.sandboxId);
    const replaced = await provision(s1, provider);
    expect(replaced.sandboxId).not.toBe(first.sandboxId); // really a new sandbox
    expect(created[1]).toMatchObject({ network: { type: "none" }, packages: { pip: ["numpy"] } });
    expect((await store.getSession(s1))?.agentConfigVersion).toBe(1);

    // 4. session 2, created after the update, pins version 2.
    const s2 = await newSession();
    const second = await provision(s2, provider);
    expect(second.network).toEqual({ type: "allowlist", domains: ["example.com"] });
    expect(created[2]).toMatchObject({
      network: { type: "allowlist", domains: ["example.com"] },
      packages: { npm: ["zod"] },
    });

    // 5. a session may still ask for the old version explicitly.
    const s3 = await newSession(1);
    expect((await provision(s3, provider)).network).toEqual({ type: "none" });

    // Reconnecting a live sandbox provisions nothing at all — four creates
    // across the whole scenario, never a fifth.
    await provision(s1, provider);
    expect(created).toHaveLength(4);
  });
});
