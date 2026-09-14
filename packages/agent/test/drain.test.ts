import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { stepOrDeadline, watchDrain } from "../src/driver/loop";

// The drain's deadline is shared by every claim the loop ever holds, and
// on a healthy worker it never fires. What a claim leaves on it is
// therefore what a long-running worker accumulates: nothing — or, when
// it was a promise handed to Promise.race, one reaction per claim for
// the life of the process (~45 MiB over 100k claims). Node can count
// the listeners on a signal, so the property is pinned exactly.

const never = new Promise<void>(() => {});
const listeners = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

describe("stepOrDeadline", () => {
  it("leaves nothing on the deadline once the step has won — however many claims", async () => {
    const drain = watchDrain(new AbortController().signal, 60_000);
    for (let i = 0; i < 1_000; i++) {
      expect(await stepOrDeadline(Promise.resolve(), drain.expired)).toBe("stepped");
    }
    expect(listeners(drain.expired)).toBe(0);
    drain.stop();
  });

  it("listens only while a claim is held, and lets go when the deadline wins", async () => {
    const host = new AbortController();
    const drain = watchDrain(host.signal, 20);
    const waiting = stepOrDeadline(never, drain.expired);
    expect(listeners(drain.expired)).toBe(1);
    host.abort(); // the drain fires: the budget counts from here
    expect(await waiting).toBe("deadline");
    expect(listeners(drain.expired)).toBe(0);
    // A claim that lands after the budget is spent: an immediate verdict,
    // and nothing registered for it.
    expect(await stepOrDeadline(never, drain.expired)).toBe("deadline");
    expect(listeners(drain.expired)).toBe(0);
  });

  it("propagates the step's failure, and still lets go of the deadline", async () => {
    const drain = watchDrain(new AbortController().signal, 60_000);
    await expect(
      stepOrDeadline(Promise.reject(new Error("store down")), drain.expired),
    ).rejects.toThrow("store down");
    expect(listeners(drain.expired)).toBe(0);
    drain.stop();
  });
});

describe("watchDrain", () => {
  it("stop cancels a deadline that has not fired", async () => {
    const host = new AbortController();
    const drain = watchDrain(host.signal, 10);
    host.abort();
    drain.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drain.fired).toBe(true);
    expect(drain.expired.aborted).toBe(false);
  });

  it("is already counting when the signal fired before the watch began", async () => {
    const host = new AbortController();
    host.abort();
    const drain = watchDrain(host.signal, 10);
    expect(drain.fired).toBe(true);
    expect(await stepOrDeadline(never, drain.expired)).toBe("deadline");
  });
});
