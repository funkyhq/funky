import type { NetworkPolicy } from "./types";

export type NetworkMode = NetworkPolicy["type"];

export function networkPolicy(mode: NetworkMode, allowedHosts: string): NetworkPolicy {
  if (mode === "unrestricted") return { type: "unrestricted" };
  return {
    type: "limited",
    allowed_hosts: [
      ...new Set(
        allowedHosts
          .split(/[\s,]+/)
          .map((host) => host.trim())
          .filter(Boolean),
      ),
    ],
  };
}

export function networkSummary(policy: NetworkPolicy): string {
  if (policy.type === "unrestricted") return "Unrestricted";
  if (policy.allowed_hosts.length === 0) return "No outbound access";
  return `${policy.allowed_hosts.length} allowed host${policy.allowed_hosts.length === 1 ? "" : "s"}`;
}
