// apps/worker/src/worker.ts — Phase E: the turn loop.
//
// A worker is a `while (!draining)` loop around the queue. It calls out and takes work; it
// has no routes and nothing can address it. All the intelligence lives in @funky/sessions
// (runTurn / runProvision) — this file is pure lifecycle: pull, concurrency, heartbeat,
// drain. It holds NO in-memory session state: every meaningful step of a turn is already a
// row in session_events before the next begins, so killing a worker mid-turn loses nothing.
//
// startWorker returns handles rather than doing work at import time, so the loop is
// startable and stoppable in-process (the Phase H chaos suite runs workers inside vitest
// and kills them at arbitrary points).

import type { Client } from "pg";
import type { Db } from "@funky/db";
import type { LlmPort } from "@funky/llm";
import type { SandboxDriver } from "@funky/sandbox";
import {
  type EventStore,
  HEARTBEAT_MS,
  type Job,
  type JobQueue,
  POLL_INTERVAL_MS,
  onWake,
  runProvision,
  runTurn,
  type TurnOutcome,
} from "@funky/sessions";

export type WorkerDeps = {
  queue: JobQueue;
  store: EventStore;
  llm: LlmPort;
  sandbox: SandboxDriver;
  db: Db;
  listenClient: Client; // DEDICATED client for LISTEN (never from the pool)
  concurrency: number; // FUNKY_WORKER_CONCURRENCY
  metrics: Metrics; // counters; see health.ts
  /** Test seam: override the heartbeat interval. Defaults to HEARTBEAT_MS (15s). */
  heartbeatMs?: number;
};

export type WorkerHandle = {
  /** Graceful: stop pulling, let in-flight turns finish, resolve when idle. */
  stop(): Promise<void>;
  /** Ungraceful: abandon everything immediately (simulates SIGKILL). Tests use this. */
  kill(): void;
};

/** Mutable counters shared with health.ts. `inFlight` is the concurrency dial observed;
 *  `jobs` is incremented by queue outcome; `appendConflicts` is the split-brain detector. */
export type Metrics = {
  inFlight: number;
  jobs: Record<TurnOutcome, number>;
  appendConflicts: number;
};

export function createMetrics(): Metrics {
  return {
    inFlight: 0,
    jobs: { completed: 0, failed: 0, conflict: 0, abandoned: 0, retry_later: 0 },
    appendConflicts: 0,
  };
}

const log = (...args: unknown[]) => console.error("[worker]", ...args);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startWorker(deps: WorkerDeps): WorkerHandle {
  const { queue, metrics, concurrency } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  // The subset the domain loop needs. runTurn/runProvision must not touch the queue or the
  // listen client — those are lifecycle concerns owned here.
  const turnDeps = { store: deps.store, llm: deps.llm, sandbox: deps.sandbox, db: deps.db };

  let inFlight = 0;
  let draining = false;
  let killed = false;
  const heartbeats = new Set<ReturnType<typeof setInterval>>();

  // --- wake coordination: idle until a NOTIFY or the fallback poll, whichever is first ---
  let woken = false;
  let wakeResolve: (() => void) | null = null;
  const signalWake = () => {
    woken = true;
    const r = wakeResolve;
    wakeResolve = null;
    r?.();
  };
  // Dedicated client, never a pooled one (a recycled connection goes silently deaf).
  void onWake(deps.listenClient, signalWake).catch((err) => log("listen failed", err));

  const waitForWakeOrTimeout = (ms: number): Promise<void> => {
    if (woken) {
      woken = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeResolve = null;
        resolve();
      }, ms);
      timer.unref?.();
      wakeResolve = () => {
        clearTimeout(timer);
        woken = false;
        resolve();
      };
    });
  };

  const setInFlight = (n: number) => {
    inFlight = n;
    metrics.inFlight = n;
  };

  // handle(job) is NOT awaited by the loop — that is the whole point. The heartbeat pushes
  // the lease out every heartbeatMs while the turn runs; if it fails and the job is stolen,
  // nothing breaks — the conditional append (ErrConflict) stops the loser from writing.
  const handle = async (job: Job): Promise<void> => {
    const beat = setInterval(() => {
      queue.extendLease(job.id).catch((err) => log("heartbeat failed", job.id, err));
    }, heartbeatMs);
    heartbeats.add(beat);
    try {
      const outcome: TurnOutcome =
        job.kind === "provision" ? await runProvision(job, turnDeps) : await runTurn(job, turnDeps);
      if (killed) return; // abandoned by kill(): leave the lease to expire; another worker resumes
      metrics.jobs[outcome] += 1;
      switch (outcome) {
        case "completed":
        case "failed": // a recorded turn_failed IS a completed piece of work — ack, never nack
        case "abandoned":
          await queue.ack(job.id);
          break;
        case "conflict":
          metrics.appendConflicts += 1; // another worker owns it — count it, do NOT log an error
          await queue.ack(job.id);
          break;
        case "retry_later":
          await queue.nack(job.id); // backoff; the queue owns retry scheduling
          break;
      }
    } catch (err) {
      if (killed) return;
      log("turn threw (nacking)", job.id, err); // runTurn shouldn't throw, but be safe
      await queue.nack(job.id).catch((e) => log("nack failed", job.id, e));
    } finally {
      clearInterval(beat);
      heartbeats.delete(beat);
    }
  };

  const run = async (): Promise<void> => {
    for (;;) {
      if (draining || killed) return;
      if (inFlight >= concurrency) {
        await sleep(50); // backpressure: only pull when under the limit
        continue;
      }
      let job: Job | null;
      try {
        job = await queue.pull();
      } catch (err) {
        log("pull failed", err);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!job) {
        await waitForWakeOrTimeout(POLL_INTERVAL_MS);
        continue;
      }
      if (draining || killed) return; // shutting down between pull and dispatch — let the lease expire
      setInFlight(inFlight + 1);
      void handle(job).finally(() => setInFlight(inFlight - 1));
    }
  };
  const loopDone = run();

  return {
    async stop() {
      draining = true;
      signalWake(); // break any in-progress idle wait so the loop exits promptly
      await loopDone; // no more pulls
      // In-flight turns keep their leases alive via heartbeat while they finish.
      while (inFlight > 0) await sleep(25);
    },
    kill() {
      killed = true;
      draining = true;
      signalWake();
      // Stop heartbeats so the abandoned jobs' leases expire and another worker reclaims
      // them. In-flight turn promises can't be force-cancelled, but the conditional append
      // makes any late write from this worker a harmless ErrConflict.
      for (const beat of heartbeats) clearInterval(beat);
      heartbeats.clear();
    },
  };
}
