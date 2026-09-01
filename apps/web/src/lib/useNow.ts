// apps/web/src/lib/useNow.ts
// A clock that advances, for anything rendered relative to "now". Without
// it a relative timestamp is only true at the moment it rendered: a console
// left open would still read "12 seconds ago" an hour later.
import { useEffect, useState } from "react";

/** The current time, re-read every `everyMs` for as long as it is rendered. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
}
