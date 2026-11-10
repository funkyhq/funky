// Usage delivery — the policy between the store's outbox and a UsageSink.
// commitStep records a usage event for each assistant message that
// carries usage, and one for the work item it closes, in the same
// transaction as the message and the item's close (ports/store.ts), so
// an event exists exactly when what it measures does; this module gets
// it to the receiver, at least once. Every kind takes the same path.
//
// Two paths, one per moment an event can be sent:
// - Right after the commit. The driver hands the commit's events to
//   `deliver` (StepDeps.deliverUsage) and does not wait: the next claim
//   never queues behind a receiver. For USAGE_HANDOFF_MS after its commit
//   an event is this path's alone — claimUsage offers it to nobody — so
//   the two paths take turns rather than race.
// - The sweep. `sweep` claims what is due — an event whose delivery
//   failed, once its backoff has passed, or one whose committer never got
//   to send it (the worker died after the commit, or was drained) — and
//   delivers it. A restarted worker sweeps on boot, so nothing waits on
//   the process that committed it.
//
// A failure is never final: the event is deferred, its wait doubling per
// failed attempt from retryMs up to maxRetryMs, and retried until the
// receiver takes it. The receiver dedupes on eventId, which is what makes
// a repeat harmless (an expired lease, a lost reply).
//
// The sweep claims one event at a time, so a lease only has to outlast
// one send — the sink's timeout — however slow the receiver is. A batch
// would share one lease across sends made one after another, and a slow
// receiver that still accepted would outrun it, handing the batch's tail
// to another worker's sweep to send again. One at a time, workers
// draining a backlog together also split it event by event. A failure
// pauses the sweep for pollMs: the receiver is most likely down for every
// event behind it too.
//
// Store failures are logged, never thrown: usage delivery must not take
// down the worker's claim loops, and every event stays in the outbox
// until a delivery is recorded.

import type { UsageEvent } from "@funky/core";
import type { Store, UsageClaim } from "../ports/store";
import type { UsageSink } from "../ports/usage-sink";

export interface UsageDeliveryOptions {
  /** The wait after a first failed delivery; doubled per further failure.
   *  Default 30s. */
  retryMs?: number;
  /** The longest wait between two attempts. Default 1 hour. */
  maxRetryMs?: number;
  /** The sweep's wait when nothing was due, or a send failed. Default 30s. */
  pollMs?: number;
  /** How long a claimed event is the sweep's before anyone may claim it
   *  again. Default 60s; it must outlast one send — the sink's own
   *  timeout (the HTTP sink's is 10s). */
  leaseMs?: number;
  /** Injected clock for the retry times. Defaults to wall time. */
  now?: () => Date;
  /** Told of every failure — a send the receiver didn't take, a store
   *  call that failed — for the host to log. */
  onError?: (message: string, error: unknown) => void;
}

export interface UsageDelivery {
  /** Send the events a commit just recorded, in order; the driver's
   *  StepDeps.deliverUsage. Never rejects. */
  deliver(events: UsageEvent[]): Promise<void>;
  /** Claim and send due events until the signal fires; the worker runs
   *  one beside its drivers. Never rejects. */
  sweep(signal: AbortSignal): Promise<void>;
}

export function createUsageDelivery(
  store: Pick<Store, "claimUsage" | "markUsageDelivered" | "deferUsage">,
  sink: UsageSink,
  opts: UsageDeliveryOptions = {},
): UsageDelivery {
  const retryMs = opts.retryMs ?? 30_000;
  const maxRetryMs = opts.maxRetryMs ?? 60 * 60_000;
  const pollMs = opts.pollMs ?? 30_000;
  const leaseMs = opts.leaseMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? (() => {});

  /** The wait before the next try of an event that has failed
   *  `attempts` times before this failure. */
  const backoff = (attempts: number): number =>
    Math.min(retryMs * 2 ** Math.min(attempts, 30), maxRetryMs);

  /** One event, one try. True when the receiver took it. */
  async function sendOne(event: UsageEvent, attempts: number, signal?: AbortSignal) {
    const label = `usage event ${event.eventId} (session ${event.sessionId})`;
    try {
      await sink.send(event, signal);
    } catch (error) {
      // A send cut short by the drain is not the receiver's failure: the
      // event goes back by its lease or handoff, its attempts unchanged.
      if (signal?.aborted) return false;
      const retryAt = new Date(now().getTime() + backoff(attempts));
      onError(`${label} was not delivered; retrying at ${retryAt.toISOString()}`, error);
      await store.deferUsage(event, retryAt).catch((deferError) => {
        // The event is still due when its lease or handoff runs out.
        onError(`${label} could not be deferred`, deferError);
      });
      return false;
    }
    await store.markUsageDelivered(event).catch((markError) => {
      // Delivered but not marked: it goes out again later, and the
      // receiver dedupes it on eventId.
      onError(`${label} was delivered but could not be marked`, markError);
    });
    return true;
  }

  return {
    async deliver(events) {
      for (const event of events) {
        if (!(await sendOne(event, 0))) return;
      }
    },

    async sweep(signal) {
      while (!signal.aborted) {
        let claim: UsageClaim | undefined;
        try {
          [claim] = await store.claimUsage({ limit: 1, leaseMs });
        } catch (error) {
          onError("claiming usage events failed", error);
        }
        // A delivered event may have more due behind it: claim again at once.
        const delivered =
          claim !== undefined && (await sendOne(claim.event, claim.attempts, signal));
        if (!delivered) await sleep(pollMs, signal);
      }
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
