// apps/web/src/lib/network.ts
// The network policy as a form: the choices a dialog offers, the reading of
// what gets typed into the one choice that carries anything, and the two
// conversions between a stored policy and the fields holding it. Shared by
// the create and edit dialogs, which write the same field of the same
// recipe and must not drift apart in how they read it.
import type { NetworkPolicy } from "./api";

/** The three policies core defines, in the order they narrow: reach
 *  anything, reach a named few, reach nothing. */
export const POLICIES = [
  { id: "unrestricted", label: "Unrestricted — reach anything" },
  { id: "allowlist", label: "Allowlist — reach only these domains" },
  { id: "none", label: "None — no network at all" },
];

/** What a form holds while it is being filled. `domains` sits BESIDE the
 *  type rather than inside it, so switching policies twice comes back to
 *  what was typed rather than to nothing. */
export type NetworkFields = { type: NetworkPolicy["type"]; domains: string };

/**
 * The domains as typed, one per line or comma-separated, in the order they
 * were written. Blanks are dropped and repeats collapsed — neither is a
 * domain the sandbox could be told about twice — but nothing else is
 * touched: the api takes these as strings and this console is in no
 * position to decide what a hostname may look like.
 */
export function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const entry of text.split(/[\n,]/)) {
    const domain = entry.trim();
    if (domain !== "") seen.add(domain);
  }
  return [...seen];
}

/**
 * The fields as a policy — or nothing, when the allowlist has no domain on
 * it. An allowlist of nothing reaches nothing, which is what `none` already
 * says legibly, so a form asks for the domain rather than writing a recipe
 * whose type and effect disagree. Callers read the absence as "not ready".
 */
export function toPolicy(fields: NetworkFields): NetworkPolicy | undefined {
  if (fields.type === "unrestricted") return { type: "unrestricted" };
  if (fields.type === "none") return { type: "none" };
  const domains = parseDomains(fields.domains);
  return domains.length === 0 ? undefined : { type: "allowlist", domains };
}

/** A stored policy as fields, for a form that starts from one. */
export function fieldsOf(network: NetworkPolicy): NetworkFields {
  return {
    type: network.type,
    domains: network.type === "allowlist" ? network.domains.join("\n") : "",
  };
}

/** Whether two policies say the same thing: the same type, and for an
 *  allowlist the same domains in the same order. What an edit compares
 *  against to know whether there is anything to save. */
export function samePolicy(a: NetworkPolicy, b: NetworkPolicy): boolean {
  if (a.type !== b.type) return false;
  if (a.type !== "allowlist" || b.type !== "allowlist") return true;
  return a.domains.length === b.domains.length && a.domains.every((d, i) => d === b.domains[i]);
}
