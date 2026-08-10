// Small presentation helpers shared across the console.

/** Up to two leading initials from a name, e.g. "Restaurant Scout" → "RS". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AG";
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Slugify a name into a short tag, e.g. "Python ML" → "python-ml". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A compact, human relative time from an ISO timestamp. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** First 8 characters of a uuid, for compact display. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Truncate to n chars with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Best-effort human message from a thrown value (ApiError carries the API message). */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
