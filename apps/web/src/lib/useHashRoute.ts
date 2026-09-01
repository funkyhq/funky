// apps/web/src/lib/useHashRoute.ts
// The whole router. Sections are `#/<id>` anchors, so the browser owns
// history, focus, and middle-click, and this hook only reports which hash
// is current — no dependency, no route table.
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function getSnapshot(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

/** The current hash route, without its `#/` prefix. */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}
