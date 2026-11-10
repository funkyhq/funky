// createUsageDelivery over fakes: the post-commit path marks what the
// receiver took and defers what it didn't, with a backoff that doubles
// per failed attempt up to its cap; the sweep claims one event per lease,
// claims again at once after a delivery and waits after a failure, and
// ends with the signal; store failures are reported, never thrown.

import { describe, expect, test } from "vitest";
import type { UsageEvent, UsageEventRef } from "@funky/core";
import { createUsageDelivery } from "../src/driver/deliver-usage";
import type { UsageClaim } from "../src/ports/store";
import type { UsageSink } from "../src/ports/usage-sink";

const NOW = new Date("2026-11-10T00:00:00.000Z");

const event = (n: number): UsageEvent => ({
  namespace: "default",
  sessionId: "s1",
  eventId: `e${n}`,
  entryId: `entry${n}`,
  provider: "anthropic",
  model: "claude-opus-5",
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  createdAt: NOW.toISOString(),
});

/** Hands out `due` in order, as many per claim as the limit asks. */
function fakeStore(due: UsageClaim[] = []) {
  const delivered: string[] = [];
  const deferred: Array<{ eventId: string; retryAt: Date }> = [];
  const claims: Array<{ limit: number; leaseMs: number }> = [];
  return {
    delivered,
    deferred,
    claims,
    store: {
      claimUsage: async (req: { limit: number; leaseMs: number }) => {
        claims.push(req);
        return due.splice(0, req.limit);
      },
      markUsageDelivered: async (ref: UsageEventRef) => {
        delivered.push(ref.eventId);
      },
      deferUsage: async (ref: UsageEventRef, retryAt: Date) => {
        deferred.push({ eventId: ref.eventId, retryAt });
      },
    },
  };
}

/** A sink that refuses the event ids in `refuse`, and records every send. */
function fakeSink(refuse: string[] = []) {
  const sent: string[] = [];
  const sink: UsageSink = {
    send: async (e) => {
      sent.push(e.eventId);
      if (refuse.includes(e.eventId)) throw new Error(`refused ${e.eventId}`);
    },
  };
  return { sent, sink };
}

const after = (ms: number) => new Date(NOW.getTime() + ms);

describe("deliver — right after the commit", () => {
  test("sends each event in order and marks it delivered", async () => {
    const { store, delivered, deferred } = fakeStore();
    const { sink, sent } = fakeSink();
    await createUsageDelivery(store, sink).deliver([event(1), event(2)]);
    expect(sent).toEqual(["e1", "e2"]);
    expect(delivered).toEqual(["e1", "e2"]);
    expect(deferred).toEqual([]);
  });

  test("defers a refused event by the first backoff, reports it, and leaves the rest to the sweep", async () => {
    const { store, delivered, deferred } = fakeStore();
    const { sink, sent } = fakeSink(["e1"]);
    const errors: string[] = [];
    await createUsageDelivery(store, sink, {
      now: () => NOW,
      retryMs: 30_000,
      onError: (message) => errors.push(message),
    }).deliver([event(1), event(2)]);
    expect(sent).toEqual(["e1"]);
    expect(delivered).toEqual([]);
    expect(deferred).toEqual([{ eventId: "e1", retryAt: after(30_000) }]);
    expect(errors).toEqual([
      expect.stringContaining("usage event e1 (session s1) was not delivered"),
    ]);
  });

  test("never rejects when the store fails around a send", async () => {
    const errors: string[] = [];
    const failing = {
      claimUsage: async () => [],
      markUsageDelivered: async () => {
        throw new Error("store down");
      },
      deferUsage: async () => {
        throw new Error("store down");
      },
    };
    const delivery = createUsageDelivery(failing, fakeSink(["e2"]).sink, {
      onError: (message) => errors.push(message),
    });
    await expect(delivery.deliver([event(1)])).resolves.toBeUndefined();
    await expect(delivery.deliver([event(2)])).resolves.toBeUndefined();
    expect(errors).toEqual([
      expect.stringContaining("e1 (session s1) was delivered but could not be marked"),
      expect.stringContaining("e2 (session s1) was not delivered"),
      expect.stringContaining("e2 (session s1) could not be deferred"),
    ]);
  });
});

describe("sweep — the retry path", () => {
  test("claims one event per lease, delivers it, and backs off per failed attempt up to the cap", async () => {
    const { store, delivered, deferred, claims } = fakeStore([
      { event: event(1), attempts: 0 },
      { event: event(2), attempts: 3 },
    ]);
    const { sink } = fakeSink(["e2"]);
    const stop = new AbortController();
    const delivery = createUsageDelivery(store, sink, {
      now: () => NOW,
      retryMs: 1_000,
      maxRetryMs: 5_000,
      pollMs: 5,
      leaseMs: 20_000,
    });
    const sweeping = delivery.sweep(stop.signal);
    await waitFor(() => claims.length >= 2);
    stop.abort();
    await sweeping;
    // One at a time: the lease only has to outlast one send.
    expect(claims[0]).toEqual({ limit: 1, leaseMs: 20_000 });
    expect(delivered).toEqual(["e1"]);
    // Three failures before this one: 1s doubled three times is 8s,
    // held to the 5s cap.
    expect(deferred).toEqual([{ eventId: "e2", retryAt: after(5_000) }]);
  });

  test("doubles the wait with each failed attempt", async () => {
    const { store, deferred, claims } = fakeStore([
      { event: event(1), attempts: 0 },
      { event: event(1), attempts: 1 },
      { event: event(1), attempts: 2 },
    ]);
    const stop = new AbortController();
    const sweeping = createUsageDelivery(store, fakeSink(["e1"]).sink, {
      now: () => NOW,
      retryMs: 1_000,
      pollMs: 1,
    }).sweep(stop.signal);
    await waitFor(() => claims.length >= 4);
    stop.abort();
    await sweeping;
    expect(deferred.map((d) => d.retryAt)).toEqual([after(1_000), after(2_000), after(4_000)]);
  });

  test("waits pollMs after a failure before claiming the next event", async () => {
    const { store, claims } = fakeStore([
      { event: event(1), attempts: 0 },
      { event: event(2), attempts: 0 },
    ]);
    const { sink, sent } = fakeSink(["e1"]);
    const stop = new AbortController();
    const sweeping = createUsageDelivery(store, sink, { pollMs: 60_000 }).sweep(stop.signal);
    await waitFor(() => sent.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The receiver is most likely down for e2 as well: it waits its turn.
    expect(claims).toHaveLength(1);
    expect(sent).toEqual(["e1"]);
    stop.abort();
    await sweeping;
  });

  test("claims again at once after a delivery, and waits pollMs when nothing is due", async () => {
    const { store, claims, delivered } = fakeStore([
      { event: event(1), attempts: 0 },
      { event: event(2), attempts: 0 },
    ]);
    const stop = new AbortController();
    const sweeping = createUsageDelivery(store, fakeSink().sink, {
      pollMs: 60_000,
    }).sweep(stop.signal);
    // Two deliveries back to back, then an empty claim that starts the wait.
    await waitFor(() => claims.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claims).toHaveLength(3);
    expect(delivered).toEqual(["e1", "e2"]);
    stop.abort();
    await sweeping;
  });

  test("reports a failed claim and keeps sweeping", async () => {
    let calls = 0;
    const errors: string[] = [];
    const store = {
      claimUsage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("store down");
        return [];
      },
      markUsageDelivered: async () => {},
      deferUsage: async () => {},
    };
    const stop = new AbortController();
    const sweeping = createUsageDelivery(store, fakeSink().sink, {
      pollMs: 1,
      onError: (message) => errors.push(message),
    }).sweep(stop.signal);
    await waitFor(() => calls >= 2);
    stop.abort();
    await expect(sweeping).resolves.toBeUndefined();
    expect(errors).toEqual(["claiming usage events failed"]);
  });

  test("returns on the signal, and leaves a send it cut short undeferred", async () => {
    const { store, deferred, claims } = fakeStore([{ event: event(1), attempts: 0 }]);
    const stop = new AbortController();
    const sink: UsageSink = {
      send: (_event, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const sweeping = createUsageDelivery(store, sink, { pollMs: 1 }).sweep(stop.signal);
    await waitFor(() => claims.length >= 1);
    stop.abort();
    await sweeping;
    // The drain is not the receiver's failure: the lease hands it back.
    expect(deferred).toEqual([]);
  });

  test("does nothing on a signal that has already fired", async () => {
    const { store, claims } = fakeStore();
    const stop = new AbortController();
    stop.abort();
    await createUsageDelivery(store, fakeSink().sink).sweep(stop.signal);
    expect(claims).toEqual([]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
