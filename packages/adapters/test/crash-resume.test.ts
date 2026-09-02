// The crash-resume property test — the durability contract made
// executable: for ANY kill point during a scripted two-turn run,
// SIGKILL + resume by a fresh driver converges on the reference
// transcript — verbatim, except that a batch whose execute_tools claim
// was killed mid-flight commits interrupted results instead (the
// attempt > 1 carve-out: tool side effects are at-most-once, so a
// re-claim never re-executes them). This is also runDriver's real
// coverage — a child process hosting the actual loop, killed the only
// way it ever stops.
//
// Topology: PGlite is single-client, so data-dir ownership alternates —
// the parent seeds and inspects only while no child is alive, and
// follows a live child's progress through IPC signals from the child's
// store wrapper (see fixtures/crash-driver.ts). Children run on the
// real clock with short leases (300ms), so a dead child's claim expires
// almost immediately and the resuming child picks up from the unchanged
// log — re-running inference, interrupting a claimed tool batch.
//
// Two modes:
// - a deterministic matrix: the child stalls at a scheduled point
//   (after claim, mid-inference, mid-tools, before commit, after
//   commit) and is killed there;
// - a randomized sweep (seeded; CRASH_SWEEP_ITERATIONS/CRASH_SWEEP_SEED
//   scale it in CI): kill after a random delay, 1–n crashes per run —
//   covering what can't be scheduled, chiefly mid-commitStep.
//
// Under CPU contention a live child can lose a lease it deserved; the
// property absorbs that by design — wasted work, never wrong work — so
// the scenarios below run concurrently without risking correctness.

import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_NAMESPACE, type SessionRef } from "@funky/core";
import { runStep, type StepDeps, type Store, toToolSpec } from "@funky/agent";
import { createPgStore, type StoreDb } from "../src";
import {
  createProvider,
  createTools,
  inferenceConfig,
  type KillSpec,
  normalizeEntries,
  PROMPTS,
  user,
} from "./fixtures/crash-script";
import { storeDdl } from "./store-ddl";
const driverPath = fileURLToPath(new URL("./fixtures/crash-driver.ts", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const LEASE_MS = 300;
const SWEEP_ITERATIONS = Number(process.env["CRASH_SWEEP_ITERATIONS"] ?? 6);
const SWEEP_SEED = Number(process.env["CRASH_SWEEP_SEED"] ?? 20_260_816);

let workRoot: string;
let templateFresh: string; // seeded: config + session + turn-one intake
let templateMidway: string; // turn one complete + turn-two intake
let sessionRef: SessionRef;
let refEntries: unknown[];
let refItemTypes: string[];

// --- data-dir plumbing (parent side, only ever while no child lives) ---

async function openDir(dir: string): Promise<{ store: Store; close: () => Promise<void> }> {
  const client = new PGlite(dir);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  return { store, close: () => client.close() };
}

let copies = 0;
async function copyOf(template: string): Promise<string> {
  const dir = join(workRoot, `scenario-${copies++}`);
  await cp(template, dir, { recursive: true });
  return dir;
}

/** The parent's in-process driver — used only to build templates and the
 *  uninterrupted reference; the same runStep the children run. */
async function driveToIdle(store: Store): Promise<void> {
  const tools = createTools();
  const deps: StepDeps = {
    store,
    providers: new Map([[inferenceConfig.provider, createProvider()]]),
    toolSpecs: [...tools.values()].map(toToolSpec),
  };
  for (;;) {
    const claim = await store.claimItem({ leaseMs: 60_000 });
    if (!claim) return;
    await runStep(deps, claim, 60_000, tools);
  }
}

async function intakeSecondPrompt(dir: string): Promise<void> {
  const { store, close } = await openDir(dir);
  try {
    const result = await store.intake(sessionRef, user(PROMPTS[1]));
    if (result.kind !== "started") {
      throw new Error(`expected turn-two intake to start a run, got "${result.kind}"`);
    }
  } finally {
    await close();
  }
}

/**
 * The reference transcript with the given toolResult batches replaced by
 * what a re-claimed execute_tools item commits: interrupted results,
 * never re-executed side effects (the attempt > 1 carve-out).
 */
function withInterrupted(entries: unknown[], batches: number[]): unknown[] {
  let batch = 0;
  return entries.map((entry) => {
    const e = entry as { message?: { role?: string; toolCallId?: string; toolName?: string } };
    if (e.message?.role !== "toolResult") return entry;
    if (!batches.includes(batch++)) return entry;
    return {
      ...(entry as object),
      message: {
        role: "toolResult",
        toolCallId: e.message.toolCallId,
        toolName: e.message.toolName,
        content: [{ type: "text", text: "Tool execution was interrupted." }],
        isError: true,
      },
    };
  });
}

/** Every interruption shape the sweep's random kills can produce. */
const ANY_INTERRUPTION: number[][] = [[], [0], [1], [0, 1]];

async function assertMatchesReference(dir: string, acceptable: number[][] = [[]]): Promise<void> {
  const { store, close } = await openDir(dir);
  try {
    const actual = normalizeEntries(await store.readEntries(sessionRef));
    const variants = acceptable.map((batches) => withInterrupted(refEntries, batches));
    if (variants.length === 1) expect(actual).toEqual(variants[0]);
    else expect(variants).toContainEqual(actual);
    const items = await store.listItems(sessionRef);
    expect(items.map((i) => i.type)).toEqual(refItemTypes);
    expect(items.map((i) => i.status)).toEqual(refItemTypes.map(() => "done"));
    expect(await store.pendingInputs(sessionRef)).toEqual([]);
  } finally {
    await close();
  }
}

// --- the child harness ---

interface ChildMsg {
  t: string;
  n?: number;
  next?: string;
  itemType?: string;
}

interface DriverHandle {
  received: ChildMsg[];
  /** Resolves with the first matching signal (buffered or future);
   *  undefined if the child was killed first; rejects on timeout or on
   *  an unexpected child death, with captured output attached. */
  waitFor(
    pred: (m: ChildMsg) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<ChildMsg | undefined>;
  kill(): Promise<void>;
}

function forkDriver(dir: string, spec?: KillSpec): DriverHandle {
  const child: ChildProcess = fork(driverPath, [], {
    cwd: packageRoot,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      CRASH_DATA_DIR: dir,
      CRASH_LEASE_MS: String(LEASE_MS),
      ...(spec ? { CRASH_KILL_SPEC: JSON.stringify(spec) } : {}),
    },
  });

  let output = "";
  const capture = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-4_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const received: ChildMsg[] = [];
  interface Waiter {
    pred: (m: ChildMsg) => boolean;
    resolve: (m: ChildMsg | undefined) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  let waiters: Waiter[] = [];
  let killed = false;
  let died = false;

  const fail = (label: string): Error =>
    new Error(`${label} — child output:\n${output || "(none)"}`);

  child.on("message", (m) => {
    const msg = m as ChildMsg;
    received.push(msg);
    const matched = waiters.filter((w) => w.pred(msg));
    waiters = waiters.filter((w) => !w.pred(msg));
    for (const w of matched) {
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  });
  const onGone = (): void => {
    if (killed) return;
    died = true;
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(fail("child died unexpectedly"));
    }
  };
  child.on("exit", onGone);
  child.on("error", onGone);

  return {
    received,
    // Inner timeouts stay below the test timeouts: a rejected wait runs
    // the caller's reap-finally, while a vitest timeout would strand the
    // async body mid-await and leak live children.
    waitFor(pred, label, timeoutMs = 60_000) {
      const hit = received.find(pred);
      if (hit) return Promise.resolve(hit);
      if (died) return Promise.reject(fail(`${label}: child already dead`));
      if (killed) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          pred,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters = waiters.filter((w) => w !== waiter);
            reject(fail(`${label}: no matching signal within ${timeoutMs}ms`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async kill() {
      killed = true;
      const pending = waiters;
      waiters = [];
      for (const w of pending) {
        clearTimeout(w.timer);
        w.resolve(undefined);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
  };
}

const endRun = (m: ChildMsg): boolean => m.t === "committed" && m.next === "end_run";
const countEndRuns = (msgs: ChildMsg[]): number => msgs.filter(endRun).length;

// --- setup: templates + the uninterrupted reference ---

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "crash-resume-"));

  templateFresh = join(workRoot, "template-fresh");
  {
    const client = new PGlite(templateFresh);
    await client.exec(storeDdl);
    const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
    const agentConfigRef = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: inferenceConfig,
      systemPrompt: "be brief",
    });
    const envConfigRef = await store.createEnvConfig({ namespace: DEFAULT_NAMESPACE });
    sessionRef = await store.createSession({
      namespace: DEFAULT_NAMESPACE,
      agentConfigId: agentConfigRef.agentConfigId,
      envConfigId: envConfigRef.envConfigId,
    });
    const result = await store.intake(sessionRef, user(PROMPTS[0]));
    if (result.kind !== "started") throw new Error("seed intake did not start a run");
    await client.close();
  }

  templateMidway = join(workRoot, "template-midway");
  await cp(templateFresh, templateMidway, { recursive: true });
  {
    const { store, close } = await openDir(templateMidway);
    await driveToIdle(store);
    const result = await store.intake(sessionRef, user(PROMPTS[1]));
    if (result.kind !== "started") throw new Error("turn-two intake did not start a run");
    await close();
  }

  const referenceDir = join(workRoot, "reference");
  await cp(templateMidway, referenceDir, { recursive: true });
  {
    const { store, close } = await openDir(referenceDir);
    await driveToIdle(store);
    refEntries = normalizeEntries(await store.readEntries(sessionRef));
    refItemTypes = (await store.listItems(sessionRef)).map((i) => i.type);
    await close();
  }

  // Pin the reference itself, so a broken script can't make the property
  // vacuously true over a degenerate transcript.
  const roles = refEntries.map((e) => (e as { message: { role: string } }).message.role);
  const expectRoles = ["user", "assistant", "toolResult", "assistant"];
  expect(roles).toEqual([...expectRoles, ...expectRoles]);
  expect(refItemTypes).toEqual([
    "inference",
    "execute_tools",
    "inference",
    "inference",
    "execute_tools",
    "inference",
  ]);
}, 120_000);

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

// --- the deterministic matrix ---

interface Scenario {
  /** fresh = both turns ahead of the child; midway = turn one already
   *  complete and turn two started, so child-local counts index turn two. */
  seed: "fresh" | "midway";
  spec: KillSpec;
  /** toolResult batches the resume commits as interrupted results: set
   *  exactly when the kill lands while an execute_tools claim is open
   *  (claimed, uncommitted), so the re-claim sees attempt > 1 and never
   *  re-executes. Omitted = the reference transcript verbatim. */
  interrupted?: number[];
}

// Turn one exhaustively (claims/commits 0-2 are the child's whole life);
// turn two by representatives — same classes over deeper history plus
// the idle → intake transition already crossed.
const MATRIX: Scenario[] = [
  { seed: "fresh", spec: { class: "after-claim", n: 0 } },
  { seed: "fresh", spec: { class: "mid-inference", n: 0 } },
  { seed: "fresh", spec: { class: "before-commit", n: 0 } },
  { seed: "fresh", spec: { class: "after-commit", n: 0 } },
  { seed: "fresh", spec: { class: "after-claim", n: 1 }, interrupted: [0] },
  { seed: "fresh", spec: { class: "mid-tools", n: 0 }, interrupted: [0] },
  // Killed after executing but before committing: the tools DID run, the
  // commit never landed — the re-claim still must not run them again.
  { seed: "fresh", spec: { class: "before-commit", n: 1 }, interrupted: [0] },
  { seed: "fresh", spec: { class: "after-commit", n: 1 } },
  { seed: "fresh", spec: { class: "mid-inference", n: 1 } },
  { seed: "fresh", spec: { class: "before-commit", n: 2 } },
  { seed: "fresh", spec: { class: "after-commit", n: 2 } }, // after end_run
  { seed: "midway", spec: { class: "after-claim", n: 0 } },
  { seed: "midway", spec: { class: "mid-inference", n: 2 } },
  { seed: "midway", spec: { class: "mid-tools", n: 1 }, interrupted: [1] },
  { seed: "midway", spec: { class: "before-commit", n: 2 } }, // before turn-two end_run
];

async function runScenario(sc: Scenario): Promise<void> {
  const dir = await copyOf(sc.seed === "fresh" ? templateFresh : templateMidway);
  const targetEndRuns = sc.seed === "fresh" ? 2 : 1;
  let intaken = sc.seed === "midway";
  // A rejected wait must still reap its child — runDriver polls forever,
  // so an orphan would outlive the test. kill() is idempotent.
  const children: DriverHandle[] = [];

  try {
    const crash = forkDriver(dir, sc.spec);
    children.push(crash);
    await crash.waitFor((m) => m.t === "stalled", "crash phase: stall point");
    await crash.kill();
    let endRuns = countEndRuns(crash.received);

    while (endRuns < targetEndRuns) {
      if (endRuns >= 1 && !intaken) {
        await intakeSecondPrompt(dir);
        intaken = true;
      }
      const resume = forkDriver(dir);
      children.push(resume);
      await resume.waitFor(endRun, "resume phase: end_run commit");
      await resume.kill();
      endRuns += countEndRuns(resume.received);
    }

    await assertMatchesReference(dir, [sc.interrupted ?? []]);
  } finally {
    for (const child of children) await child.kill();
  }
}

describe.concurrent("crash-resume: deterministic kill points", () => {
  it.each(MATRIX.map((sc) => [`${sc.seed} ${sc.spec.class}#${sc.spec.n}`, sc] as const))(
    "%s: killed there, a fresh driver converges on the reference",
    async (_name, sc) => {
      await runScenario(sc);
    },
    180_000,
  );
});

// --- the randomized sweep ---

/** Deterministic PRNG so a failing iteration is reproducible from its
 *  logged seed (CRASH_SWEEP_SEED + iteration). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.concurrent("crash-resume: randomized sweep", () => {
  it.each(Array.from({ length: SWEEP_ITERATIONS }, (_, i) => i))(
    "sweep #%d: random SIGKILLs, then convergence",
    async (i) => {
      const rng = mulberry32(SWEEP_SEED + i);
      const label = `sweep #${i} (seed ${SWEEP_SEED + i})`;
      const dir = await copyOf(templateFresh);
      let endRuns = 0;
      let intaken = false;
      let attempts = 0;
      const children: DriverHandle[] = [];

      try {
        while (endRuns < 2) {
          if (endRuns >= 1 && !intaken) {
            await intakeSecondPrompt(dir);
            intaken = true;
          }
          attempts++;
          if (attempts > 20) throw new Error(`${label}: no progress after 20 children`);
          const child = forkDriver(dir);
          children.push(child);
          // Arm the kill timer only at the child's ready signal — timed
          // from fork it races process startup, which loses on a cold,
          // contended CI runner; a pre-ready kill exercises nothing (no
          // claim can precede the store existing). The escalating floor
          // rides out lease expiry from the previous kill; the random
          // tail scatters the kill over claims, steps, and commits.
          await child.waitFor((m) => m.t === "ready", `${label}: child ready`, 90_000);
          const delay = 100 + attempts * 200 + Math.floor(rng() * 800);
          await Promise.race([child.waitFor(endRun, `${label}: end_run`, 60_000), sleep(delay)]);
          await child.kill();
          endRuns += countEndRuns(child.received);
        }

        // Random kills may land on open execute_tools claims, so any
        // interruption shape is legitimate — but nothing else is.
        await assertMatchesReference(dir, ANY_INTERRUPTION);
      } finally {
        for (const child of children) await child.kill();
      }
    },
    300_000,
  );
});
