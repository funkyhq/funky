// The UsageSink port over a webhook: each usage event is one signed
// HTTP POST of its JSON to the receiver's URL.
//
// The request:
//   POST <url>
//   Content-Type: application/json
//   Idempotency-Key: <eventId>
//   Funky-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
//   <the UsageEvent as JSON>
//
// The signature is HMAC-SHA256, keyed with the shared secret, over
// `<t>.<body>` — the timestamp, a dot, and the raw body bytes as sent.
// A receiver recomputes it over the body it received (before parsing
// it), compares in constant time, and refuses a `t` too far from its own
// clock, so a captured request can't be replayed later. The event id is
// inside the signed body as well as in Idempotency-Key, so dedupe on the
// body's `eventId` cannot be steered by an unsigned header.
//
// Any 2xx is acceptance; everything else — another status, a network
// error, no answer within timeoutMs — rejects, and the delivery policy
// retries (driver/deliver-usage.ts). Redirects are not followed: a
// receiver that moved is a configuration to fix, not a hop to take with
// a signed billing record.

import { createHmac } from "node:crypto";
import type { UsageEvent } from "@funky/core";
import type { UsageSink } from "@funky/agent";

export interface HttpUsageSinkOptions {
  /** Where each event is POSTed. */
  url: string;
  /** The HMAC key the receiver verifies Funky-Signature with. */
  secret: string;
  /** How long one request may take before it counts as failed. Default
   *  10s — well inside the delivery lease, so a hung receiver never holds
   *  an event long enough for a second claimer to send it too. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected clock for the signature's timestamp. */
  now?: () => Date;
}

/** The Funky-Signature header for `body` signed at `timestamp` (unix
 *  seconds). Exported so a receiver written in TypeScript — and the
 *  tests — verify with the very function that signs. */
export function signUsageBody(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function createHttpUsageSink(opts: HttpUsageSinkOptions): UsageSink {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? (() => new Date());

  return {
    async send(event: UsageEvent, signal?: AbortSignal): Promise<void> {
      const body = JSON.stringify(event);
      const timestamp = Math.floor(now().getTime() / 1000);
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await doFetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": event.eventId,
          "funky-signature": signUsageBody(opts.secret, timestamp, body),
        },
        body,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      // The body is not read: free the connection for the next event.
      await response.body?.cancel().catch(() => {});
      if (response.status < 200 || response.status > 299) {
        throw new Error(`usage webhook answered ${response.status} for event ${event.eventId}`);
      }
    },
  };
}
