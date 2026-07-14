// H4 — Re-attach to a running command ★.
//
// Worker A spawns a 3-second command, then is killed mid-command — BEFORE it records the
// tool_result. The command keeps running (the subprocess driver spawns it detached, so it
// outlives the worker). Worker B replays the log, sees the unanswered tool call, and exec's
// the SAME idemKey — which ATTACHES to the still-running command instead of re-running it.
//
// The marker is the definitive proof: exactly one line ⇒ the command body executed once,
// never twice. (With the subprocess driver the abandoned command runs to completion in the
// background regardless, so wall-time can't distinguish attach from a fresh, overlapping
// re-run the way it could against an in-sandbox driver — the idemKey dedupe is what makes B
// attach, and the marker is what proves it. Wall-time still bounds out a *serial* 6s
// double-run.)

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WorkerHandle } from "worker/worker";
import { spawnThenHangSandbox } from "./fixtures";
import {
  buildWorld,
  normalize,
  REFERENCE_LOG,
  resetDb,
  singleToolScript,
  stopPg,
  type World,
  waitFor,
} from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("B attaches to A's still-running command: it finishes the turn, running the command once", async () => {
  // A 3-second side-effect command so "mid-command" is a wide, reliable window.
  const runId = randomUUID();
  world = await buildWorld({ runId, script: singleToolScript(runId, { sleepSec: 3 }) });
  await world.seedUserMessage();
  const jobId = await world.enqueueTurnJob();

  // A's sandbox spawns the real detached command, then hangs. `onSpawned` schedules the kill
  // 100ms after the exec starts — mid-command, before any tool_result.
  let workerA: WorkerHandle;
  let killedAt = 0;
  const t0 = Date.now();
  const sandboxA = spawnThenHangSandbox(world.sandbox, () => {
    setTimeout(() => {
      workerA.kill();
      killedAt = Date.now();
    }, 100);
  });
  const a = await world.startWorker({ sandbox: sandboxA });
  workerA = a.worker;

  await waitFor(() => killedAt > 0, 30_000, "A killed mid-command");
  await world.expireLease(jobId);

  // B — real sandbox — replays the log and exec's the same idemKey → attaches.
  await world.startWorker();
  await waitFor(async () => (await world.eventTypes()).at(-1) === "turn_completed", 30_000, "B completes");
  const totalMs = Date.now() - t0;

  const events = await world.readEvents();
  const toolResult = events.find((e) => e.type === "tool_result")!;
  expect((toolResult.payload as { output: string }).output).toContain("done"); // B saw the full output
  expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  expect(normalize(events)).toEqual(REFERENCE_LOG);

  expect(await world.markerLines()).toBe(1); // ★ the command was NOT re-run
  expect(totalMs).toBeLessThan(5000); // one 3s command era, not a serial 3s+3s=6s re-run
});
