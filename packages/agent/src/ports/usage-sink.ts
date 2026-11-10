import type { UsageEvent } from "@funky/core";

/**
 * The UsageSink port — where a usage event goes once its commit has
 * landed: a metering or billing system outside Funky. The store is the
 * outbox (Store.claimUsage and friends) and the driver's
 * driver/deliver-usage.ts is the policy — deliver right after the
 * commit, retry what failed with backoff — so an adapter does exactly
 * one thing: hand one event to the receiver and say whether it took it.
 *
 * Delivery is at least once: an event can arrive twice (a retry after a
 * reply that was lost, a lease that expired under a slow send), so the
 * adapter hands the receiver `eventId` as the key to dedupe on.
 *
 * Quantities only — the event carries what the provider reported, never
 * a price.
 */
export interface UsageSink {
  /**
   * Resolve once the receiver has accepted the event; reject on anything
   * else — a refusal, an error status, a timeout, no answer. A rejection
   * is always retried later, so an adapter never decides an event is
   * undeliverable.
   */
  send(event: UsageEvent, signal?: AbortSignal): Promise<void>;
}
