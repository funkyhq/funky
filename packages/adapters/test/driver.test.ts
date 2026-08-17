// The driver against the real pg store over PGlite — the two halves of
// the Store port's "two callers" story exercised together: intake on
// one side, claim → runStep on the other. runStep is the tested unit;
// runDriver is a trivial policy shell around it, covered for real by
// the crash-resume suite at the process level. Scripted inference, a
// real echo tool, and the store's injected clock stand in for the
// world; tests drive steps one at a time, so almost nothing here waits.

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProviderEvent, SessionEntry, Usage, UserMessage } from "@funky/core";
import {
  type Claim,
  type DriverDeps,
  FencedError,
  type InferenceProvider,
  runStep,
  type Store,
  type StreamRequest,
  type Tool,
} from "@funky/agent";
import { createPgStore, type StoreDb } from "../src";

const ddl = readFileSync(new URL("../migrations/0000_init.sql", import.meta.url), "utf8");

let client: PGlite;
let store: Store;
let clock: { advance: (ms: number) => void };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(
    "TRUNCATE agent_configs, env_configs, sessions, session_entries, work_items, pending_inputs RESTART IDENTITY CASCADE",
  );
  let offsetMs = 0;
  store = createPgStore(drizzle({ client }) as unknown as StoreDb, {
    now: () => new Date(Date.now() + offsetMs),
  });
  clock = {
    advance: (ms) => {
      offsetMs += ms;
    },
  };
});

// --- scripted provider: one script per stream() call, in call order ---

type Step = ProviderEvent | { wait: Promise<void> } | { throw: Error } | "untilAborted";

interface ScriptedProvider extends InferenceProvider {
  requests: StreamRequest[];
}

function scriptedProvider(scripts: Step[][]): ScriptedProvider {
  const requests: StreamRequest[] = [];
  return {
    requests,
    async *stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const script = scripts[requests.length] ?? [];
      requests.push(req);
      for (const step of script) {
        if (step === "untilAborted") {
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if ("wait" in step) {
          await step.wait;
          continue;
        }
        if ("throw" in step) throw step.throw;
        yield step;
      }
    },
  };
}

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const sayText = (text: string): Step[] => [
  { type: "text_start", contentIndex: 0 },
  { type: "text_delta", contentIndex: 0, delta: text },
  { type: "text_end", contentIndex: 0 },
  { type: "done", stopReason: "end_turn", usage },
];

const callEcho = (text: string): Step[] => [
  { type: "toolcall_start", contentIndex: 0, toolCallId: "call_1", toolName: "echo" },
  { type: "toolcall_delta", contentIndex: 0, argsDelta: JSON.stringify({ text }) },
  { type: "toolcall_end", contentIndex: 0 },
  { type: "done", stopReason: "tool_use", usage },
];

// --- fixtures ---

const echo: Tool = {
  name: "echo",
  description: "echoes its input",
  input: z.object({ text: z.string() }),
  execute: async (args) => ({
    content: [{ type: "text", text: (args as { text: string }).text }],
  }),
};

const echoOnly = new Map([[echo.name, echo]]);
const noTools = new Map<string, Tool>();

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });

const inferenceConfig = {
  provider: "scripted",
  model: "scripted-1",
  maxTokens: 512,
  temperature: 0.2,
};

async function newSession(): Promise<string> {
  const agentConfigId = await store.createAgentConfig({
    inference: inferenceConfig,
    systemPrompt: "be brief",
  });
  const envConfigId = await store.createEnvConfig({});
  return store.createSession({ agentConfigId, envConfigId });
}

/** Claim the session's ready item — the tests' stand-in for the loop shell. */
async function claim(sessionId: string, leaseMs = 60_000): Promise<Claim> {
  const claimed = await store.claimItem({ leaseMs, sessionId });
  if (!claimed) throw new Error("expected a claimable item");
  return claimed;
}

async function until(cond: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("until: condition not reached within 10s");
}

const messages = (entries: SessionEntry[]) =>
  entries.filter((entry) => entry.type === "message").map((entry) => entry.message);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// --- the scenarios ---

describe("driver steps over the pg store", () => {
  it("runs a full turn: inference → tools → inference → completion", async () => {
    const sessionId = await newSession();
    const provider = scriptedProvider([callEcho("hi"), sayText("done!")]);
    const deps: DriverDeps = { store, provider, tools: echoOnly };

    await store.intake(sessionId, user("go"));
    await runStep(deps, await claim(sessionId), 60_000); // inference → tool call
    await runStep(deps, await claim(sessionId), 60_000); // execute_tools
    await runStep(deps, await claim(sessionId), 60_000); // inference → end_turn
    // The run ended: its end is the non-creation of a fourth item.
    expect(await store.claimItem({ leaseMs: 60_000, sessionId })).toBeUndefined();

    const log = messages(await store.readEntries(sessionId));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(log[2]).toMatchObject({ toolName: "echo", content: [{ type: "text", text: "hi" }] });
    expect(log[3]).toMatchObject({ stopReason: "end_turn" });

    // The driver assembled the request from the session's config and tools:
    // model + sampling ride through; provider picked the adapter and stops.
    expect(provider.requests[0]).toMatchObject({
      model: "scripted-1",
      maxTokens: 512,
      temperature: 0.2,
    });
    expect(provider.requests[0]).not.toHaveProperty("provider");
    expect(provider.requests[0]?.system).toBe("be brief");
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(provider.requests[1]?.context.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("drains an input queued before the step as steering, not a follow-up", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));
    const queued = await store.intake(sessionId, user("steer"));
    expect(queued.kind).toBe("queued");

    const provider = scriptedProvider([sayText("ok")]);
    await runStep({ store, provider, tools: noTools }, await claim(sessionId), 60_000);

    // Steering shaped the context (appended at the tail)…
    expect(provider.requests[0]?.context.map((m) => m.role)).toEqual(["user", "user"]);
    // …rode in the commit before the step's output, and was consumed.
    const log = messages(await store.readEntries(sessionId));
    expect(log.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(await store.pendingInputs(sessionId)).toHaveLength(0);
    // One run, one item: steering never chains a new run.
    expect(await store.listItems(sessionId)).toHaveLength(1);
  });

  it("auto-chains an input that arrives mid-step into a follow-up run", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));

    const gate = deferred();
    const provider = scriptedProvider([
      [...sayText("first").slice(0, 3), { wait: gate.promise }, sayText("first")[3] as Step],
      sayText("second"),
    ]);
    const deps: DriverDeps = { store, provider, tools: noTools };

    const inFlight = runStep(deps, await claim(sessionId), 60_000);
    // Arrive after run 1's inference prep: too late to steer this step.
    await until(() => provider.requests.length === 1);
    const queued = await store.intake(sessionId, user("follow-up"));
    expect(queued.kind).toBe("queued");
    gate.resolve();
    await inFlight;

    // The terminal commit chained a second run…
    await runStep(deps, await claim(sessionId), 60_000);

    // …with the follow-up as an ordinary user entry after run 1's terminal message.
    const log = messages(await store.readEntries(sessionId));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(provider.requests[1]?.context.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(await store.listItems(sessionId)).toHaveLength(2);
  });

  it("ends a cancelled run at the claim boundary and parks queued inputs", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));
    await store.requestCancel(sessionId);
    const queued = await store.intake(sessionId, user("while cancelled"));
    expect(queued.kind).toBe("queued");

    const provider = scriptedProvider([sayText("fresh")]);
    const deps: DriverDeps = { store, provider, tools: noTools };
    await runStep(deps, await claim(sessionId), 60_000);

    // The run ended without inference, appending nothing; the queued
    // input is parked, not chained.
    expect(provider.requests).toHaveLength(0);
    expect(await store.readEntries(sessionId)).toHaveLength(2); // user + control
    expect(await store.pendingInputs(sessionId)).toHaveLength(1);

    // The consumed cancel does not re-fire: the next intake starts a run
    // that completes normally, draining the parked input as steering.
    const next = await store.intake(sessionId, user("again"));
    expect(next.kind).toBe("started");
    await runStep(deps, await claim(sessionId), 60_000);

    const log = messages(await store.readEntries(sessionId));
    expect(log[log.length - 1]).toMatchObject({ role: "assistant", stopReason: "end_turn" });
    expect(provider.requests[0]?.context.map((m) => m.role)).toEqual(["user", "user", "user"]);
  });

  it("commits a provider failure and ends the run as error — no retry", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));
    const provider = scriptedProvider([[{ throw: new Error("provider exploded") }]]);
    await runStep({ store, provider, tools: noTools }, await claim(sessionId), 60_000);

    const log = messages(await store.readEntries(sessionId));
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(provider.requests).toHaveLength(1);
    expect(await store.claimItem({ leaseMs: 60_000, sessionId })).toBeUndefined();
  });

  it("drops an interrupted step on lease loss; the next claim re-executes", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));
    const provider = scriptedProvider([["untilAborted"], sayText("recovered")]);
    const deps: DriverDeps = { store, provider, tools: noTools };

    const inFlight = runStep(deps, await claim(sessionId, 500), 500);
    await until(() => provider.requests.length === 1);
    clock.advance(10_000); // the next heartbeat reports the lease lost
    await inFlight;

    // The aborted attempt left no trace…
    expect(messages(await store.readEntries(sessionId))).toHaveLength(1);
    // …and the re-claim (fresh token, expired lease) re-executes cleanly.
    await runStep(deps, await claim(sessionId), 60_000);
    const log = messages(await store.readEntries(sessionId));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(log[1]).toMatchObject({ stopReason: "end_turn" });
    expect(provider.requests).toHaveLength(2);
  });

  it("drops the step when the commit is fenced, and the re-claim redoes it", async () => {
    const sessionId = await newSession();
    await store.intake(sessionId, user("go"));

    let fencedOnce = false;
    const fencingStore: Store = {
      ...store,
      commitStep: async (req) => {
        if (!fencedOnce) {
          fencedOnce = true;
          throw new FencedError("injected: reclaimed elsewhere");
        }
        return store.commitStep(req);
      },
    };

    const provider = scriptedProvider([sayText("a"), sayText("b")]);
    const deps: DriverDeps = { store: fencingStore, provider, tools: noTools };

    // First step's commit is fenced: runStep swallows it and drops the work.
    await runStep(deps, await claim(sessionId, 300), 300);
    expect(fencedOnce).toBe(true);
    expect(messages(await store.readEntries(sessionId))).toHaveLength(1);

    // Expire the dropped claim; the re-claim's step commits for real.
    clock.advance(1_000);
    await runStep(deps, await claim(sessionId), 60_000);
    const log = messages(await store.readEntries(sessionId));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(log[1]).toMatchObject({ content: [{ type: "text", text: "b" }] });
    expect(provider.requests).toHaveLength(2);
  });
});
