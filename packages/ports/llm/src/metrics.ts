// packages/ports/llm/src/metrics.ts — minimal in-process counters.
//
// Phase B has no metrics client yet (that arrives with the worker in Phase E). These are
// plain process-global counters whose NAMES match what the worker will emit, so the
// signal is captured now and re-homed later without renaming. Tests read them directly.

const counters: Record<string, number> = Object.create(null);

export function incrCounter(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function getCounter(name: string): number {
  return counters[name] ?? 0;
}

/** Test helper: zero everything (counters are process-global). */
export function resetCounters(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}
