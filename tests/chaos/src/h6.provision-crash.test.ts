// H6 — Crash during provisioning.
//
// Kill the worker mid-runProvision — right as it appends session_provisioned (inside the
// same transaction that flips the session to ready), so the throw rolls the whole thing
// back. A second worker must finish provisioning: status ends "ready", with exactly one
// session_provisioned event and no orphaned sandbox.

import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import type { AppendHook } from "@funky/sessions";
import type { WorkerHandle } from "worker/worker";
import { KillWorker } from "./fixtures";
import { buildWorld, resetDb, stopPg, type World, waitFor } from "./harness";

let world: World;
beforeEach(resetDb);
afterEach(() => world?.cleanup());
afterAll(stopPg);

it("crash mid-provision → second worker provisions, one event, one workdir", async () => {
  world = await buildWorld({ provisioned: false });
  const jobId = await world.enqueueProvisionJob();

  // The only append in the provision path is session_provisioned; crash A on it. The hook
  // fires INSIDE the provision transaction, so the throw rolls back both the session update
  // and the event — a faithful "crashed before commit".
  let workerA: WorkerHandle;
  let dead = false;
  const hook: AppendHook = () => {
    workerA.kill();
    dead = true;
    throw new KillWorker();
  };
  const a = await world.startWorker({ store: world.hookedStore(hook) });
  workerA = a.worker;

  await waitFor(() => dead, 30_000, "A crashed mid-provision");
  await world.expireLease(jobId);

  // B — clean store — reclaims the provision job and completes it.
  await world.startWorker();
  await waitFor(async () => (await world.sessionStatus()) === "ready", 30_000, "provisioned");

  const events = await world.readEvents();
  expect(events.filter((e) => e.type === "session_provisioned")).toHaveLength(1); // exactly one
  expect(await world.sessionStatus()).toBe("ready");
  expect(await world.jobExists(jobId)).toBe(false); // B acked

  // No orphaned sandbox: the workdir is sessionId-derived, so re-provisioning reused the one
  // dir. It exists, and there is exactly one for this session.
  await expect(fs.access(`/tmp/funky/${world.sessionId}`)).resolves.toBeUndefined();
});
