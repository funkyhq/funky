// H3 — Slow-but-alive worker vs. lease expiry.
//
// Worker A is alive but slow (its inference sleeps past the lease) and its heartbeat is
// effectively disabled. Its lease expires and worker B legitimately reclaims the job. Now
// BOTH are alive and driving the same session. The lease was an optimization; the PK is the
// truth. The log must stay consistent and exactly one turn must complete.

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { scriptedLlm, sleepyLlm } from "./fixtures";
import { buildWorld, normalize, REFERENCE_LOG, resetDb, stopPg, type World, waitFor } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("slow A + fresh B race the same session → one consistent, completed log", async () => {
  world = await buildWorld();
  await world.seedUserMessage();
  const jobId = await world.enqueueTurnJob();

  // A: sleeps 1s before its first append (holding the claim open) with the heartbeat pushed
  // an hour out so it never re-extends the lease. concurrency:1 so A can't re-pull its own
  // expired job while it's busy.
  await world.startWorker({
    llm: sleepyLlm({ [world.sessionId]: world.script }, 1000),
    heartbeatMs: 3_600_000,
    concurrency: 1,
  });
  await waitFor(async () => (await world.jobState(jobId)) === "running", 30_000, "A claimed");

  // The lease expires (don't sleep 60s — expire it). B reclaims and drives the turn while A
  // is still asleep; when A wakes, its appends lose the seq race → conflict, harmlessly.
  await world.expireLease(jobId);
  await world.startWorker({ llm: scriptedLlm({ [world.sessionId]: world.script }) });

  await waitFor(async () => (await world.eventTypes()).at(-1) === "turn_completed", 30_000, "completed");
  // Give A time to wake (1s), lose its race, and settle before we assert.
  await waitFor(async () => (await world.jobExists(jobId)) === false, 30_000, "acked");

  const events = await world.readEvents();
  const seqs = events.map((e) => e.seq);
  expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seqs, no interleaved garbage
  expect(normalize(events)).toEqual(REFERENCE_LOG);
  expect(events.filter((e) => e.type === "turn_completed")).toHaveLength(1); // exactly one
  expect(await world.markerLines()).toBe(1); // the command ran exactly once
});
