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

/** e.g. "3 hours ago". Returns the input unchanged if it isn't a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;

  let value = (at - now) / 1000; // negative = in the past
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
