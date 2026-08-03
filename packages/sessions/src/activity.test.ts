// packages/sessions/src/activity.test.ts — the activity derivation, as a pure table.
//
// deriveActivity is a pure function of (session status, active turn job); the queue read
// feeding it is covered by the API integration suite. This is the whole state table.

import { describe, expect, it } from "vitest";
import type { ActiveTurnJob } from "./queue";
import { deriveActivity } from "./service";

const job = (over: Partial<ActiveTurnJob> = {}): ActiveTurnJob => ({
  state: "queued",
  attempts: 0,
  leaseExpired: false,
  ...over,
});

describe("deriveActivity", () => {
  it("failed/archived → terminated, regardless of any job", () => {
    expect(deriveActivity({ status: "failed" }, undefined)).toBe("terminated");
    expect(deriveActivity({ status: "archived" }, job({ state: "running" }))).toBe("terminated");
  });

  it("no active turn job → idle (fresh sessions start here)", () => {
    expect(deriveActivity({ status: "provisioning" }, undefined)).toBe("idle");
    expect(deriveActivity({ status: "ready" }, undefined)).toBe("idle");
  });

  it("running with a live lease → running", () => {
    expect(deriveActivity({ status: "ready" }, job({ state: "running" }))).toBe("running");
  });

  it("running with an expired lease → rescheduling (dead worker, queue will reclaim)", () => {
    expect(
      deriveActivity({ status: "ready" }, job({ state: "running", leaseExpired: true })),
    ).toBe("rescheduling");
  });

  it("queued before any delivery → running (the dispatch sliver)", () => {
    expect(deriveActivity({ status: "ready" }, job({ state: "queued", attempts: 0 }))).toBe(
      "running",
    );
  });

  it("queued after a failed delivery → rescheduling (backoff wait)", () => {
    expect(deriveActivity({ status: "ready" }, job({ state: "queued", attempts: 2 }))).toBe(
      "rescheduling",
    );
  });
});
