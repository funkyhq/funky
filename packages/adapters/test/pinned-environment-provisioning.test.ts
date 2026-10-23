// The pinned environment end to end: the real pg store, the real
// ensureSandbox, and a fake provider that records what each create was
// asked to enforce. The invariant under test is the whole point of
// pinning — an agent config edit reaches sessions created after it and
// nothing else, including across a sandbox replacement, which is the one
// moment a running session provisions a second time. Credentials' keys
// are read at that moment too: a new key reaches a replacement sandbox,
// never one already running.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Credential,
  DEFAULT_NAMESPACE,
  type NetworkPolicy,
  type SessionRef,
} from "@funky/core";
import {
  type CreateSandboxOptions,
  ensureSandbox,
  resolveCredentials,
  type Sandbox,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxProvisionError,
  type SecretProvider,
  type Store,
} from "@funky/agent";
import { createMemorySecretProvider, createPgStore, type StoreDb } from "../src";
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
  secrets: SecretProvider | null = null,
): Promise<{ sandboxId: string; network: NetworkPolicy }> {
  const session = await store.getSession(ref);
  if (!session) throw new Error("no session");
  const config = await store.getAgentConfig({
    namespace: session.namespace,
    agentConfigId: session.agentConfigId,
    version: session.agentConfigVersion,
  });
  if (!config) throw new Error("no agent config");
  const sandbox = await ensureSandbox(store, provider, ref, async () => ({
    network: config.network,
    packages: config.packages,
    credentials: await resolveCredentials(secrets, session.namespace, config.credentials),
  }));
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

  it("reads a credential's key when a sandbox is created, and only then", async () => {
    const STRIPE: Credential = {
      type: "injected",
      env: "STRIPE_API_KEY",
      secret: "stripe-live",
      domains: ["api.stripe.com"],
      header: "Authorization",
      value: "Bearer {secret}",
    };
    const secrets = createMemorySecretProvider();
    const stored = { namespace: DEFAULT_NAMESPACE, name: "stripe-live" };
    await secrets.put(stored, "sk_1");
    const agent = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [STRIPE],
    });
    const newSession = () =>
      store.createSession({ namespace: DEFAULT_NAMESPACE, agentConfigId: agent.agentConfigId });
    const { provider, created, kill } = fakeProvider();

    // 1. session 1's sandbox gets the key as it stands.
    const s1 = await newSession();
    const first = await provision(s1, provider, secrets);
    expect(created[0]?.credentials).toEqual([{ credential: STRIPE, key: "sk_1" }]);

    // 2. a new key doesn't reach the sandbox session 1 has...
    await secrets.put(stored, "sk_2");
    await provision(s1, provider, secrets);
    expect(created).toHaveLength(1);

    // 3. ...only its replacement.
    kill(first.sandboxId);
    await provision(s1, provider, secrets);
    expect(created[1]?.credentials).toEqual([{ credential: STRIPE, key: "sk_2" }]);

    // 4. with the key deleted, a new session's first sandbox is refused,
    //    and nothing is created or bound.
    await secrets.delete(stored);
    const s2 = await newSession();
    const refused = provision(s2, provider, secrets);
    await expect(refused).rejects.toBeInstanceOf(SandboxProvisionError);
    await expect(refused).rejects.toThrow("secret not found: stripe-live");
    expect(created).toHaveLength(2);
    expect((await store.getSession(s2))?.sandboxId).toBeUndefined();
  });
});
