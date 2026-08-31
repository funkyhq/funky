// The Store conformance suite — the port's jsdoc contract as executable
// tests, written against the interface via a factory. Every adapter and
// every binding runs this identical suite; what it pins is contract, what
// it doesn't pin is implementation freedom.
//
// The harness provides a controllable clock so lease expiry is tested by
// advancing time, never by sleeping.

import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentConfigRef,
  type AssistantMessage,
  type CreateAgentConfigRequest,
  type CreateEnvConfigRequest,
  DEFAULT_NAMESPACE,
  type EnvConfigRef,
  type SessionRef,
  type UserMessage,
  type WorkItemRef,
} from "@funky/core";
import {
  ArchivedError,
  type CommitStepRequest,
  FencedError,
  type Store,
  VersionConflictError,
} from "@funky/agent";

export interface StoreHarness {
  store: Store;
  clock: { advance(ms: number): void };
}

const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "test-model",
  stopReason: "end_turn",
});

export function describeStoreConformance(
  name: string,
  makeHarness: () => Promise<StoreHarness>,
): void {
  describe(`Store conformance: ${name}`, () => {
    let store: Store;
    let clock: StoreHarness["clock"];

    beforeEach(async () => {
      ({ store, clock } = await makeHarness());
    });

    async function newAgent(
      overrides: Partial<CreateAgentConfigRequest> = {},
    ): Promise<AgentConfigRef> {
      return store.createAgentConfig({
        namespace: DEFAULT_NAMESPACE,
        inference: { provider: "fake", model: "m" },
        systemPrompt: "s",
        ...overrides,
      });
    }

    async function newEnv(overrides: Partial<CreateEnvConfigRequest> = {}): Promise<EnvConfigRef> {
      return store.createEnvConfig({
        namespace: DEFAULT_NAMESPACE,
        ...overrides,
      });
    }

    async function newSession(): Promise<SessionRef> {
      const agentConfigRef = await newAgent({
        inference: { provider: "fake", model: "scripted" },
      });
      const envConfigRef = await newEnv();
      return store.createSession({
        namespace: DEFAULT_NAMESPACE,
        agentConfigId: agentConfigRef.agentConfigId,
        envConfigId: envConfigRef.envConfigId,
      });
    }

    /** intake must have started a run; returns the claimed item + token.
     *  The claimed row IS its own WorkItemRef — passed on unrebuilt. */
    async function startAndClaim(
      ref: SessionRef,
    ): Promise<{ itemRef: WorkItemRef; token: string }> {
      const result = await store.intake(ref, user("go"));
      expect(result.kind).toBe("started");
      const claim = await store.claimItem({ leaseMs: 60_000, session: ref });
      expect(claim).toBeDefined();
      return { itemRef: claim!.item, token: claim!.token };
    }

    describe("configs", () => {
      it("round-trips an agent config through create and get", async () => {
        const ref = await store.createAgentConfig({
          namespace: DEFAULT_NAMESPACE,
          inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
          systemPrompt: "You are helpful.",
          metadata: { team: "growth" },
        });
        const config = await store.getAgentConfig(ref);
        expect(config).toMatchObject({
          agentConfigId: ref.agentConfigId,
          namespace: ref.namespace,
          inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
          systemPrompt: "You are helpful.",
          metadata: { team: "growth" },
        });
        expect(config?.createdAt).toMatch(/T.*Z$/);
        expect(config?.version).toBe(1);
        expect(await store.getAgentConfig({ ...ref, version: 1 })).toEqual(config);
      });

      it("stores absence as absence — no metadata or sampling keys materialize", async () => {
        const ref = await newAgent();
        const config = await store.getAgentConfig(ref);
        expect(config).toBeDefined();
        expect("metadata" in config!).toBe(false);
        expect("maxTokens" in config!.inference).toBe(false);
        expect("temperature" in config!.inference).toBe(false);
      });

      it("keeps JSON null metadata distinct from absent metadata", async () => {
        const ref = await newAgent({ metadata: null });
        const config = await store.getAgentConfig(ref);
        expect(config).toBeDefined();
        expect("metadata" in config!).toBe(true);
        expect(config!.metadata).toBeNull();
      });

      it("rejects an invalid create request at the boundary", async () => {
        await expect(
          store.createAgentConfig({
            namespace: DEFAULT_NAMESPACE,
            // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
            inference: "claude-sonnet-5" as any,
            systemPrompt: "s",
          }),
        ).rejects.toThrow();
      });

      it("partially updates an agent config, preserving omitted fields and its identity", async () => {
        const ref = await newAgent({
          inference: { provider: "anthropic", model: "old-model", maxTokens: 1024 },
          systemPrompt: "old prompt",
          metadata: { team: "growth" },
        });
        const before = await store.getAgentConfig(ref);
        clock.advance(1_000);

        const updated = await store.updateAgentConfig(ref, {
          systemPrompt: "new prompt",
          version: 1,
        });

        expect(updated).toMatchObject({
          agentConfigId: ref.agentConfigId,
          inference: { provider: "anthropic", model: "old-model", maxTokens: 1024 },
          systemPrompt: "new prompt",
          metadata: { team: "growth" },
          namespace: DEFAULT_NAMESPACE,
          version: 2,
          createdAt: before?.createdAt,
        });
        expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
        expect(await store.getAgentConfig(ref)).toEqual(updated);
      });

      it("updates unconditionally when version is omitted", async () => {
        const ref = await newAgent();
        const first = await store.updateAgentConfig(ref, { systemPrompt: "one" });
        const second = await store.updateAgentConfig(ref, {
          inference: { provider: "fake", model: "m2" },
        });
        expect(first?.version).toBe(2);
        expect(second).toMatchObject({ version: 3, systemPrompt: "one" });
      });

      it("serializes concurrent unconditional partial updates", async () => {
        const ref = await newAgent();

        const updates = await Promise.all([
          store.updateAgentConfig(ref, { systemPrompt: "new prompt" }),
          store.updateAgentConfig(ref, { inference: { provider: "fake", model: "m2" } }),
        ]);

        expect(updates.map((config) => config?.version).sort()).toEqual([2, 3]);
        expect(await store.getAgentConfig(ref)).toMatchObject({
          inference: { provider: "fake", model: "m2" },
          systemPrompt: "new prompt",
          version: 3,
        });
      });

      it("treats an update with no mutable fields as a version-checked no-op", async () => {
        const ref = await newAgent();
        const before = await store.getAgentConfig(ref);
        expect(await store.updateAgentConfig(ref, { version: 1 })).toEqual(before);
        expect(await store.updateAgentConfig(ref, {})).toEqual(before);
      });

      it("rejects a stale expected version without changing the config", async () => {
        const ref = await newAgent();
        await store.updateAgentConfig(ref, { systemPrompt: "winner", version: 1 });

        await expect(
          store.updateAgentConfig(ref, { systemPrompt: "stale", version: 1 }),
        ).rejects.toMatchObject({
          name: "VersionConflictError",
          expectedVersion: 1,
          actualVersion: 2,
        });
        expect((await store.getAgentConfig(ref))?.systemPrompt).toBe("winner");
      });

      it("keeps every prior agent version as an immutable snapshot", async () => {
        const ref = await newAgent({
          inference: { provider: "fake", model: "m1" },
          systemPrompt: "v1",
          metadata: { revision: 1 },
        });
        const v1 = await store.getAgentConfig({ ...ref, version: 1 });
        await store.updateAgentConfig(ref, {
          inference: { provider: "fake", model: "m2" },
          systemPrompt: "v2",
          version: 1,
        });
        await store.updateAgentConfig(ref, { metadata: { revision: 3 }, version: 2 });

        expect(await store.getAgentConfig({ ...ref, version: 1 })).toEqual(v1);
        expect(await store.getAgentConfig({ ...ref, version: 2 })).toMatchObject({
          inference: { provider: "fake", model: "m2" },
          systemPrompt: "v2",
          metadata: { revision: 1 },
          version: 2,
        });
        expect(await store.getAgentConfig({ ...ref, version: 3 })).toEqual(
          await store.getAgentConfig(ref),
        );
        expect(await store.getAgentConfig({ ...ref, version: 4 })).toBeUndefined();
        expect(
          await store.getAgentConfig({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: "nope",
            version: 1,
          }),
        ).toBeUndefined();
      });

      it("lets exactly one concurrent update satisfy the same version", async () => {
        const ref = await newAgent();
        const results = await Promise.allSettled([
          store.updateAgentConfig(ref, { systemPrompt: "a", version: 1 }),
          store.updateAgentConfig(ref, { systemPrompt: "b", version: 1 }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected).toMatchObject({ reason: expect.any(VersionConflictError) });
        expect((await store.getAgentConfig(ref))?.version).toBe(2);
      });

      it("treats an unknown or foreign update target as absent", async () => {
        const ref = await newAgent({ namespace: "tenant-a" });
        await expect(
          store.updateAgentConfig(
            { namespace: "tenant-a", agentConfigId: "nope" },
            { systemPrompt: "x" },
          ),
        ).resolves.toBeUndefined();
        await expect(
          store.updateAgentConfig(
            { namespace: "tenant-b", agentConfigId: ref.agentConfigId },
            { systemPrompt: "x" },
          ),
        ).resolves.toBeUndefined();
        expect((await store.getAgentConfig(ref))?.systemPrompt).toBe("s");
      });

      it("rejects an invalid update request at the boundary", async () => {
        const ref = await newAgent();
        await expect(
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
          store.updateAgentConfig(ref, { version: 0 } as any),
        ).rejects.toThrow();
      });

      it("materializes network and packages at env config create", async () => {
        const ref = await newEnv();
        const config = await store.getEnvConfig(ref);
        expect(config?.network).toEqual({ type: "unrestricted" });
        expect(config?.packages).toEqual({});
      });

      it("preserves a provided recipe verbatim", async () => {
        const ref = await newEnv({
          network: { type: "allowlist", domains: ["pypi.org"] },
          packages: { pip: ["pandas==2.2.0"] },
        });
        const config = await store.getEnvConfig(ref);
        expect(config?.network).toEqual({ type: "allowlist", domains: ["pypi.org"] });
        expect(config?.packages).toEqual({ pip: ["pandas==2.2.0"] });
      });

      it("partially updates an env config in place while preserving its identity", async () => {
        const ref = await newEnv({
          network: { type: "allowlist", domains: ["pypi.org"] },
          packages: { pip: ["pandas==2.2.0"] },
          metadata: { stage: "initial" },
        });
        const before = await store.getEnvConfig(ref);

        const withPackages = await store.updateEnvConfig(ref, {
          packages: { npm: ["zod@4"] },
        });
        expect(withPackages).toEqual({
          ...before,
          packages: { npm: ["zod@4"] },
        });

        const updated = await store.updateEnvConfig(ref, {
          network: { type: "none" },
          metadata: null,
        });
        expect(updated).toEqual({
          ...withPackages,
          network: { type: "none" },
          metadata: null,
        });
        expect(await store.getEnvConfig(ref)).toEqual(updated);
      });

      it("treats an empty env config update as a read-like no-op", async () => {
        const ref = await newEnv();
        const before = await store.getEnvConfig(ref);
        expect(await store.updateEnvConfig(ref, {})).toEqual(before);
        expect(await store.getEnvConfig(ref)).toEqual(before);
      });

      it("preserves disjoint concurrent env config updates", async () => {
        const ref = await newEnv();
        await Promise.all([
          store.updateEnvConfig(ref, { network: { type: "none" } }),
          store.updateEnvConfig(ref, { packages: { npm: ["zod@4"] } }),
        ]);
        expect(await store.getEnvConfig(ref)).toMatchObject({
          network: { type: "none" },
          packages: { npm: ["zod@4"] },
        });
      });

      it("rejects an invalid env config update at the boundary", async () => {
        const ref = await newEnv();
        await expect(
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
          store.updateEnvConfig(ref, { network: { type: "vpn" } } as any),
        ).rejects.toThrow();
      });

      it("returns undefined for unknown or foreign agent config refs", async () => {
        const ref = await newAgent({ namespace: "tenant-a" });
        expect(
          await store.getAgentConfig({ namespace: DEFAULT_NAMESPACE, agentConfigId: "nope" }),
        ).toBeUndefined();
        expect(
          await store.getAgentConfig({ namespace: "tenant-b", agentConfigId: ref.agentConfigId }),
        ).toBeUndefined();
        expect(
          await store.getAgentConfig({
            namespace: "tenant-b",
            agentConfigId: ref.agentConfigId,
            version: 1,
          }),
        ).toBeUndefined();
      });

      it("returns undefined for unknown or foreign env config refs", async () => {
        const ref = await newEnv({ namespace: "tenant-a" });
        expect(
          await store.getEnvConfig({ namespace: DEFAULT_NAMESPACE, envConfigId: "nope" }),
        ).toBeUndefined();
        expect(
          await store.getEnvConfig({ namespace: "tenant-b", envConfigId: ref.envConfigId }),
        ).toBeUndefined();
      });

      it("treats an unknown or foreign env config update target as absent", async () => {
        const ref = await newEnv({ namespace: "tenant-a", packages: { pip: ["numpy"] } });
        await expect(
          store.updateEnvConfig(
            { namespace: "tenant-a", envConfigId: "nope" },
            { packages: { npm: ["zod"] } },
          ),
        ).resolves.toBeUndefined();
        await expect(
          store.updateEnvConfig(
            { namespace: "tenant-b", envConfigId: ref.envConfigId },
            { packages: { npm: ["zod"] } },
          ),
        ).resolves.toBeUndefined();
        expect((await store.getEnvConfig(ref))?.packages).toEqual({ pip: ["numpy"] });
      });
    });

    describe("archiving agent configs", () => {
      it("marks the config archived without touching what it says", async () => {
        const ref = await newAgent({ systemPrompt: "v1" });
        await store.updateAgentConfig(ref, { systemPrompt: "v2" });
        const before = await store.getAgentConfig(ref);
        clock.advance(1_000);

        const archived = await store.archiveAgentConfig(ref);

        // Archiving retires the config; it does not edit it — same version,
        // same payload, same updatedAt, one new fact.
        expect(archived).toMatchObject({ ...before, archivedAt: expect.any(String) });
        expect(await store.getAgentConfig(ref)).toEqual(archived);
      });

      it("stores absence as absence — an unarchived config has no archivedAt key", async () => {
        const config = await store.getAgentConfig(await newAgent());
        expect(config).toBeDefined();
        expect("archivedAt" in config!).toBe(false);
      });

      it("is idempotent — the terminal state has no second transition", async () => {
        const ref = await newAgent();
        const first = await store.archiveAgentConfig(ref);
        clock.advance(1_000);
        const second = await store.archiveAgentConfig(ref);

        expect(second).toEqual(first);
        expect(second?.archivedAt).toBe(first?.archivedAt);
      });

      it("makes the config read-only: every mutation throws ArchivedError", async () => {
        const ref = await newAgent({ systemPrompt: "final" });
        await store.archiveAgentConfig(ref);

        for (const req of [
          { systemPrompt: "after" },
          { inference: { provider: "fake", model: "m2" } },
          { metadata: { note: "after" } },
          { systemPrompt: "after", version: 1 },
        ]) {
          await expect(store.updateAgentConfig(ref, req)).rejects.toMatchObject({
            name: "ArchivedError",
            configId: ref.agentConfigId,
          });
        }
        expect(await store.getAgentConfig(ref)).toMatchObject({
          systemPrompt: "final",
          version: 1,
        });
      });

      it("reports archived before stale — the version is not what the caller can fix", async () => {
        const ref = await newAgent();
        await store.updateAgentConfig(ref, { systemPrompt: "v2" });
        await store.archiveAgentConfig(ref);

        await expect(
          store.updateAgentConfig(ref, { systemPrompt: "x", version: 1 }),
        ).rejects.toBeInstanceOf(ArchivedError);
      });

      it("keeps an empty update a read — it mutates nothing, so nothing is forbidden", async () => {
        const ref = await newAgent();
        const archived = await store.archiveAgentConfig(ref);
        expect(await store.updateAgentConfig(ref, {})).toEqual(archived);
      });

      it("stays readable — get, every version, and the list still answer", async () => {
        const ref = await newAgent({ systemPrompt: "v1" });
        await store.updateAgentConfig(ref, { systemPrompt: "v2" });
        const archived = await store.archiveAgentConfig(ref);

        expect(await store.getAgentConfig(ref)).toEqual(archived);
        expect(
          (await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 })).map(
            (c) => c.agentConfigId,
          ),
        ).toContain(ref.agentConfigId);
        // The identity retired, not a snapshot: every version reads back,
        // and each one carries the mark.
        for (const version of [1, 2]) {
          expect(await store.getAgentConfig({ ...ref, version })).toMatchObject({
            version,
            archivedAt: archived?.archivedAt,
          });
        }
      });

      it("refuses a new session naming an archived config, at any version", async () => {
        const agentConfigRef = await newAgent();
        await store.updateAgentConfig(agentConfigRef, { systemPrompt: "v2" });
        const envConfigRef = await newEnv();
        await store.archiveAgentConfig(agentConfigRef);

        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          }),
        ).rejects.toBeInstanceOf(ArchivedError);
        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            agentConfigVersion: 1,
            envConfigId: envConfigRef.envConfigId,
          }),
        ).rejects.toBeInstanceOf(ArchivedError);
      });

      it("lets sessions that already reference it run on", async () => {
        const agentConfigRef = await newAgent({ systemPrompt: "pinned" });
        const envConfigRef = await newEnv();
        const sessionRef = await store.createSession({
          namespace: DEFAULT_NAMESPACE,
          agentConfigId: agentConfigRef.agentConfigId,
          envConfigId: envConfigRef.envConfigId,
        });
        await store.archiveAgentConfig(agentConfigRef);

        // The session still resolves the behavior it pinned, and still runs:
        // archiving stops new references, not existing work.
        const session = await store.getSession(sessionRef);
        expect(
          (
            await store.getAgentConfig({
              ...agentConfigRef,
              version: session!.agentConfigVersion,
            })
          )?.systemPrompt,
        ).toBe("pinned");
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("still here")],
          next: { kind: "end_run", status: "completed" },
        });
        expect(await store.readEntries(sessionRef)).toHaveLength(2);
      });

      it("settles a create/archive race one of the two legal ways", async () => {
        const agentConfigRef = await newAgent();
        const envConfigRef = await newEnv();

        const [created, archived] = await Promise.allSettled([
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          }),
          store.archiveAgentConfig(agentConfigRef),
        ]);

        // The archive always lands: nothing outranks the terminal state.
        expect(archived.status).toBe("fulfilled");
        // The session either committed ahead of it or was refused by it —
        // a third outcome (a deadlock, a session on an archived config)
        // would mean the two writes are not serialized.
        if (created.status === "fulfilled") {
          expect(await store.getSession(created.value)).toBeDefined();
        } else {
          expect(created.reason).toBeInstanceOf(ArchivedError);
        }
        // Whoever won, the door is shut behind them.
        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          }),
        ).rejects.toBeInstanceOf(ArchivedError);
      });

      it("treats an unknown or foreign archive target as absent", async () => {
        const ref = await newAgent({ namespace: "tenant-a" });
        expect(
          await store.archiveAgentConfig({ namespace: "tenant-a", agentConfigId: "nope" }),
        ).toBeUndefined();
        expect(
          await store.archiveAgentConfig({
            namespace: "tenant-b",
            agentConfigId: ref.agentConfigId,
          }),
        ).toBeUndefined();
        // The foreign archive touched nothing.
        expect(await store.getAgentConfig(ref)).toMatchObject({ namespace: "tenant-a" });
        expect("archivedAt" in (await store.getAgentConfig(ref))!).toBe(false);
      });
    });

    describe("listing configs", () => {
      /** n configs, each a tick newer than the last, oldest id first. */
      async function agentConfigIds(n: number, namespace?: string): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const ref = await newAgent({
            inference: { provider: "fake", model: `m${i}` },
            ...(namespace === undefined ? {} : { namespace }),
          });
          ids.push(ref.agentConfigId);
          clock.advance(1_000);
        }
        return ids;
      }

      /** Walk the whole list one small page at a time. */
      async function walk(namespace: string, limit: number): Promise<string[]> {
        const ids: string[] = [];
        let after: string | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page = await store.listAgentConfigs({ namespace, limit, after });
          expect(page.length).toBeLessThanOrEqual(limit);
          if (page.length === 0) return ids;
          ids.push(...page.map((c) => c.agentConfigId));
          after = page[page.length - 1]?.agentConfigId;
        }
        throw new Error("walk did not terminate");
      }

      it("lists a namespace's configs newest first, whole rows", async () => {
        const [oldest, middle, newest] = await agentConfigIds(3);
        const configs = await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 });
        expect(configs.map((c) => c.agentConfigId)).toEqual([newest, middle, oldest]);
        // The same shape a get returns — one row mapping, not two.
        expect(configs[0]).toEqual(
          await store.getAgentConfig({ namespace: DEFAULT_NAMESPACE, agentConfigId: newest! }),
        );
      });

      it("bounds the page at limit and resumes strictly after the cursor", async () => {
        const [oldest, middle, newest] = await agentConfigIds(3);
        const first = await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 2 });
        expect(first.map((c) => c.agentConfigId)).toEqual([newest, middle]);
        const second = await store.listAgentConfigs({
          namespace: DEFAULT_NAMESPACE,
          limit: 2,
          after: middle,
        });
        expect(second.map((c) => c.agentConfigId)).toEqual([oldest]);
        expect(
          await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 2, after: oldest }),
        ).toEqual([]);
      });

      it("pages an unadvanced clock without dropping or duplicating a row", async () => {
        // No clock advance: created_at ties are likely, so this pins the
        // (createdAt, id) key's total order — walking in pages must equal
        // the whole list exactly.
        for (let i = 0; i < 5; i++) {
          await newEnv();
        }
        const whole = await store.listEnvConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 });
        expect(whole).toHaveLength(5);

        const walked: string[] = [];
        let after: string | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page = await store.listEnvConfigs({
            namespace: DEFAULT_NAMESPACE,
            limit: 2,
            after,
          });
          if (page.length === 0) break;
          walked.push(...page.map((c) => c.envConfigId));
          after = page[page.length - 1]?.envConfigId;
        }
        expect(walked).toEqual(whole.map((c) => c.envConfigId));
      });

      it("scopes the list to one namespace — a page walk never crosses the boundary", async () => {
        const a = await agentConfigIds(3, "tenant-a");
        const b = await agentConfigIds(2, "tenant-b");
        expect(await walk("tenant-a", 2)).toEqual([...a].reverse());
        expect(await walk("tenant-b", 2)).toEqual([...b].reverse());
        expect(await store.listAgentConfigs({ namespace: "tenant-c", limit: 10 })).toEqual([]);
      });

      it("rejects a cursor it cannot resolve — a foreign one like a nonexistent one", async () => {
        const [foreign] = await agentConfigIds(1, "tenant-b");
        await expect(
          store.listAgentConfigs({ namespace: "tenant-a", limit: 10, after: "nope" }),
        ).rejects.toThrow("unknown cursor");
        await expect(
          store.listAgentConfigs({ namespace: "tenant-a", limit: 10, after: foreign }),
        ).rejects.toThrow("unknown cursor");
      });

      it("lists the two config kinds independently", async () => {
        await agentConfigIds(2);
        const envRef = await newEnv();
        const envs = await store.listEnvConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 });
        expect(envs.map((c) => c.envConfigId)).toEqual([envRef.envConfigId]);
        expect(envs[0]).toEqual(await store.getEnvConfig(envRef));
        expect(
          await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 }),
        ).toHaveLength(2);
      });
    });

    describe("sessions", () => {
      it("round-trips a session", async () => {
        const sessionRef = await newSession();
        expect(sessionRef.namespace).toBe(DEFAULT_NAMESPACE);
        const session = await store.getSession(sessionRef);
        expect(session?.sessionId).toBe(sessionRef.sessionId);
        expect(session?.namespace).toBe(DEFAULT_NAMESPACE);
        expect(session?.agentConfigId).toBeDefined();
        expect(session?.agentConfigVersion).toBe(1);
        expect(session?.envConfigId).toBeDefined();
      });

      // Env configs update in place — there is no version to pin — so the
      // session copies the resolved recipe instead. These four cases are
      // the whole contract: what is copied, that an edit cannot reach back
      // through it, that a later session sees the edit, and that the copy
      // is of a real row in the caller's own namespace.
      describe("env config snapshot", () => {
        it("copies the env config's resolved recipe at create", async () => {
          const agentConfigRef = await newAgent();
          const envConfigRef = await newEnv({
            network: { type: "allowlist", domains: ["pypi.org"] },
            packages: { pip: ["numpy"] },
          });
          const sessionRef = await store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          });
          expect((await store.getSession(sessionRef))?.envConfigSnapshot).toEqual({
            network: { type: "allowlist", domains: ["pypi.org"] },
            packages: { pip: ["numpy"] },
          });
        });

        // The materialized defaults are decisions too: the snapshot copies
        // what the env config resolved, never the request that made it.
        it("copies the materialized defaults, not the create request", async () => {
          const sessionRef = await newSession(); // newEnv() states neither field
          expect((await store.getSession(sessionRef))?.envConfigSnapshot).toEqual({
            network: { type: "unrestricted" },
            packages: {},
          });
        });

        it("does not change under a later env config update", async () => {
          const agentConfigRef = await newAgent();
          const envConfigRef = await newEnv({ network: { type: "none" } });
          const before = await store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          });

          await store.updateEnvConfig(envConfigRef, {
            network: { type: "allowlist", domains: ["example.com"] },
            packages: { npm: ["zod"] },
          });

          // The running session's world is the one it was born with…
          expect((await store.getSession(before))?.envConfigSnapshot).toEqual({
            network: { type: "none" },
            packages: {},
          });
          // …and the next session gets the edit.
          const after = await store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
          });
          expect((await store.getSession(after))?.envConfigSnapshot).toEqual({
            network: { type: "allowlist", domains: ["example.com"] },
            packages: { npm: ["zod"] },
          });
          // The env config itself is untouched by either session.
          expect((await store.getEnvConfig(envConfigRef))?.network).toEqual({
            type: "allowlist",
            domains: ["example.com"],
          });
        });

        it("has nothing to copy from a foreign env config — the create fails", async () => {
          const agentConfigRef = await newAgent({ namespace: "tenant-a" });
          const foreignEnv = await newEnv({ namespace: "tenant-b" });
          await expect(
            store.createSession({
              namespace: "tenant-a",
              agentConfigId: agentConfigRef.agentConfigId,
              envConfigId: foreignEnv.envConfigId,
            }),
          ).rejects.toThrow("unknown env config");
        });
      });

      it("pins the latest agent version when the session is created", async () => {
        const agentConfigRef = await newAgent({
          inference: { provider: "fake", model: "m1" },
          systemPrompt: "v1",
        });
        const envConfigRef = await newEnv();
        await store.updateAgentConfig(agentConfigRef, { systemPrompt: "v2", version: 1 });
        const sessionRef = await store.createSession({
          namespace: DEFAULT_NAMESPACE,
          agentConfigId: agentConfigRef.agentConfigId,
          envConfigId: envConfigRef.envConfigId,
        });
        await store.updateAgentConfig(agentConfigRef, { systemPrompt: "v3", version: 2 });

        const session = await store.getSession(sessionRef);
        expect(session?.agentConfigVersion).toBe(2);
        expect(
          (
            await store.getAgentConfig({
              ...agentConfigRef,
              version: session!.agentConfigVersion,
            })
          )?.systemPrompt,
        ).toBe("v2");
      });

      it("pins an explicitly requested agent version", async () => {
        const agentConfigRef = await newAgent({ systemPrompt: "v1" });
        const envConfigRef = await newEnv();
        await store.updateAgentConfig(agentConfigRef, { systemPrompt: "v2", version: 1 });

        const sessionRef = await store.createSession({
          namespace: DEFAULT_NAMESPACE,
          agentConfigId: agentConfigRef.agentConfigId,
          agentConfigVersion: 1,
          envConfigId: envConfigRef.envConfigId,
        });

        expect((await store.getSession(sessionRef))?.agentConfigVersion).toBe(1);
      });

      it("bindSandbox: first writer wins, losers learn the winner", async () => {
        const sessionRef = await newSession();
        expect((await store.getSession(sessionRef))?.sandboxId).toBeUndefined();

        expect(await store.bindSandbox(sessionRef, "sbx_a")).toBe("sbx_a");
        // The loser's candidate is not recorded; it gets the winner back.
        expect(await store.bindSandbox(sessionRef, "sbx_b")).toBe("sbx_a");
        expect((await store.getSession(sessionRef))?.sandboxId).toBe("sbx_a");
      });

      it("bindSandbox replaces only the expected previous binding", async () => {
        const sessionRef = await newSession();
        await store.bindSandbox(sessionRef, "sbx_a");

        // Wrong expectation: nothing written, the current binding returns.
        expect(await store.bindSandbox(sessionRef, "sbx_c", "sbx_b")).toBe("sbx_a");
        expect((await store.getSession(sessionRef))?.sandboxId).toBe("sbx_a");

        // Right expectation: the dead binding is replaced.
        expect(await store.bindSandbox(sessionRef, "sbx_c", "sbx_a")).toBe("sbx_c");
        expect((await store.getSession(sessionRef))?.sandboxId).toBe("sbx_c");
      });

      it("bindSandbox rejects an unknown or foreign session", async () => {
        await expect(
          store.bindSandbox({ namespace: DEFAULT_NAMESPACE, sessionId: "nope" }, "sbx_a"),
        ).rejects.toThrow("unknown session");
        const sessionRef = await newSession();
        await expect(
          store.bindSandbox({ ...sessionRef, namespace: "tenant-b" }, "sbx_a"),
        ).rejects.toThrow("unknown session");
      });

      it("rejects a session naming an unknown agent config or version", async () => {
        const envConfigRef = await newEnv();
        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: "nope",
            envConfigId: envConfigRef.envConfigId,
          }),
        ).rejects.toThrow();
        const agentConfigRef = await newAgent();
        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            agentConfigVersion: 2,
            envConfigId: envConfigRef.envConfigId,
          }),
        ).rejects.toThrow();
      });

      it("rejects a session naming an unknown env config", async () => {
        const agentConfigRef = await newAgent();
        await expect(
          store.createSession({
            namespace: DEFAULT_NAMESPACE,
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: "nope",
          }),
        ).rejects.toThrow();
      });
    });

    describe("namespace", () => {
      it("stamps every row with the namespace it was created under", async () => {
        const agentConfigRef = await newAgent();
        const envConfigRef = await newEnv();
        const sessionRef = await store.createSession({
          namespace: DEFAULT_NAMESPACE,
          agentConfigId: agentConfigRef.agentConfigId,
          envConfigId: envConfigRef.envConfigId,
        });
        expect((await store.getAgentConfig(agentConfigRef))?.namespace).toBe(DEFAULT_NAMESPACE);
        expect((await store.getEnvConfig(envConfigRef))?.namespace).toBe(DEFAULT_NAMESPACE);
        expect((await store.getSession(sessionRef))?.namespace).toBe(DEFAULT_NAMESPACE);
      });

      it("stores an explicit namespace verbatim", async () => {
        const agentConfigRef = await newAgent({ namespace: "tenant-a" });
        const envConfigRef = await newEnv({ namespace: "tenant-a" });
        const sessionRef = await store.createSession({
          namespace: "tenant-a",
          agentConfigId: agentConfigRef.agentConfigId,
          envConfigId: envConfigRef.envConfigId,
        });
        expect(sessionRef.namespace).toBe("tenant-a");
        expect((await store.getAgentConfig(agentConfigRef))?.namespace).toBe("tenant-a");
        expect((await store.getEnvConfig(envConfigRef))?.namespace).toBe("tenant-a");
        expect((await store.getSession(sessionRef))?.namespace).toBe("tenant-a");
      });

      it("rejects a session create without a namespace at the boundary", async () => {
        const agentConfigRef = await newAgent();
        const envConfigRef = await newEnv();
        await expect(
          store.createSession({
            agentConfigId: agentConfigRef.agentConfigId,
            envConfigId: envConfigRef.envConfigId,
            // biome-ignore lint/suspicious/noExplicitAny: deliberately incomplete
          } as any),
        ).rejects.toThrow();
      });

      it("a foreign-namespace config is unknown — sessions and their configs share one namespace", async () => {
        const agentA = await newAgent({ namespace: "tenant-a" });
        const envA = await newEnv({ namespace: "tenant-a" });
        const envB = await newEnv({ namespace: "tenant-b" });

        // Cross-namespace refs reject exactly like dangling refs — the
        // error is the same "unknown", so existence never leaks.
        await expect(
          store.createSession({
            namespace: "tenant-a",
            agentConfigId: agentA.agentConfigId,
            envConfigId: envB.envConfigId,
          }),
        ).rejects.toThrow("unknown env config");
        await expect(
          store.createSession({
            namespace: "tenant-b",
            agentConfigId: agentA.agentConfigId,
            envConfigId: envA.envConfigId,
          }),
        ).rejects.toThrow("unknown agent config");
        // The matched trio is accepted.
        await expect(
          store.createSession({
            namespace: "tenant-a",
            agentConfigId: agentA.agentConfigId,
            envConfigId: envA.envConfigId,
          }),
        ).resolves.toBeDefined();
      });
    });

    describe("session scoping", () => {
      it("a foreign session ref is unknown — gets, reads, and writes all agree", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go")); // seed an entry and an item
        await store.intake(sessionRef, user("queued")); // seed a pending input
        const foreign: SessionRef = { namespace: "tenant-b", sessionId: sessionRef.sessionId };

        expect(await store.getSession(foreign)).toBeUndefined();
        expect(await store.readEntries(foreign)).toEqual([]);
        expect(await store.listItems(foreign)).toEqual([]);
        expect(await store.pendingInputs(foreign)).toEqual([]);
        await expect(store.intake(foreign, user("hi"))).rejects.toThrow("unknown session");
        await expect(store.requestCancel(foreign)).rejects.toThrow("unknown session");

        // The rightful owner still sees everything.
        expect(await store.readEntries(sessionRef)).toHaveLength(1);
        expect(await store.listItems(sessionRef)).toHaveLength(1);
        expect(await store.pendingInputs(sessionRef)).toHaveLength(1);
      });

      it("a foreign claim filter finds nothing", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        expect(
          await store.claimItem({
            leaseMs: 60_000,
            session: { ...sessionRef, namespace: "tenant-b" },
          }),
        ).toBeUndefined();
        expect(await store.claimItem({ leaseMs: 60_000, session: sessionRef })).toBeDefined();
      });

      it("hands the driver its scope on the claimed row", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        // No filter — the claim starts from nothing; the row must carry
        // the namespace and parent every later ref needs.
        const claim = await store.claimItem({ leaseMs: 60_000 });
        expect(claim?.item).toMatchObject({
          namespace: sessionRef.namespace,
          sessionId: sessionRef.sessionId,
        });
      });
    });

    describe("intake", () => {
      it("starts a run on an idle session — one entry, one ready inference item", async () => {
        const sessionRef = await newSession();
        const result = await store.intake(sessionRef, user("hi"));
        expect(result.kind).toBe("started");
        const entries = await store.readEntries(sessionRef);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ type: "message", seq: 0, message: user("hi") });
        const items = await store.listItems(sessionRef);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ type: "inference", status: "ready" });
      });

      it("queues on a busy session — a pending input, never a second item", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("first"));
        const result = await store.intake(sessionRef, user("second"));
        expect(result.kind).toBe("queued");
        expect(await store.listItems(sessionRef)).toHaveLength(1);
        const pending = await store.pendingInputs(sessionRef);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.message).toEqual(user("second"));
        // The queued message is parked, not logged.
        expect(await store.readEntries(sessionRef)).toHaveLength(1);
      });

      it("rejects intake for an unknown session", async () => {
        await expect(
          store.intake({ namespace: DEFAULT_NAMESPACE, sessionId: "nope" }, user("hi")),
        ).rejects.toThrow();
      });

      it("admits exactly one starter under concurrent intake", async () => {
        const sessionRef = await newSession();
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => store.intake(sessionRef, user(`m${i}`))),
        );
        expect(results.filter((r) => r.kind === "started")).toHaveLength(1);
        expect(results.filter((r) => r.kind === "queued")).toHaveLength(4);
        expect(await store.listItems(sessionRef)).toHaveLength(1);
      });
    });

    describe("claiming", () => {
      it("leases the ready item to exactly one claimer", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        const claim = await store.claimItem({ leaseMs: 60_000 });
        expect(claim?.item).toMatchObject({
          sessionId: sessionRef.sessionId,
          type: "inference",
          status: "leased",
        });
        expect(claim?.token).toBeTruthy();
        expect(await store.claimItem({ leaseMs: 60_000 })).toBeUndefined();
      });

      it("counts attempts: 0 until claimed, incremented by every claim", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        expect((await store.listItems(sessionRef))[0]?.attempt).toBe(0);

        const first = await store.claimItem({ leaseMs: 1_000 });
        expect(first?.item.attempt).toBe(1);

        // Expiry and re-claim — the signal the driver's at-most-once
        // tool guard keys on.
        clock.advance(5_000);
        const second = await store.claimItem({ leaseMs: 1_000 });
        expect(second?.item.attempt).toBe(2);
        expect((await store.listItems(sessionRef))[0]?.attempt).toBe(2);
      });

      it("admits exactly one winner under contended claims", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        const claims = await Promise.all(
          Array.from({ length: 8 }, () => store.claimItem({ leaseMs: 60_000 })),
        );
        expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
      });

      it("scopes the claim scan when a session is given", async () => {
        const s1 = await newSession();
        const s2 = await newSession();
        await store.intake(s1, user("a"));
        await store.intake(s2, user("b"));
        const claim = await store.claimItem({ leaseMs: 60_000, session: s2 });
        expect(claim?.item.sessionId).toBe(s2.sessionId);
      });

      it("heartbeats only the live lease's token", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        expect(await store.heartbeat(itemRef, token)).toBe(true);
        expect(await store.heartbeat(itemRef, "forged-token")).toBe(false);
      });

      it("misses a heartbeat addressed through the wrong session or namespace", async () => {
        const s1 = await newSession();
        const s2 = await newSession();
        const { itemRef, token } = await startAndClaim(s1);
        // The full path is the address: a mismatched parent or a foreign
        // namespace is unknown, exactly like a missing item.
        expect(await store.heartbeat({ ...itemRef, sessionId: s2.sessionId }, token)).toBe(false);
        expect(await store.heartbeat({ ...itemRef, namespace: "tenant-b" }, token)).toBe(false);
        expect(await store.heartbeat(itemRef, token)).toBe(true);
      });

      it("reclaims an expired lease with a fresh token, fencing the old one", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        clock.advance(120_000);
        expect(await store.heartbeat(itemRef, token)).toBe(false); // lease lost
        const reclaimed = await store.claimItem({ leaseMs: 60_000 });
        expect(reclaimed?.item.itemId).toBe(itemRef.itemId);
        // A re-claim never re-issues the credential — the zombie stays fenced.
        expect(reclaimed?.token).not.toBe(token);
        await expect(
          store.commitStep({
            itemRef,
            token,
            append: [assistant("stale work")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        await store.commitStep({
          itemRef,
          token: reclaimed!.token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
      });

      it("transfers authority at the exact expiry instant — expired has one spelling", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef); // leaseMs 60_000
        clock.advance(60_000); // now == leaseExpiresAt, exactly
        expect(await store.heartbeat(itemRef, token)).toBe(false); // holder is out…
        await expect(
          store.commitStep({
            itemRef,
            token,
            append: [assistant("at the wire")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        const reclaimed = await store.claimItem({ leaseMs: 60_000 }); // …and a claimer is in
        expect(reclaimed?.item.itemId).toBe(itemRef.itemId);
      });

      it("rejects a commit on an expired lease even before any reclaim", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        clock.advance(120_000);
        await expect(
          store.commitStep({
            itemRef,
            token,
            append: [assistant("late")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        // The rejected commit rolled back whole — nothing landed.
        expect(await store.readEntries(sessionRef)).toHaveLength(1);
        // After expiry the item's fate belongs to its next claimer.
        const reclaimed = await store.claimItem({ leaseMs: 60_000 });
        expect(reclaimed?.item.itemId).toBe(itemRef.itemId);
      });
    });

    describe("cancel", () => {
      it("appends a control entry in log order", async () => {
        const sessionRef = await newSession();
        await store.intake(sessionRef, user("go"));
        await store.requestCancel(sessionRef);
        const entries = await store.readEntries(sessionRef);
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({ type: "control", control: "cancel", seq: 1 });
      });
    });

    describe("commitStep", () => {
      it("appends output and chains the next item atomically", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("thinking…")],
          next: { kind: "execute_tools" },
        });
        const entries = await store.readEntries(sessionRef);
        expect(entries.map((e) => e.seq)).toEqual([0, 1]);
        const items = await store.listItems(sessionRef);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ itemId: itemRef.itemId, status: "done" });
        expect(items[1]).toMatchObject({ type: "execute_tools", status: "ready" });
      });

      it("end_run with no pending inputs leaves the session idle", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const items = await store.listItems(sessionRef);
        expect(items).toHaveLength(1); // the run's end is the NON-creation of a next item
        expect(items[0]?.status).toBe("done");
        // Idle again: the next intake starts a run.
        expect((await store.intake(sessionRef, user("next"))).kind).toBe("started");
      });

      it("end_run auto-chains parked inputs into a new run, in arrival order", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.intake(sessionRef, user("follow-up 1"));
        await store.intake(sessionRef, user("follow-up 2"));
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const entries = await store.readEntries(sessionRef);
        expect(entries.map((e) => (e.type === "message" ? e.message : e.type))).toEqual([
          user("go"),
          assistant("done"),
          user("follow-up 1"),
          user("follow-up 2"),
        ]);
        expect(await store.pendingInputs(sessionRef)).toHaveLength(0);
        const items = await store.listItems(sessionRef);
        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({ type: "inference", status: "ready" });
      });

      it("end_run cancelled parks pending inputs instead of chaining", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.intake(sessionRef, user("queued during run"));
        await store.commitStep({
          itemRef,
          token,
          append: [],
          next: { kind: "end_run", status: "cancelled" },
        });
        expect(await store.listItems(sessionRef)).toHaveLength(1); // no chain
        expect(await store.pendingInputs(sessionRef)).toHaveLength(1); // parked
      });

      it("drains consumed inputs atomically with the step", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        const queued = await store.intake(sessionRef, user("steer!"));
        expect(queued.kind).toBe("queued");
        const inputId = queued.kind === "queued" ? queued.inputId : "";
        await store.commitStep({
          itemRef,
          token,
          // Drained steering precedes step output.
          append: [user("steer!"), assistant("adjusted")],
          consumeInputs: [inputId],
          next: { kind: "end_run", status: "completed" },
        });
        expect(await store.pendingInputs(sessionRef)).toHaveLength(0);
        expect((await store.readEntries(sessionRef)).map((e) => e.seq)).toEqual([0, 1, 2]);
      });

      it("rejects consuming an unknown or already-consumed input", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await expect(
          store.commitStep({
            itemRef,
            token,
            append: [],
            consumeInputs: ["nope"],
            next: { kind: "inference" },
          }),
        ).rejects.toThrow();
      });

      it("resolves an idempotent re-commit of a done item without duplicating", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        const commit: CommitStepRequest = {
          itemRef,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        };
        await store.commitStep(commit);
        await store.commitStep(commit); // crash-after-commit recovery
        expect(await store.readEntries(sessionRef)).toHaveLength(2);
        expect(await store.listItems(sessionRef)).toHaveLength(1);
      });

      it("rejects a commit for an unknown item", async () => {
        await expect(
          store.commitStep({
            itemRef: { namespace: DEFAULT_NAMESPACE, sessionId: "nope", itemId: "nope" },
            token: "any",
            append: [],
            next: { kind: "inference" },
          }),
        ).rejects.toThrow();
      });

      it("treats a commit addressed through the wrong session or namespace as unknown", async () => {
        const s1 = await newSession();
        const s2 = await newSession();
        const { itemRef, token } = await startAndClaim(s1);
        await expect(
          store.commitStep({
            itemRef: { ...itemRef, sessionId: s2.sessionId },
            token,
            append: [],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow("unknown item");
        await expect(
          store.commitStep({
            itemRef: { ...itemRef, namespace: "tenant-b" },
            token,
            append: [],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow("unknown item");
        // The rightful address still commits.
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
      });
    });

    describe("the log", () => {
      it("serves the seq cursor — only entries after the given seq", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef);
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const tail = await store.readEntries(sessionRef, 0);
        expect(tail).toHaveLength(1);
        expect(tail[0]?.seq).toBe(1);
        expect(await store.readEntries(sessionRef, 1)).toHaveLength(0);
      });

      it("keeps seq gapless and monotonic across every write path", async () => {
        const sessionRef = await newSession();
        const { itemRef, token } = await startAndClaim(sessionRef); // seq 0: user message
        await store.requestCancel(sessionRef); // seq 1: control
        await store.commitStep({
          itemRef,
          token,
          append: [assistant("stopped")], // seq 2
          next: { kind: "end_run", status: "cancelled" },
        });
        await store.intake(sessionRef, user("again")); // seq 3
        const entries = await store.readEntries(sessionRef);
        expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
      });
    });
  });
}
