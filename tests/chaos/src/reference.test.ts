// tests/chaos/src/reference.test.ts — the no-chaos baseline.
//
// Runs the happy path with no crashes and pins the resulting log as REFERENCE_LOG. If this
// fails, every chaos scenario is comparing against a lie — so it runs first and asserts the
// exact shape the crash scenarios reuse. Also proves the side-effect command ran once and
// its output reached the tool_result (the plumbing every other file depends on).

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { buildWorld, normalize, REFERENCE_LOG, resetDb, stopPg, type World, waitFor } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("happy path: no chaos → the canonical event log, command runs once", async () => {
  world = await buildWorld();
  await world.seedUserMessage();
  await world.enqueueTurnJob();

  await world.startWorker();
  await waitFor(async () => (await world.eventTypes()).at(-1) === "turn_completed", 30_000, "completed");

  const events = await world.readEvents();
  expect(normalize(events)).toEqual(REFERENCE_LOG);

  // The command ran exactly once, and its stdout ("done") reached the tool_result.
  expect(await world.markerLines()).toBe(1);
  const toolResult = events.find((e) => e.type === "tool_result")!;
  expect((toolResult.payload as { output: string }).output).toContain("done");
  expect((toolResult.payload as { exit_code: number }).exit_code).toBe(0);
});
