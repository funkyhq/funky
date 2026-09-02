// apps/web/src/lib/format.ts
// Timestamps the way a console wants them: the age at a glance, the exact
// instant on hover. Both from Intl, so the browser owns locale and wording.

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

// Each unit with how many of it the next one takes. Walked in order, so the
// result is the coarsest unit the value still reads as a small number in;
// past the last entry the value is already in years.
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.348],
  ["month", 12],
];

/** How often a view showing relative times must re-read the clock. Fine
 *  enough that the coarsest thing relativeTime prints — "1 minute ago" — is
 *  never a minute stale. */
export const RELATIVE_TICK_MS = 30_000;

/** e.g. "3 hours ago". Returns the input unchanged if it isn't a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;

  // Every timestamp here describes something that has already happened, so a
  // positive delta is our clock being behind — a reader on a coarse tick, or
  // skew against the api's — and never the future. Clamped to 0, which
  // formats as "now"; the hover text still carries the exact instant.
  let value = Math.min(at - now, 0) / 1000; // negative = in the past
  for (const [unit, per] of UNITS) {
    if (Math.abs(value) < per) return RELATIVE.format(Math.round(value), unit);
    value /= per;
  }
  return RELATIVE.format(Math.round(value), "year");
}

/** The full local timestamp — the hover text behind a relative one. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : ABSOLUTE.format(at);
}
