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

  await waitFor(async () => (await world.eventTypes()).at(-1) === "turn_failed", 45_000, "turn_failed");

  const events = await world.readEvents();
  const last = events.at(-1)!;
  expect(last.type).toBe("turn_failed");
  expect((last.payload as { error_class: string }).error_class).toBe("SANDBOX_FATAL"); // I4

  // The queue stopped retrying: no active job remains (acked after recording the terminal
  // event, or dead-lettered — either way, not queued/running).
  const state = await world.jobState(jobId);
  expect(state === null || state === "dead").toBe(true);
});
