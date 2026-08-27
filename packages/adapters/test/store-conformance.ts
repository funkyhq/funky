// The Store conformance suite — the port's jsdoc contract as executable
// tests, written against the interface via a factory. Every adapter and
// every binding runs this identical suite; what it pins is contract, what
// it doesn't pin is implementation freedom.
//
// The harness provides a controllable clock so lease expiry is tested by
// advancing time, never by sleeping.

import { beforeEach, describe, expect, it } from "vitest";
import { type AssistantMessage, DEFAULT_NAMESPACE, type UserMessage } from "@funky/core";
import { type CommitStepRequest, FencedError, type Store } from "@funky/agent";

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

    async function newSession(): Promise<string> {
      const agentConfigId = await store.createAgentConfig({
        inference: { provider: "fake", model: "scripted" },
        systemPrompt: "s",
      });
      const envConfigId = await store.createEnvConfig({});
      return store.createSession({ agentConfigId, envConfigId });
    }

    /** intake must have started a run; returns the claimed item + token. */
    async function startAndClaim(sessionId: string): Promise<{ itemId: string; token: string }> {
      const result = await store.intake(sessionId, user("go"));
      expect(result.kind).toBe("started");
      const claim = await store.claimItem({ leaseMs: 60_000, sessionId });
      expect(claim).toBeDefined();
      return { itemId: claim!.item.id, token: claim!.token };
    }

    describe("configs", () => {
      it("round-trips an agent config through create and get", async () => {
        const id = await store.createAgentConfig({
          inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
          systemPrompt: "You are helpful.",
          metadata: { team: "growth" },
        });
        const config = await store.getAgentConfig(id);
        expect(config).toMatchObject({
          id,
          inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
          systemPrompt: "You are helpful.",
          metadata: { team: "growth" },
        });
        expect(config?.createdAt).toMatch(/T.*Z$/);
      });

      it("stores absence as absence — no metadata or sampling keys materialize", async () => {
        const id = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
        });
        const config = await store.getAgentConfig(id);
        expect(config).toBeDefined();
        expect("metadata" in config!).toBe(false);
        expect("maxTokens" in config!.inference).toBe(false);
        expect("temperature" in config!.inference).toBe(false);
      });

      it("keeps JSON null metadata distinct from absent metadata", async () => {
        const id = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
          metadata: null,
        });
        const config = await store.getAgentConfig(id);
        expect(config).toBeDefined();
        expect("metadata" in config!).toBe(true);
        expect(config!.metadata).toBeNull();
      });

      it("rejects an invalid create request at the boundary", async () => {
        await expect(
          store.createAgentConfig({
            // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
            inference: "claude-sonnet-5" as any,
            systemPrompt: "s",
          }),
        ).rejects.toThrow();
      });

      it("materializes network and packages at env config create", async () => {
        const id = await store.createEnvConfig({});
        const config = await store.getEnvConfig(id);
        expect(config?.network).toEqual({ type: "unrestricted" });
        expect(config?.packages).toEqual({});
      });

      it("preserves a provided recipe verbatim", async () => {
        const id = await store.createEnvConfig({
          network: { type: "allowlist", domains: ["pypi.org"] },
          packages: { pip: ["pandas==2.2.0"] },
        });
        const config = await store.getEnvConfig(id);
        expect(config?.network).toEqual({ type: "allowlist", domains: ["pypi.org"] });
        expect(config?.packages).toEqual({ pip: ["pandas==2.2.0"] });
      });

      it("returns undefined for an unknown config id", async () => {
        expect(await store.getAgentConfig("nope")).toBeUndefined();
        expect(await store.getEnvConfig("nope")).toBeUndefined();
      });
    });

    describe("listing configs", () => {
      /** n configs, each a tick newer than the last, oldest id first. */
      async function agentConfigs(n: number, namespace?: string): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          ids.push(
            await store.createAgentConfig({
              inference: { provider: "fake", model: `m${i}` },
              systemPrompt: "s",
              ...(namespace === undefined ? {} : { namespace }),
            }),
          );
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
          ids.push(...page.map((c) => c.id));
          after = page[page.length - 1]?.id;
        }
        throw new Error("walk did not terminate");
      }

      it("lists a namespace's configs newest first, whole rows", async () => {
        const [oldest, middle, newest] = await agentConfigs(3);
        const configs = await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 });
        expect(configs.map((c) => c.id)).toEqual([newest, middle, oldest]);
        // The same shape a get returns — one row mapping, not two.
        expect(configs[0]).toEqual(await store.getAgentConfig(newest!));
      });

      it("bounds the page at limit and resumes strictly after the cursor", async () => {
        const [oldest, middle, newest] = await agentConfigs(3);
        const first = await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 2 });
        expect(first.map((c) => c.id)).toEqual([newest, middle]);
        const second = await store.listAgentConfigs({
          namespace: DEFAULT_NAMESPACE,
          limit: 2,
          after: middle,
        });
        expect(second.map((c) => c.id)).toEqual([oldest]);
        expect(
          await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 2, after: oldest }),
        ).toEqual([]);
      });

      it("pages an unadvanced clock without dropping or duplicating a row", async () => {
        // No clock advance: created_at ties are likely, so this pins the
        // (createdAt, id) key's total order — walking in pages must equal
        // the whole list exactly.
        for (let i = 0; i < 5; i++) {
          await store.createEnvConfig({});
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
          walked.push(...page.map((c) => c.id));
          after = page[page.length - 1]?.id;
        }
        expect(walked).toEqual(whole.map((c) => c.id));
      });

      it("scopes the list to one namespace — a page walk never crosses the boundary", async () => {
        const a = await agentConfigs(3, "tenant-a");
        const b = await agentConfigs(2, "tenant-b");
        expect(await walk("tenant-a", 2)).toEqual([...a].reverse());
        expect(await walk("tenant-b", 2)).toEqual([...b].reverse());
        expect(await store.listAgentConfigs({ namespace: "tenant-c", limit: 10 })).toEqual([]);
      });

      it("rejects a cursor it cannot resolve — a foreign one like a nonexistent one", async () => {
        const [foreign] = await agentConfigs(1, "tenant-b");
        await expect(
          store.listAgentConfigs({ namespace: "tenant-a", limit: 10, after: "nope" }),
        ).rejects.toThrow("unknown cursor");
        await expect(
          store.listAgentConfigs({ namespace: "tenant-a", limit: 10, after: foreign }),
        ).rejects.toThrow("unknown cursor");
      });

      it("lists the two config kinds independently", async () => {
        await agentConfigs(2);
        const envId = await store.createEnvConfig({});
        const envs = await store.listEnvConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 });
        expect(envs.map((c) => c.id)).toEqual([envId]);
        expect(envs[0]).toEqual(await store.getEnvConfig(envId));
        expect(
          await store.listAgentConfigs({ namespace: DEFAULT_NAMESPACE, limit: 10 }),
        ).toHaveLength(2);
      });
    });

    describe("sessions", () => {
      it("round-trips a session", async () => {
        const sessionId = await newSession();
        const session = await store.getSession(sessionId);
        expect(session?.id).toBe(sessionId);
        expect(session?.agentConfigId).toBeDefined();
        expect(session?.envConfigId).toBeDefined();
      });

      it("bindSandbox: first writer wins, losers learn the winner", async () => {
        const sessionId = await newSession();
        expect((await store.getSession(sessionId))?.sandboxId).toBeUndefined();

        expect(await store.bindSandbox(sessionId, "sbx_a")).toBe("sbx_a");
        // The loser's candidate is not recorded; it gets the winner back.
        expect(await store.bindSandbox(sessionId, "sbx_b")).toBe("sbx_a");
        expect((await store.getSession(sessionId))?.sandboxId).toBe("sbx_a");
      });

      it("bindSandbox replaces only the expected previous binding", async () => {
        const sessionId = await newSession();
        await store.bindSandbox(sessionId, "sbx_a");

        // Wrong expectation: nothing written, the current binding returns.
        expect(await store.bindSandbox(sessionId, "sbx_c", "sbx_b")).toBe("sbx_a");
        expect((await store.getSession(sessionId))?.sandboxId).toBe("sbx_a");

        // Right expectation: the dead binding is replaced.
        expect(await store.bindSandbox(sessionId, "sbx_c", "sbx_a")).toBe("sbx_c");
        expect((await store.getSession(sessionId))?.sandboxId).toBe("sbx_c");
      });

      it("bindSandbox rejects an unknown session", async () => {
        await expect(store.bindSandbox("nope", "sbx_a")).rejects.toThrow("unknown session");
      });

      it("rejects a session naming an unknown agent config", async () => {
        const envConfigId = await store.createEnvConfig({});
        await expect(store.createSession({ agentConfigId: "nope", envConfigId })).rejects.toThrow();
      });

      it("rejects a session naming an unknown env config", async () => {
        const agentConfigId = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
        });
        await expect(store.createSession({ agentConfigId, envConfigId: "nope" })).rejects.toThrow();
      });
    });

    describe("namespace", () => {
      it("materializes DEFAULT_NAMESPACE when absent, on all three ownable rows", async () => {
        const agentConfigId = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
        });
        const envConfigId = await store.createEnvConfig({});
        const sessionId = await store.createSession({ agentConfigId, envConfigId });
        expect((await store.getAgentConfig(agentConfigId))?.namespace).toBe(DEFAULT_NAMESPACE);
        expect((await store.getEnvConfig(envConfigId))?.namespace).toBe(DEFAULT_NAMESPACE);
        expect((await store.getSession(sessionId))?.namespace).toBe(DEFAULT_NAMESPACE);
      });

      it("stores an explicit namespace verbatim", async () => {
        const agentConfigId = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
          namespace: "tenant-a",
        });
        const envConfigId = await store.createEnvConfig({ namespace: "tenant-a" });
        const sessionId = await store.createSession({
          agentConfigId,
          envConfigId,
          namespace: "tenant-a",
        });
        expect((await store.getAgentConfig(agentConfigId))?.namespace).toBe("tenant-a");
        expect((await store.getEnvConfig(envConfigId))?.namespace).toBe("tenant-a");
        expect((await store.getSession(sessionId))?.namespace).toBe("tenant-a");
      });

      it("a foreign-namespace config is unknown — sessions and their configs share one namespace", async () => {
        const agentA = await store.createAgentConfig({
          inference: { provider: "fake", model: "m" },
          systemPrompt: "s",
          namespace: "tenant-a",
        });
        const envA = await store.createEnvConfig({ namespace: "tenant-a" });
        const envB = await store.createEnvConfig({ namespace: "tenant-b" });

        // Cross-namespace refs reject exactly like dangling refs — the
        // error is the same "unknown", so existence never leaks.
        await expect(
          store.createSession({ agentConfigId: agentA, envConfigId: envB, namespace: "tenant-a" }),
        ).rejects.toThrow("unknown env config");
        await expect(
          store.createSession({ agentConfigId: agentA, envConfigId: envA, namespace: "tenant-b" }),
        ).rejects.toThrow("unknown agent config");
        // The matched trio is accepted.
        await expect(
          store.createSession({ agentConfigId: agentA, envConfigId: envA, namespace: "tenant-a" }),
        ).resolves.toBeDefined();
      });
    });

    describe("intake", () => {
      it("starts a run on an idle session — one entry, one ready inference item", async () => {
        const sessionId = await newSession();
        const result = await store.intake(sessionId, user("hi"));
        expect(result.kind).toBe("started");
        const entries = await store.readEntries(sessionId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ type: "message", seq: 0, message: user("hi") });
        const items = await store.listItems(sessionId);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ type: "inference", status: "ready" });
      });

      it("queues on a busy session — a pending input, never a second item", async () => {
        const sessionId = await newSession();
        await store.intake(sessionId, user("first"));
        const result = await store.intake(sessionId, user("second"));
        expect(result.kind).toBe("queued");
        expect(await store.listItems(sessionId)).toHaveLength(1);
        const pending = await store.pendingInputs(sessionId);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.message).toEqual(user("second"));
        // The queued message is parked, not logged.
        expect(await store.readEntries(sessionId)).toHaveLength(1);
      });

      it("rejects intake for an unknown session", async () => {
        await expect(store.intake("nope", user("hi"))).rejects.toThrow();
      });

      it("admits exactly one starter under concurrent intake", async () => {
        const sessionId = await newSession();
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => store.intake(sessionId, user(`m${i}`))),
        );
        expect(results.filter((r) => r.kind === "started")).toHaveLength(1);
        expect(results.filter((r) => r.kind === "queued")).toHaveLength(4);
        expect(await store.listItems(sessionId)).toHaveLength(1);
      });
    });

    describe("claiming", () => {
      it("leases the ready item to exactly one claimer", async () => {
        const sessionId = await newSession();
        await store.intake(sessionId, user("go"));
        const claim = await store.claimItem({ leaseMs: 60_000 });
        expect(claim?.item).toMatchObject({ sessionId, type: "inference", status: "leased" });
        expect(claim?.token).toBeTruthy();
        expect(await store.claimItem({ leaseMs: 60_000 })).toBeUndefined();
      });

      it("counts attempts: 0 until claimed, incremented by every claim", async () => {
        const sessionId = await newSession();
        await store.intake(sessionId, user("go"));
        expect((await store.listItems(sessionId))[0]?.attempt).toBe(0);

        const first = await store.claimItem({ leaseMs: 1_000 });
        expect(first?.item.attempt).toBe(1);

        // Expiry and re-claim — the signal the driver's at-most-once
        // tool guard keys on.
        clock.advance(5_000);
        const second = await store.claimItem({ leaseMs: 1_000 });
        expect(second?.item.attempt).toBe(2);
        expect((await store.listItems(sessionId))[0]?.attempt).toBe(2);
      });

      it("admits exactly one winner under contended claims", async () => {
        const sessionId = await newSession();
        await store.intake(sessionId, user("go"));
        const claims = await Promise.all(
          Array.from({ length: 8 }, () => store.claimItem({ leaseMs: 60_000 })),
        );
        expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
      });

      it("scopes the claim scan when sessionId is given", async () => {
        const s1 = await newSession();
        const s2 = await newSession();
        await store.intake(s1, user("a"));
        await store.intake(s2, user("b"));
        const claim = await store.claimItem({ leaseMs: 60_000, sessionId: s2 });
        expect(claim?.item.sessionId).toBe(s2);
      });

      it("heartbeats only the live lease's token", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        expect(await store.heartbeat(itemId, token)).toBe(true);
        expect(await store.heartbeat(itemId, "forged-token")).toBe(false);
      });

      it("reclaims an expired lease with a fresh token, fencing the old one", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        clock.advance(120_000);
        expect(await store.heartbeat(itemId, token)).toBe(false); // lease lost
        const reclaimed = await store.claimItem({ leaseMs: 60_000 });
        expect(reclaimed?.item.id).toBe(itemId);
        // A re-claim never re-issues the credential — the zombie stays fenced.
        expect(reclaimed?.token).not.toBe(token);
        await expect(
          store.commitStep({
            itemId,
            token,
            append: [assistant("stale work")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        await store.commitStep({
          itemId,
          token: reclaimed!.token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
      });

      it("transfers authority at the exact expiry instant — expired has one spelling", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId); // leaseMs 60_000
        clock.advance(60_000); // now == leaseExpiresAt, exactly
        expect(await store.heartbeat(itemId, token)).toBe(false); // holder is out…
        await expect(
          store.commitStep({
            itemId,
            token,
            append: [assistant("at the wire")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        const reclaimed = await store.claimItem({ leaseMs: 60_000 }); // …and a claimer is in
        expect(reclaimed?.item.id).toBe(itemId);
      });

      it("rejects a commit on an expired lease even before any reclaim", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        clock.advance(120_000);
        await expect(
          store.commitStep({
            itemId,
            token,
            append: [assistant("late")],
            next: { kind: "end_run", status: "completed" },
          }),
        ).rejects.toThrow(FencedError);
        // The rejected commit rolled back whole — nothing landed.
        expect(await store.readEntries(sessionId)).toHaveLength(1);
        // After expiry the item's fate belongs to its next claimer.
        const reclaimed = await store.claimItem({ leaseMs: 60_000 });
        expect(reclaimed?.item.id).toBe(itemId);
      });
    });

    describe("cancel", () => {
      it("appends a control entry in log order", async () => {
        const sessionId = await newSession();
        await store.intake(sessionId, user("go"));
        await store.requestCancel(sessionId);
        const entries = await store.readEntries(sessionId);
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({ type: "control", control: "cancel", seq: 1 });
      });
    });

    describe("commitStep", () => {
      it("appends output and chains the next item atomically", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await store.commitStep({
          itemId,
          token,
          append: [assistant("thinking…")],
          next: { kind: "execute_tools" },
        });
        const entries = await store.readEntries(sessionId);
        expect(entries.map((e) => e.seq)).toEqual([0, 1]);
        const items = await store.listItems(sessionId);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ id: itemId, status: "done" });
        expect(items[1]).toMatchObject({ type: "execute_tools", status: "ready" });
      });

      it("end_run with no pending inputs leaves the session idle", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await store.commitStep({
          itemId,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const items = await store.listItems(sessionId);
        expect(items).toHaveLength(1); // the run's end is the NON-creation of a next item
        expect(items[0]?.status).toBe("done");
        // Idle again: the next intake starts a run.
        expect((await store.intake(sessionId, user("next"))).kind).toBe("started");
      });

      it("end_run auto-chains parked inputs into a new run, in arrival order", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await store.intake(sessionId, user("follow-up 1"));
        await store.intake(sessionId, user("follow-up 2"));
        await store.commitStep({
          itemId,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const entries = await store.readEntries(sessionId);
        expect(entries.map((e) => (e.type === "message" ? e.message : e.type))).toEqual([
          user("go"),
          assistant("done"),
          user("follow-up 1"),
          user("follow-up 2"),
        ]);
        expect(await store.pendingInputs(sessionId)).toHaveLength(0);
        const items = await store.listItems(sessionId);
        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({ type: "inference", status: "ready" });
      });

      it("end_run cancelled parks pending inputs instead of chaining", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await store.intake(sessionId, user("queued during run"));
        await store.commitStep({
          itemId,
          token,
          append: [],
          next: { kind: "end_run", status: "cancelled" },
        });
        expect(await store.listItems(sessionId)).toHaveLength(1); // no chain
        expect(await store.pendingInputs(sessionId)).toHaveLength(1); // parked
      });

      it("drains consumed inputs atomically with the step", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        const queued = await store.intake(sessionId, user("steer!"));
        expect(queued.kind).toBe("queued");
        const inputId = queued.kind === "queued" ? queued.inputId : "";
        await store.commitStep({
          itemId,
          token,
          // Drained steering precedes step output.
          append: [user("steer!"), assistant("adjusted")],
          consumeInputs: [inputId],
          next: { kind: "end_run", status: "completed" },
        });
        expect(await store.pendingInputs(sessionId)).toHaveLength(0);
        expect((await store.readEntries(sessionId)).map((e) => e.seq)).toEqual([0, 1, 2]);
      });

      it("rejects consuming an unknown or already-consumed input", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await expect(
          store.commitStep({
            itemId,
            token,
            append: [],
            consumeInputs: ["nope"],
            next: { kind: "inference" },
          }),
        ).rejects.toThrow();
      });

      it("resolves an idempotent re-commit of a done item without duplicating", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        const commit: CommitStepRequest = {
          itemId,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        };
        await store.commitStep(commit);
        await store.commitStep(commit); // crash-after-commit recovery
        expect(await store.readEntries(sessionId)).toHaveLength(2);
        expect(await store.listItems(sessionId)).toHaveLength(1);
      });

      it("rejects a commit for an unknown item", async () => {
        await expect(
          store.commitStep({
            itemId: "nope",
            token: "any",
            append: [],
            next: { kind: "inference" },
          }),
        ).rejects.toThrow();
      });
    });

    describe("the log", () => {
      it("serves the seq cursor — only entries after the given seq", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId);
        await store.commitStep({
          itemId,
          token,
          append: [assistant("done")],
          next: { kind: "end_run", status: "completed" },
        });
        const tail = await store.readEntries(sessionId, 0);
        expect(tail).toHaveLength(1);
        expect(tail[0]?.seq).toBe(1);
        expect(await store.readEntries(sessionId, 1)).toHaveLength(0);
      });

      it("keeps seq gapless and monotonic across every write path", async () => {
        const sessionId = await newSession();
        const { itemId, token } = await startAndClaim(sessionId); // seq 0: user message
        await store.requestCancel(sessionId); // seq 1: control
        await store.commitStep({
          itemId,
          token,
          append: [assistant("stopped")], // seq 2
          next: { kind: "end_run", status: "cancelled" },
        });
        await store.intake(sessionId, user("again")); // seq 3
        const entries = await store.readEntries(sessionId);
        expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
      });
    });
  });
}
