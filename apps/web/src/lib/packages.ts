// apps/web/src/lib/packages.ts
// The packages as a form: one package per line, the manager first and the
// spec after it — "pip pandas==2.2.0". Shared by the agent config dialogs
// and the quickstart, which write the same field of the same config and must
// not drift apart in how they read it (the arrangement lib/network.ts has).
import type { Packages } from "./api";

/** The managers the stack's sandbox provider installs. The api stores any
 *  manager, but a session on one the provider can't install ends in an
 *  error, so the form refuses it up front instead. */
export const MANAGERS = ["apt", "npm", "pip"];

/** What reading the text came to: the packages, or the first line that
 *  isn't one — which a form shows and refuses to submit. */
export type ReadPackages = { packages: Packages } | { error: string };

/**
 * The text as packages. Blank lines are skipped and a repeated spec is kept
 * once; everything after the manager is the spec, as typed, so each
 * ecosystem's own syntax ("express@4.18.0", "pandas>=2") passes untouched.
 */
export function readPackages(text: string): ReadPackages {
  const packages: Record<string, Set<string>> = {};
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const [manager = "", ...rest] = line.split(/\s+/);
    const spec = rest.join(" ");
    if (!MANAGERS.includes(manager)) {
      return {
        error: `Line ${index + 1}: “${manager}” isn’t a package manager here — use ${MANAGERS.join(", ")}.`,
      };
    }
    if (spec === "") return { error: `Line ${index + 1}: name a package after “${manager}”.` };
    (packages[manager] ??= new Set()).add(spec);
  }
  return {
    packages: Object.fromEntries(
      Object.entries(packages).map(([manager, specs]) => [manager, [...specs]]),
    ),
  };
}

/** Stored packages as text, for a form that starts from them. */
export function textOf(packages: Packages): string {
  return Object.entries(packages)
    .flatMap(([manager, specs]) => specs.map((spec) => `${manager} ${spec}`))
    .join("\n");
}

/** Whether two package sets install the same thing: order and repeats
 *  aside, as the sandbox provider reads them. What an edit compares against
 *  to know whether there is anything to save. */
export function samePackages(a: Packages, b: Packages): boolean {
  const canonical = (packages: Packages) =>
    JSON.stringify(
      Object.entries(packages)
        .map(([manager, specs]) => [manager, [...new Set(specs)].sort()] as const)
        .filter(([, specs]) => specs.length > 0)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return canonical(a) === canonical(b);
}

/** One line of what the packages will install, for the step that shows the
 *  config rather than offering it. */
export function packagesLine(packages: Packages): string {
  const entries = Object.entries(packages).filter(([, specs]) => specs.length > 0);
  if (entries.length === 0) return "none";
  return entries.map(([manager, specs]) => `${manager}: ${specs.join(", ")}`).join(" · ");
}
