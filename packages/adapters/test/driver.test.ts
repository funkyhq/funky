// The driver against the real pg store over PGlite — the two halves of
// the Store port's "two callers" story exercised together: intake on
// one side, claim → runStep on the other. runStep is the tested unit;
// runDriver is a thin policy shell around it, covered for real by the
// crash-resume suite at the process level — except its drain, the one
// way it returns, which is exercised here in-process. Scripted
// inference, a real echo tool, and the store's injected clock stand in
// for the world; tests drive steps one at a time, so almost nothing
// here waits.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_NAMESPACE,
  type ProviderEvent,
  type SessionEntry,
  type SessionRef,
  type Usage,
  type UserMessage,
} from "@funky/core";
import {
  type Claim,
  type DriverDeps,
  FencedError,
  type InferenceProvider,
  runDriver,
  runStep,
  type StepDeps,
  type Store,
  type StreamRequest,
  type Tool,
  toToolSpec,
} from "@funky/agent";
import { createPgStore, type StoreDb } from "../src";
import { storeDdl } from "./store-ddl";

let client: PGlite;
let store: Store;
let clock: { advance: (ms: number) => void };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(storeDdl);
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

const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });

const inferenceConfig = {
  provider: "scripted",
  model: "scripted-1",
  maxTokens: 512,
  temperature: 0.2,
};

/** The registry as a worker wires it: this adapter under the id the
 *  config names, and nothing else. */
const serving = (provider: InferenceProvider): ReadonlyMap<string, InferenceProvider> =>
  new Map([[inferenceConfig.provider, provider]]);

async function newSession(inference = inferenceConfig): Promise<SessionRef> {
  const agentConfigRef = await store.createAgentConfig({
    namespace: DEFAULT_NAMESPACE,
    inference,
    systemPrompt: "be brief",
  });
  const envConfigRef = await store.createEnvConfig({ namespace: DEFAULT_NAMESPACE });
  return store.createSession({
    namespace: DEFAULT_NAMESPACE,
    agentConfigId: agentConfigRef.agentConfigId,
    envConfigId: envConfigRef.envConfigId,
  });
}

/** Claim the session's ready item — the tests' stand-in for the loop shell. */
async function claim(ref: SessionRef, leaseMs = 60_000): Promise<Claim> {
  const claimed = await store.claimItem({ leaseMs, session: ref });
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
    const sessionRef = await newSession();
    const provider = scriptedProvider([callEcho("hi"), sayText("done!")]);
    const deps: StepDeps = {
      store,
      providers: serving(provider),
      toolSpecs: [...echoOnly.values()].map(toToolSpec),
    };

    await store.intake(sessionRef, user("go"));
    // Only the execute_tools step receives executables — the loop's
    // ensure-on-claim; inference steps declare specs without a sandbox.
    await runStep(deps, await claim(sessionRef), 60_000); // inference → tool call
    await runStep(deps, await claim(sessionRef), 60_000, echoOnly); // execute_tools
    await runStep(deps, await claim(sessionRef), 60_000); // inference → end_turn
    // The run ended: its end is the non-creation of a fourth item.
    expect(await store.claimItem({ leaseMs: 60_000, session: sessionRef })).toBeUndefined();

    const log = messages(await store.readEntries(sessionRef));
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
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const queued = await store.intake(sessionRef, user("steer"));
    expect(queued.kind).toBe("queued");

    const provider = scriptedProvider([sayText("ok")]);
    await runStep(
      { store, providers: serving(provider), toolSpecs: [] },
      await claim(sessionRef),
      60_000,
    );

    // Steering shaped the context (appended at the tail)…
    expect(provider.requests[0]?.context.map((m) => m.role)).toEqual(["user", "user"]);
    // …rode in the commit before the step's output, and was consumed.
    const log = messages(await store.readEntries(sessionRef));
    expect(log.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(await store.pendingInputs(sessionRef)).toHaveLength(0);
    // One run, one item: steering never chains a new run.
    expect(await store.listItems(sessionRef)).toHaveLength(1);
  });

  it("auto-chains an input that arrives mid-step into a follow-up run", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));

    const gate = deferred();
    const provider = scriptedProvider([
      [...sayText("first").slice(0, 3), { wait: gate.promise }, sayText("first")[3] as Step],
      sayText("second"),
    ]);
    const deps: StepDeps = { store, providers: serving(provider), toolSpecs: [] };

    const inFlight = runStep(deps, await claim(sessionRef), 60_000);
    // Arrive after run 1's inference prep: too late to steer this step.
    await until(() => provider.requests.length === 1);
    const queued = await store.intake(sessionRef, user("follow-up"));
    expect(queued.kind).toBe("queued");
    gate.resolve();
    await inFlight;

    // The terminal commit chained a second run…
    await runStep(deps, await claim(sessionRef), 60_000);

    // …with the follow-up as an ordinary user entry after run 1's terminal message.
    const log = messages(await store.readEntries(sessionRef));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(provider.requests[1]?.context.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(await store.listItems(sessionRef)).toHaveLength(2);
  });

  it("ends a cancelled run at the claim boundary and parks queued inputs", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    await store.requestCancel(sessionRef);
    const queued = await store.intake(sessionRef, user("while cancelled"));
    expect(queued.kind).toBe("queued");

    const provider = scriptedProvider([sayText("fresh")]);
    const deps: StepDeps = { store, providers: serving(provider), toolSpecs: [] };
    await runStep(deps, await claim(sessionRef), 60_000);

    // The run ended without inference, appending nothing; the queued
    // input is parked, not chained.
    expect(provider.requests).toHaveLength(0);
    expect(await store.readEntries(sessionRef)).toHaveLength(2); // user + control
    expect(await store.pendingInputs(sessionRef)).toHaveLength(1);

    // The consumed cancel does not re-fire: the next intake starts a run
    // that completes normally, draining the parked input as steering.
    const next = await store.intake(sessionRef, user("again"));
    expect(next.kind).toBe("started");
    await runStep(deps, await claim(sessionRef), 60_000);

    const log = messages(await store.readEntries(sessionRef));
    expect(log[log.length - 1]).toMatchObject({ role: "assistant", stopReason: "end_turn" });
    expect(provider.requests[0]?.context.map((m) => m.role)).toEqual(["user", "user", "user"]);
  });

  it("commits a provider failure and ends the run as error — no retry", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([[{ throw: new Error("provider exploded") }]]);
    await runStep(
      { store, providers: serving(provider), toolSpecs: [] },
      await claim(sessionRef),
      60_000,
    );

    const log = messages(await store.readEntries(sessionRef));
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(provider.requests).toHaveLength(1);
    expect(await store.claimItem({ leaseMs: 60_000, session: sessionRef })).toBeUndefined();
  });

  it("commits an error and ends the run when the config names a provider this worker does not serve", async () => {
    const sessionRef = await newSession({ ...inferenceConfig, provider: "elsewhere" });
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([sayText("never asked")]);
    await runStep(
      { store, providers: serving(provider), toolSpecs: [] },
      await claim(sessionRef),
      60_000,
    );

    // The step's own outcome, committed — not routed to whatever IS wired,
    // and not left uncommitted for the next claimer to refuse again.
    const log = messages(await store.readEntries(sessionRef));
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({
      role: "assistant",
      content: [],
      model: inferenceConfig.model,
      stopReason: "error",
      errorMessage: expect.stringContaining('"elsewhere"'),
    });
    // …and the message names what this worker would have served.
    expect(log[1]).toMatchObject({ errorMessage: expect.stringContaining("scripted") });
    expect(provider.requests).toHaveLength(0);
    expect(await store.claimItem({ leaseMs: 60_000, session: sessionRef })).toBeUndefined();
  });

  it("synthesizes interrupted results on a re-claimed execute_tools item — no re-execution", async () => {
    const sessionRef = await newSession();
    const provider = scriptedProvider([callEcho("hi"), sayText("recovered")]);
    let executions = 0;
    const spiedEcho: Tool = {
      ...echo,
      execute: async (args, ctx) => {
        executions++;
        return echo.execute(args, ctx);
      },
    };
    const deps: StepDeps = {
      store,
      providers: serving(provider),
      toolSpecs: [...echoOnly.values()].map(toToolSpec),
    };

    await store.intake(sessionRef, user("go"));
    await runStep(deps, await claim(sessionRef), 60_000); // inference → tool call

    // First claim of the execute_tools item dies without committing —
    // whether its side effects ran is unknowable.
    const first = await claim(sessionRef, 300);
    expect(first.item.attempt).toBe(1);
    clock.advance(10_000);
    const second = await claim(sessionRef);
    expect(second.item.attempt).toBe(2);

    await runStep(deps, second, 60_000, new Map([[spiedEcho.name, spiedEcho]]));
    expect(executions).toBe(0);
    const log = messages(await store.readEntries(sessionRef));
    expect(log[2]).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      content: [{ type: "text", text: "Tool execution was interrupted." }],
      isError: true,
    });

    // The run continues: the model sees the interruption and answers.
    await runStep(deps, await claim(sessionRef), 60_000);
    const finalLog = messages(await store.readEntries(sessionRef));
    expect(finalLog.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(finalLog[3]).toMatchObject({ stopReason: "end_turn" });
  });

  it("revalidates the lease at entry: an expired claim does no work at all", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([sayText("later")]);
    const deps: StepDeps = { store, providers: serving(provider), toolSpecs: [] };

    // The lease dies between claim and runStep — the window the loop's
    // sandbox bind occupies. The awaited first beat must catch it.
    const expired = await claim(sessionRef, 300);
    clock.advance(10_000);
    await runStep(deps, expired, 300);
    expect(provider.requests).toHaveLength(0);
    expect(messages(await store.readEntries(sessionRef))).toHaveLength(1);

    // The re-claim executes cleanly.
    await runStep(deps, await claim(sessionRef), 60_000);
    expect(messages(await store.readEntries(sessionRef)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("drops an interrupted inference step on lease loss; the next claim re-executes", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([["untilAborted"], sayText("recovered")]);
    const deps: StepDeps = { store, providers: serving(provider), toolSpecs: [] };

    const inFlight = runStep(deps, await claim(sessionRef, 500), 500);
    await until(() => provider.requests.length === 1);
    clock.advance(10_000); // the next heartbeat reports the lease lost
    await inFlight;

    // The aborted attempt left no trace…
    expect(messages(await store.readEntries(sessionRef))).toHaveLength(1);
    // …and the re-claim (fresh token, expired lease) re-executes cleanly.
    await runStep(deps, await claim(sessionRef), 60_000);
    const log = messages(await store.readEntries(sessionRef));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(log[1]).toMatchObject({ stopReason: "end_turn" });
    expect(provider.requests).toHaveLength(2);
  });

  it("drops the step when the commit is fenced, and the re-claim redoes it", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));

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
    const deps: StepDeps = { store: fencingStore, providers: serving(provider), toolSpecs: [] };

    // First step's commit is fenced: runStep swallows it and drops the work.
    await runStep(deps, await claim(sessionRef, 300), 300);
    expect(fencedOnce).toBe(true);
    expect(messages(await store.readEntries(sessionRef))).toHaveLength(1);

    // Expire the dropped claim; the re-claim's step commits for real.
    clock.advance(1_000);
    await runStep(deps, await claim(sessionRef), 60_000);
    const log = messages(await store.readEntries(sessionRef));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(log[1]).toMatchObject({ content: [{ type: "text", text: "b" }] });
    expect(provider.requests).toHaveLength(2);
  });
});

// --- the drain: the one way runDriver returns ---

describe("runDriver drains", () => {
  /** The loop as the worker hosts it: the scripted provider under the
   *  config's id, echo declared, and whatever `tools` the bind hands back. */
  function hosted(
    provider: InferenceProvider,
    tools: Map<string, Tool> = echoOnly,
  ): { drain: AbortController; deps: DriverDeps } {
    const deps: DriverDeps = {
      store,
      providers: serving(provider),
      toolSpecs: [toToolSpec(echo)],
      bindTools: async () => tools,
    };
    return { drain: new AbortController(), deps };
  }

  it("claims nothing once the drain has fired, and leaves an idle sleep at once", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const { drain, deps } = hosted(scriptedProvider([]));

    // Fired before the loop starts: not even the ready item is claimed.
    drain.abort();
    await runDriver(deps, { drain: drain.signal, drainMs: 50 });
    expect((await store.listItems(sessionRef))[0]?.status).toBe("ready");

    // Fired mid-sleep (an empty session to poll): the sleep wakes, well
    // inside the poll interval.
    const idle = new AbortController();
    const running = runDriver(deps, {
      idlePollMs: 60_000,
      session: await newSession(),
      drain: idle.signal,
      drainMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const t0 = Date.now();
    idle.abort();
    await running;
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("lets a held step commit inside the budget, then returns with the next item unclaimed", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const gate = deferred();
    const provider = scriptedProvider([[{ wait: gate.promise }, ...callEcho("hi")]]);
    const { drain, deps } = hosted(provider);

    const running = runDriver(deps, { idlePollMs: 10, drain: drain.signal, drainMs: 5_000 });
    await until(() => provider.requests.length === 1); // the step is in flight…
    drain.abort();
    gate.resolve(); // …and finishes inside the budget
    await running;

    // Committed, and the item the commit chained is left for another worker.
    expect(messages(await store.readEntries(sessionRef)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect((await store.listItems(sessionRef)).map((i) => [i.type, i.status])).toEqual([
      ["inference", "done"],
      ["execute_tools", "ready"],
    ]);
  });

  it("aborts an inference step past the budget and releases it: the re-claim is immediate", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([["untilAborted"], sayText("recovered")]);
    const { drain, deps } = hosted(provider);

    const running = runDriver(deps, { idlePollMs: 10, drain: drain.signal, drainMs: 100 });
    await until(() => provider.requests.length === 1);
    drain.abort();
    await running;

    // Nothing landed, and — on a 60s lease with no clock advance — the
    // item is claimable only because it was released.
    expect(messages(await store.readEntries(sessionRef))).toHaveLength(1);
    const reclaimed = await claim(sessionRef);
    expect(reclaimed.item.attempt).toBe(2);
    await runStep(deps, reclaimed, 60_000);
    expect(messages(await store.readEntries(sessionRef)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(provider.requests).toHaveLength(2);
  });

  it("aborts a tool batch past the budget — deaf to its signal or not — and the re-claim interrupts it", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([callEcho("slow")]);
    const started = deferred();
    const signals: AbortSignal[] = [];
    // The sandbox tools' shape: the command runs on, deaf to the signal,
    // and the promise never settles.
    const deaf: Tool = {
      ...echo,
      execute: (_args, ctx) =>
        new Promise(() => {
          signals.push(ctx.signal);
          started.resolve();
        }),
    };
    const deafOnly = new Map([[deaf.name, deaf]]);
    const { drain, deps } = hosted(provider, deafOnly);

    const running = runDriver(deps, { idlePollMs: 10, drain: drain.signal, drainMs: 100 });
    await started.promise; // execute_tools claimed at attempt 1, the tool running
    drain.abort();
    expect(signals[0]?.aborted).toBe(false); // the budget is a grace, not an abort
    await running; // returned over the open promise
    expect(signals[0]?.aborted).toBe(true);

    const reclaimed = await claim(sessionRef);
    expect(reclaimed.item).toMatchObject({ type: "execute_tools", attempt: 2 });
    await runStep(deps, reclaimed, 60_000, deafOnly);
    const log = messages(await store.readEntries(sessionRef));
    expect(log.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(log[2]).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Tool execution was interrupted." }],
    });
    expect(signals).toHaveLength(1); // never re-executed
  });

  it("covers the sandbox bind: a drain during a hung bind releases the claim", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([callEcho("hi")]);
    const stepDeps: StepDeps = {
      store,
      providers: serving(provider),
      toolSpecs: [toToolSpec(echo)],
    };
    await runStep(stepDeps, await claim(sessionRef), 60_000); // → execute_tools ready

    const binding = deferred();
    const deps: DriverDeps = {
      ...stepDeps,
      // A sandbox create that never returns.
      bindTools: () =>
        new Promise(() => {
          binding.resolve();
        }),
    };
    const drain = new AbortController();
    const running = runDriver(deps, { idlePollMs: 10, drain: drain.signal, drainMs: 50 });
    await binding.promise;
    drain.abort();
    await running;

    const reclaimed = await claim(sessionRef);
    expect(reclaimed.item).toMatchObject({ type: "execute_tools", attempt: 2 });
  });

  it("waits for the release even when the aborted step settles first", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    // A provider that honors the abort at once: the step returns before
    // the release's round trip, which must still land before the loop
    // does — the host exits the moment the loop returns.
    const provider = scriptedProvider([["untilAborted"]]);
    const gate = deferred();
    let releasing = false;
    let releasedFor: boolean | undefined;
    const gatedStore: Store = {
      ...store,
      releaseItem: async (ref, token) => {
        releasing = true;
        await gate.promise;
        releasedFor = await store.releaseItem(ref, token);
        return releasedFor;
      },
    };
    const { drain, deps } = hosted(provider);

    const running = runDriver(
      { ...deps, store: gatedStore },
      { idlePollMs: 10, drain: drain.signal, drainMs: 20 },
    );
    await until(() => provider.requests.length === 1);
    drain.abort();
    await until(() => releasing);
    // The step has long returned; the loop has not.
    let returned = false;
    void running.then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(returned).toBe(false);
    gate.resolve();
    await running;
    expect(releasedFor).toBe(true);
    expect((await claim(sessionRef)).item.attempt).toBe(2);
  });

  it("counts the budget from the signal, not from a claim that lands after it", async () => {
    const sessionRef = await newSession();
    await store.intake(sessionRef, user("go"));
    const provider = scriptedProvider([["untilAborted"]]);
    // A claim on the wire when the drain fires: it lands 600ms later,
    // and its step gets only what is left of a 1.5s budget — the loop is
    // out about 1.5s after the signal, not 2.1s.
    const claimed = deferred();
    const slowStore: Store = {
      ...store,
      claimItem: async (req) => {
        const result = await store.claimItem(req);
        if (result) {
          claimed.resolve();
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        return result;
      },
    };
    const { drain, deps } = hosted(provider);

    const running = runDriver(
      { ...deps, store: slowStore },
      { idlePollMs: 10, drain: drain.signal, drainMs: 1_500 },
    );
    await claimed.promise;
    const t0 = Date.now();
    drain.abort();
    await running;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(1_900);
    expect((await claim(sessionRef)).item.attempt).toBe(2);
  });

  // --- composition: the worker hosts FUNKY_CONCURRENCY of these loops
  // over one store and one drain signal (apps/worker/src/main.ts). The
  // loop knows nothing of its siblings: that N of them never share an
  // item is the store's guarantee — one open item per session, SKIP
  // LOCKED claims — pinned by the conformance suite ("exactly one winner
  // under contended claims"). What is new in the composition is the
  // drain: one signal, and each loop counts the budget down on its own,
  // so every held claim is released before its loop returns.

  it("one drain signal drains every driver: each held claim is released before its loop returns", async () => {
    const sessions = [await newSession(), await newSession()];
    for (const ref of sessions) await store.intake(ref, user("go"));
    const provider = scriptedProvider([["untilAborted"], ["untilAborted"]]);
    const { drain, deps } = hosted(provider);
    const opts = { idlePollMs: 10, drain: drain.signal, drainMs: 100 };

    const running = Promise.all([runDriver(deps, opts), runDriver(deps, opts)]);
    await until(() => provider.requests.length === 2);
    drain.abort();
    await running;

    for (const ref of sessions) {
      expect(messages(await store.readEntries(ref))).toHaveLength(1);
      expect((await claim(ref)).item.attempt).toBe(2); // released, not merely expired
    }
  });
});
