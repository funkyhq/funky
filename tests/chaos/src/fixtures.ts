// tests/chaos/src/fixtures.ts — the scripted turns, the side-effect command, and the
// specialised sandboxes/LLMs the chaos scenarios crash into.
//
// Two design choices that make the whole suite deterministic and crash-safe:
//
//   1. The LLMs here are LOG-AWARE, not cursor-based. The stock FakeLlm advances an
//      in-memory cursor per complete() call; that desyncs from the log the instant two
//      workers drive one session or a worker resumes another's turn. `scriptedLlm` instead
//      derives the turn index from the REBUILT CONTEXT (count of assistant messages), which
//      IS the log. Any worker, at any resume point, computes the same next turn. This is the
//      single most important fixture: without it, "the log is the only state" is a lie the
//      LLM quietly breaks.
//
//   2. Every tool call runs the SIDE-EFFECT command, which appends one line per real
//      execution to a per-run marker file. Counting the lines counts executions. One line ⇒
//      the command ran exactly once, whatever the crashes.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FakeTurn, LlmPort, LlmResult } from "@funky/llm";
import type { ResolvedEnv } from "@funky/db/schema";
import {
  type Executor,
  type SandboxDriver,
  type SandboxHandle,
  SandboxUnavailableError,
} from "@funky/sandbox";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sentinel an append hook throws to abandon a turn mid-flight. runTurn's error policy sees
 *  it as a generic (transient) fault → retry_later; combined with a worker.kill() in the same
 *  hook, the worker returns without ack/nack and the job's lease is left to expire — exactly
 *  what SIGKILL does. It never reaches the log (transient classes don't). */
export class KillWorker extends Error {
  readonly kind = "kill_worker" as const;
}

// ---------------------------------------------------------------------------
// The side-effect command — the I3 (no-double-execution) detector.
// ---------------------------------------------------------------------------
export const MARKER_ROOT = "/tmp/funky-chaos";

/** Per-run marker directory. Namespaced by runId so parallel scenarios never contaminate
 *  each other (see the handoff's "shared marker path" pitfall). */
export function markerDir(runId: string): string {
  return path.join(MARKER_ROOT, runId);
}
export function markerFile(runId: string): string {
  return path.join(markerDir(runId), "marker");
}

/** Build the scripted tool command. Every execution appends `ran-<pid>` to the run's
 *  marker, sleeps, then prints `done` (which becomes the tool_result output). Writing to
 *  an ABSOLUTE host path works only because the subprocess driver has no isolation — that's
 *  exactly the driver this phase pins the claim against. `mkdir -p` makes it self-creating.
 *  A distinct `label` gives a session's SECOND tool call its own marker line source. */
export function sideEffectCmd(runId: string, opts: { sleepSec?: number } = {}): string {
  const dir = markerDir(runId);
  const sleepSec = opts.sleepSec ?? 0.5;
  return `mkdir -p ${dir}; echo "ran-$$" >> ${dir}/marker; sleep ${sleepSec}; echo done`;
}

/** Count real executions = non-empty lines in the marker. Absent file ⇒ 0 (never ran). */
export async function countMarkerLines(runId: string): Promise<number> {
  try {
    const raw = await fs.readFile(markerFile(runId), "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Remove a run's marker tree (best-effort; called from world cleanup). */
export async function removeMarker(runId: string): Promise<void> {
  await fs.rm(markerDir(runId), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Log-aware scripted LLM — the deterministic, crash-safe brain.
// ---------------------------------------------------------------------------
/** turn index = number of assistant messages already in the rebuilt context = number of
 *  assistant_message events in the log. So the NEXT inference always selects the correct
 *  script turn regardless of which worker runs it or where a crash landed. Script exhausted
 *  ⇒ a terminal turn with no tool call (the reducer then finishes). */
export function scriptedLlm(scripts: Record<string, FakeTurn[]>): LlmPort {
  return {
    async complete(req) {
      const sid = req.trace?.sessionId;
      if (!sid) throw new Error("scriptedLlm requires req.trace.sessionId");
      const script = scripts[sid] ?? [];
      const turnIndex = req.messages.filter((m) => m.role === "assistant").length;
      const turn = script[turnIndex];
      const content = turn?.content ?? "done";
      const result: LlmResult = {
        content,
        usage: { inputTokens: req.messages.length, outputTokens: content.length },
      };
      if (turn?.toolCall) result.toolCall = turn.toolCall;
      return result;
    },
  };
}

/** Wrap an LLM so the FIRST inference of every party blocks until `parties` of them have
 *  arrived, then all proceed together. Forces a genuine seq-race for the double-delivery
 *  scenario: without it, a fast winner can finish the whole turn before the loser reads the
 *  log, and no conflict ever fires. Later inferences pass straight through. */
export function gatedLlm(inner: LlmPort, parties: number): LlmPort {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return {
    async complete(req) {
      if (arrived < parties) {
        arrived += 1;
        if (arrived >= parties) open();
        await gate;
      }
      return inner.complete(req);
    },
  };
}

/** A slow brain: sleeps before every inference. Used to hold a lease open past expiry while
 *  the heartbeat is disabled, so a second worker reclaims the job mid-turn. */
export function sleepyLlm(scripts: Record<string, FakeTurn[]>, sleepMs: number): LlmPort {
  const inner = scriptedLlm(scripts);
  return {
    async complete(req) {
      await sleep(sleepMs);
      return inner.complete(req);
    },
  };
}

// ---------------------------------------------------------------------------
// Specialised sandboxes.
// ---------------------------------------------------------------------------
/** A sandbox that can never observe a result: exec/attach throw SandboxUnavailableError.
 *  Drives the terminal-event guarantee (H5): every attempt fails, and the last one must
 *  escalate to turn_failed(SANDBOX_FATAL) instead of hanging the session. */
export function alwaysFailSandbox(): SandboxDriver {
  const boom = (): never => {
    throw new SandboxUnavailableError("chaos: sandbox permanently unavailable");
  };
  const executor: Executor = {
    exec: () =>
      (async function* () {
        boom();
      })(),
    attach: () =>
      (async function* () {
        boom();
      })(),
    async readFile() {
      return boom();
    },
    async writeFile() {
      return boom();
    },
  };
  return {
    async provision(_spec: ResolvedEnv, _sessionId: string): Promise<SandboxHandle> {
      return { driver: "subprocess", workdir: "/tmp/funky/chaos-unavailable" };
    },
    async reboot(h: SandboxHandle) {
      return h;
    },
    async teardown() {},
    connect() {
      return executor;
    },
  };
}

/** Wrap a real driver so exec SPAWNS the detached command (via the real driver, so its
 *  subprocess outlives this worker) but this worker NEVER observes the exit — it hangs, as
 *  if SIGKILLed mid-command. `onSpawned` fires right after the spawn is kicked off so the
 *  test can schedule the kill. A second worker, replaying the log, exec's the SAME idemKey
 *  and ATTACHES to the still-running command (it does not re-run it). This is the whole
 *  point of H4: attach, not re-execute. */
export function spawnThenHangSandbox(real: SandboxDriver, onSpawned: () => void): SandboxDriver {
  return {
    provision: (spec, sid) => real.provision(spec, sid),
    reboot: (h) => real.reboot(h),
    teardown: (h) => real.teardown(h),
    connect(handle) {
      const inner = real.connect(handle);
      return {
        exec(req) {
          // Drive the real exec in the background: this actually spawns the detached
          // command. We discard its output — this worker is about to "die".
          void drain(inner.exec(req));
          onSpawned();
          return (async function* () {
            await new Promise<never>(() => {}); // hang forever; no exit, no tool_result
          })();
        },
        attach: (k) => inner.attach(k),
        readFile: (p) => inner.readFile(p),
        writeFile: (p, d) => inner.writeFile(p, d),
      };
    },
  };
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _ of it) {
      /* discard: we only need the command to spawn and run */
    }
  } catch {
    /* the worker is dead; its errors are irrelevant */
  }
}

// ---------------------------------------------------------------------------
// Deterministic randomness — the soak's kill schedule must be reproducible (no bare
// Math.random(); see the CI determinism requirement).
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
