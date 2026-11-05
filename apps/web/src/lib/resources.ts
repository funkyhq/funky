// apps/web/src/lib/resources.ts
// The sandbox's size as a form: two inputs, each kept as typed. Shared by
// the agent config dialogs, which write the same field and must not drift
// apart in how they read it (the arrangement lib/setup-commands.ts has).
import type { Resources } from "./api";

/** What the inputs hold: digits, or nothing for the provider's default. */
export type ResourceFields = { cpuCount: string; memoryMB: string };

export function resourceFieldsOf(resources: Resources): ResourceFields {
  return {
    cpuCount: resources.cpuCount === undefined ? "" : String(resources.cpuCount),
    memoryMB: resources.memoryMB === undefined ? "" : String(resources.memoryMB),
  };
}

/** One input as a size: blank is the default, a whole number above zero is
 *  that number, and anything else isn't a size yet. */
function toSize(typed: string): number | null | undefined {
  const value = typed.trim();
  if (value === "") return null;
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
}

/**
 * The inputs as resources — or nothing while one holds what isn't a whole
 * number, so a form waits rather than sending it. A blank input is left
 * out: the provider's default. What the provider will give (an even
 * number, a ceiling) is the provider's to judge, when a session starts.
 */
export function toResources(fields: ResourceFields): Resources | undefined {
  const cpuCount = toSize(fields.cpuCount);
  const memoryMB = toSize(fields.memoryMB);
  if (cpuCount === undefined || memoryMB === undefined) return undefined;
  return {
    ...(cpuCount === null ? {} : { cpuCount }),
    ...(memoryMB === null ? {} : { memoryMB }),
  };
}

/** Whether two sizes say the same thing. What an edit compares against to
 *  know whether there is anything to save. */
export function sameResources(a: Resources, b: Resources): boolean {
  return a.cpuCount === b.cpuCount && a.memoryMB === b.memoryMB;
}
