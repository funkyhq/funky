// H7 — Many sessions, many workers (the soak).
//
// 50 sessions, each scripted with two tool calls, all enqueued at once and drained by 3
// workers — with a seeded 10% chance each tick of killing a worker mid-flight and starting a
// replacement. The closest thing to production. Every session must complete, every command
// must run exactly once (two calls ⇒ two marker lines), no log may hold a duplicate seq, and
// conflicts must stay a trickle (a flood would mean leases are too short).

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FakeTurn } from "@funky/llm";
import type { Metrics, WorkerHandle } from "worker/worker";
import { mulberry32, scriptedLlm, sideEffectCmd } from "./fixtures";
import { buildWorld, resetDb, stopPg, type World, waitFor } from "./harness";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let worlds: World[] = [];
beforeEach(resetDb);
afterEach(async () => {
  for (const w of worlds) await w.cleanup();
  worlds = [];
});
afterAll(stopPg);

/** Two tool calls (each the side-effect command) then a closing message. Both calls write to
 *  the session's ONE marker, so a correct run leaves exactly two lines. */
function twoToolScript(runId: string): FakeTurn[] {
  const cmd = () => ({ kind: "exec" as const, cmd: sideEffectCmd(runId, { sleepSec: 0.2 }) });
  return [{ content: "", toolCall: cmd() }, { content: "", toolCall: cmd() }, { content: "all done" }];
}

it("50 sessions × 3 workers × random kills → all complete, zero double-execution", async () => {
  const N = 50;
  const scripts: Record<string, FakeTurn[]> = {};
  for (let i = 0; i < N; i++) {
    const runId = randomUUID();
    const script = twoToolScript(runId);
    const w = await buildWorld({ runId, script });
    scripts[w.sessionId] = script;
    await w.seedUserMessage();
    await w.enqueueTurnJob();
    worlds.push(w);
  }
  const llm = scriptedLlm(scripts);
  const pool = worlds[0]!.pool;

  // 3 workers. Fast heartbeat (200ms) so a LIVE worker re-extends its lease before the
  // post-kill lease-expiry can steal its in-flight job — only the DEAD worker's jobs get
  // reclaimed. Replacements are started through worlds[0], so its cleanup kills them all.
  const allMetrics: Metrics[] = [];
  const spawn = async (): Promise<WorkerHandle> => {
    const { worker, metrics } = await worlds[0]!.startWorker({ llm, heartbeatMs: 200, concurrency: 8 });
    allMetrics.push(metrics);
    return worker;
  };
  const workers: WorkerHandle[] = [await spawn(), await spawn(), await spawn()];

  const completedCount = async (): Promise<number> => {
    const { rows } = await pool.query<{ c: string }>(
      "select count(distinct session_id)::int as c from session_events where type = 'turn_completed'",
    );
    return Number(rows[0]!.c);
  };

  // Supervisor: seeded kills. No bare Math.random anywhere — the schedule is reproducible.
  const rand = mulberry32(0xc0ffee);
  let kills = 0;
  const start = Date.now();
  const CAP_MS = 120_000;
  for (;;) {
    if ((await completedCount()) >= N) break;
    if (Date.now() - start > CAP_MS) throw new Error(`soak timed out: ${await completedCount()}/${N} completed`);
    if (rand() < 0.1) {
      const idx = Math.floor(rand() * workers.length);
      workers[idx]!.kill(); // stop pulling, stop heartbeats, abandon in-flight
      // Release the dead worker's orphaned jobs promptly (don't wait out the 60s lease). Live
      // workers re-extend within 200ms, so this only permanently frees the abandoned ones.
      await pool.query("update turn_jobs set lease_expires_at = now() - interval '1 minute' where state = 'running'");
      workers[idx] = await spawn();
      kills += 1;
    }
    await sleep(250);
  }

  // Every session completed.
  for (const w of worlds) {
    const events = await w.readEvents();
    expect(events.at(-1)!.type).toBe("turn_completed");
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seqs
    expect(await w.markerLines()).toBe(2); // two calls, each ran exactly once
  }

  const conflicts = allMetrics.reduce((s, m) => s + m.appendConflicts, 0);
  // A trickle is expected from the post-kill reclaim races; a flood means leases are too
  // short. Bound it generously and surface the actuals.
  process.stderr.write(`[H7] kills=${kills} conflicts=${conflicts}\n`);
  expect(conflicts).toBeLessThan(N); // well under one-per-session
}, 150_000);
