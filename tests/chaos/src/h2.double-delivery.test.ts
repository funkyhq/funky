// H2 — Double delivery (two workers, one job).
//
// The queue only promises at-least-once. Hand the SAME turn to two runTurn calls at once
// (bypassing pull, the way an expired-lease redelivery would) and force them to race on the
// first append. Exactly one must win and complete; the other must lose every append to
// ErrConflict and stand down. The PK — not the lease — is what makes this safe.

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runTurn } from "@funky/sessions";
import { gatedLlm, scriptedLlm } from "./fixtures";
import { buildWorld, makeJob, normalize, REFERENCE_LOG, resetDb, stopPg, type World } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("two workers, one job: one winner, one clean ErrConflict loser", async () => {
  world = await buildWorld();
  await world.seedUserMessage();

  // One job row, delivered twice. runTurn never reads turn_jobs, so a shared Job object IS
  // the same delivery to both callers.
  const job = makeJob({ id: randomUUID(), sessionId: world.sessionId });

  // A 2-party barrier on the first inference guarantees both read the same log and then race
  // the seq-2 append — without it a fast winner could finish before the loser even starts,
  // and no conflict would ever fire (proving nothing).
  const llm = gatedLlm(scriptedLlm({ [world.sessionId]: world.script }), 2);
  const deps = world.turnDeps({ llm });

  const [r1, r2] = await Promise.all([runTurn(job, deps), runTurn(job, deps)]);

  // Exactly one worker completed the turn; the loser returned "conflict" — proof ErrConflict
  // fired (append_conflicts_total's underlying signal; the worker wrapper increments the
  // metric on exactly this outcome).
  expect([r1, r2].sort()).toEqual(["completed", "conflict"]);

  const events = await world.readEvents();
  const seqs = events.map((e) => e.seq);
  expect(new Set(seqs).size).toBe(seqs.length); // I2 — no duplicate seqs
  expect(normalize(events)).toEqual(REFERENCE_LOG); // I1 — the canonical log
  expect(await world.markerLines()).toBe(1); // I3 — the command ran exactly once
  expect(events.at(-1)!.type).toBe("turn_completed"); // I4
});
