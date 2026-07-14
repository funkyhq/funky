// H5 — Terminal-event guarantee (I4).
//
// A sandbox that can never come up. Every attempt fails and retries with backoff; the LAST
// attempt must ESCALATE to a terminal turn_failed(SANDBOX_FATAL) instead of retrying
// forever. Without that escalation this test hangs the session — which is exactly the
// regression it exists to catch.
//
// (The handoff describes the dead job loosely as "state 'dead'". The runtime does something
// stronger: the escalation records turn_failed IN THE LOG — where the user sees it — and
// acks the job. So we assert the invariant that matters, I4: the session ends terminal and
// the queue stops retrying, never that the failure is stranded in a dead job row.)

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { alwaysFailSandbox } from "./fixtures";
import { buildWorld, resetDb, stopPg, type World, waitFor } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("permanently broken sandbox → turn_failed(SANDBOX_FATAL), never a hang", async () => {
  world = await buildWorld();
  await world.seedUserMessage();
  // maxAttempts:2 keeps the backoff short (one ~2s retry) — the escalation still fires on the
  // last attempt, which is the whole point.
  const jobId = await world.enqueueTurnJob({ maxAttempts: 2 });

  await world.startWorker({ sandbox: alwaysFailSandbox() });

  // The escalation records turn_failed and THEN acks the job. Wait for the queue to settle
  // (job gone, or dead-lettered) so the assertions don't race the ack; the ack happens after
  // the turn_failed commit, so a settled job guarantees the terminal event is in the log.
  await waitFor(
    async () => {
      const s = await world.jobState(jobId);
      return s === null || s === "dead";
    },
    45_000,
    "job settled (terminal)",
  );

  const events = await world.readEvents();
  const last = events.at(-1)!;
  expect(last.type).toBe("turn_failed"); // I4 — the session ended, it did not hang
  expect((last.payload as { error_class: string }).error_class).toBe("SANDBOX_FATAL");
});
