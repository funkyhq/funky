// apps/web/src/lib/packages.ts
// The packages as a form: a group of specs per package manager. Shared by
// the agent config dialogs and the quickstart, which write the same field of
// the same config and must not drift apart in how they read it (the
// arrangement lib/network.ts has).
import type { Packages } from "./api";

/** The managers the stack's sandbox provider installs, in the order the
 *  form offers them. The api stores any manager, but a session on one the
 *  provider can't install ends in an error, so the form offers only these. */
export const MANAGERS = [
  {
    id: "pip",
    label: "Python packages",
    short: "Python",
    registry: "PyPI",
    example: "pandas==2.2.0",
  },
  {
    id: "npm",
    label: "Node.js packages",
    short: "Node.js",
    registry: "npm",
    example: "express@4.18.0",
  },
  { id: "apt", label: "System packages", short: "System", registry: "apt", example: "graphviz" },
];

export const managerOf = (id: string) => MANAGERS.find((manager) => manager.id === id);

/**
 * The specs typed into a group's input, added to it. Whitespace or commas
 * separate specs (none of the three managers' syntaxes contains either), and
 * a spec the group already holds is not added twice.
 */
export function addSpecs(packages: Packages, manager: string, typed: string): Packages {
  const specs = new Set(packages[manager] ?? []);
  for (const spec of typed.split(/[\s,]+/)) if (spec !== "") specs.add(spec);
  return { ...packages, [manager]: [...specs] };
}

export function removeSpec(packages: Packages, manager: string, spec: string): Packages {
  return { ...packages, [manager]: (packages[manager] ?? []).filter((s) => s !== spec) };
}

/** The packages as the api should store them: groups left empty dropped. */
export function compact(packages: Packages): Packages {
  return Object.fromEntries(Object.entries(packages).filter(([, specs]) => specs.length > 0));
}

/** Whether two package sets install the same thing: order and repeats
 *  aside, as the sandbox provider reads them. What an edit compares against
 *  to know whether there is anything to save. */
export function samePackages(a: Packages, b: Packages): boolean {
  const canonical = (packages: Packages) =>
    JSON.stringify(
      Object.entries(compact(packages))
        .map(([manager, specs]) => [manager, [...new Set(specs)].sort()] as const)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return canonical(a) === canonical(b);
}

/** One line of what the packages will install, for the step that shows the
 *  config rather than offering it. */
export function packagesLine(packages: Packages): string {
  const entries = Object.entries(compact(packages));
  if (entries.length === 0) return "none";
  return entries.map(([manager, specs]) => `${manager}: ${specs.join(", ")}`).join(" · ");
}
