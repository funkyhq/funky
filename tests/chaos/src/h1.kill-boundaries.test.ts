// H1 — Kill at every append boundary ★ (the headline).
//
// For each of the four appends the worker makes, crash worker A the instant that append
// commits, then let a clean worker B finish. The final log must be byte-for-byte the
// reference log every time, the command must have run exactly once, and the turn must end
// completed. A failure at boundary N is a real bug at the Nth append — not a flaky test.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppendHook } from "@funky/sessions";
import type { WorkerHandle } from "worker/worker";
import { KillWorker } from "./fixtures";
import { buildWorld, normalize, REFERENCE_LOG, resetDb, stopPg, type World, waitFor } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

// The worker makes 4 appends: assistant_message(2), tool_result(3), assistant_message(4),
// turn_completed(5). REFERENCE_LOG's first entry (user_message) is seeded, not appended.
const APPENDS = REFERENCE_LOG.length - 1; // = 4

describe("H1 — crash at each append boundary → the log always matches", () => {
  for (let n = 1; n <= APPENDS; n++) {
    it(`kill worker A after append #${n}, worker B finishes → REFERENCE_LOG`, async () => {
      world = await buildWorld();
      await world.seedUserMessage();
      const jobId = await world.enqueueTurnJob();

      // Crash A exactly when its Nth append commits: kill (stop heartbeats, abandon) + throw.
      let workerA: WorkerHandle;
      let dead = false;
      let count = 0;
      const hook: AppendHook = () => {
        count += 1;
        if (count === n) {
          workerA.kill(); // SIGKILL: no ack, no lease release, no in-flight cleanup
          dead = true;
          throw new KillWorker();
        }
      };
      const a = await world.startWorker({ store: world.hookedStore(hook) });
      workerA = a.worker;

      await waitFor(() => dead, 30_000, `A reaches append #${n}`);

      // B can only claim once A's lease expires. Don't sleep 60s — expire it directly.
      await world.expireLease(jobId);
      await world.startWorker(); // clean worker B

      // Wait for B to finish AND ack. For N=4 the terminal event is already present (A wrote
      // it before dying), so waiting on the event alone would race B's reclaim + ack — the
      // job being gone is the unambiguous "B fully processed it" signal.
      await waitFor(async () => !(await world.jobExists(jobId)), 30_000, "B completes and acks");

      const events = await world.readEvents();
      expect(normalize(events)).toEqual(REFERENCE_LOG); // I1

      // I2 — exactly one tool_result per tool_call (no duplicate execution recorded).
      const toolCalls = events.filter(
        (e) => e.type === "assistant_message" && (e.payload as { tool_calls: unknown[] }).tool_calls.length > 0,
      );
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(toolCalls.length);
      expect(toolResults).toHaveLength(1);

      expect(await world.markerLines()).toBe(1); // I3 — the command ran exactly once
      expect(events.at(-1)!.type).toBe("turn_completed"); // I4
      expect(await world.jobExists(jobId)).toBe(false); // B acked
    });
  }
});
