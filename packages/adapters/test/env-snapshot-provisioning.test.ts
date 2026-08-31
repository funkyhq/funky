// The env config snapshot end to end: the real pg store, the real
// ensureSandbox, and a fake provider that records what each create was
// asked to enforce. The invariant under test is the whole point of the
// snapshot — an env config edit reaches sessions created after it and
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

beforeAll(async () => {
  client = new PGlite();
  await client.exec(storeDdl);
  store = createPgStore(drizzle({ client }) as unknown as StoreDb);
});

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
 *  the snapshot it carries. Deliberately never touches getEnvConfig. */
async function provision(
  ref: SessionRef,
  provider: SandboxProvider,
): Promise<{ sandboxId: string; network: NetworkPolicy }> {
  const session = await store.getSession(ref);
  if (!session) throw new Error("no session");
  const sandbox = await ensureSandbox(store, provider, ref, {
    network: session.envConfigSnapshot.network,
  });
  return { sandboxId: sandbox.sandboxId, network: session.envConfigSnapshot.network };
}

describe("provisioning from the session's env snapshot", () => {
  it("holds session 1 to its own recipe across an env update and a sandbox restart", async () => {
    const agent = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
    });
    const env = await store.createEnvConfig({
      namespace: DEFAULT_NAMESPACE,
      network: { type: "none" },
      packages: { pip: ["numpy"] },
    });
    const newSession = () =>
      store.createSession({
        namespace: DEFAULT_NAMESPACE,
        agentConfigId: agent.agentConfigId,
        envConfigId: env.envConfigId,
      });

    // 1. session 1 exists and has provisioned once.
    const s1 = await newSession();
    const { provider, created, kill } = fakeProvider();
    const first = await provision(s1, provider);
    expect(first.network).toEqual({ type: "none" });
    expect(created[0]?.network).toEqual({ type: "none" });

    // 2. the env config is updated underneath it.
    await store.updateEnvConfig(env, {
      network: { type: "allowlist", domains: ["example.com"] },
      packages: { npm: ["zod"] },
    });

    // 3. session 1's sandbox dies; the next claim must replace it. The
    //    replacement is provisioned from the snapshot, not the new recipe.
    kill(first.sandboxId);
    const replaced = await provision(s1, provider);
    expect(replaced.sandboxId).not.toBe(first.sandboxId); // really a new sandbox
    expect(created[1]?.network).toEqual({ type: "none" });
    expect((await store.getSession(s1))?.envConfigSnapshot).toEqual({
      network: { type: "none" },
      packages: { pip: ["numpy"] },
    });

    // 4. session 2, created after the update, gets the new recipe.
    const s2 = await newSession();
    const second = await provision(s2, provider);
    expect(second.network).toEqual({ type: "allowlist", domains: ["example.com"] });
    expect(created[2]?.network).toEqual({ type: "allowlist", domains: ["example.com"] });
    expect((await store.getSession(s2))?.envConfigSnapshot).toEqual({
      network: { type: "allowlist", domains: ["example.com"] },
      packages: { npm: ["zod"] },
    });

    // Reconnecting a live sandbox provisions nothing at all — three
    // creates across the whole scenario, never a fourth.
    await provision(s1, provider);
    expect(created).toHaveLength(3);
  });
});
