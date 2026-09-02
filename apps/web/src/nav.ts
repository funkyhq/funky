// apps/web/src/nav.ts
// The console's navigation, in one place: the sidebar renders this list and
// the router resolves a hash against it, so adding a section is one entry.
// Kept free of JSX so it can hold both the data and the route resolver.
import type { ReactElement, SVGProps } from "react";
import { AgentIcon, BoltIcon, EnvironmentIcon, SessionIcon } from "./components/Icons";
import { AgentConfigs } from "./pages/AgentConfigs";
import { EnvConfigs } from "./pages/EnvConfigs";
import { Sessions } from "./pages/Sessions";

/** What a page is handed: the part of the route below its own section, so
 *  a section can address something inside itself (`#/agent/<id>`) without
 *  the shell knowing what that something is. Empty at the section root. */
export type PageProps = { route: string };

export type NavItem = {
  /** The hash route, `#/<id>`, and the item's identity. */
  id: string;
  label: string;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  /** One line of what the section is, shown on the placeholder page. */
  blurb: string;
  /** The API surface the section will front, shown as a mono chip. */
  chip: string;
  /** Rendered as a caption above the item, when it opens a group. */
  groupLabel?: string;
  /** The section's page. Absent while a section is unbuilt — those render
   *  the placeholder from the blurb and chip above. */
  Page?: (props: PageProps) => ReactElement;
};

/** Non-empty by type: the first section is what an unknown route falls back to. */
export const NAV_ITEMS: [NavItem, ...NavItem[]] = [
  {
    id: "quick-start",
    label: "Quick Start",
    Icon: BoltIcon,
    blurb:
      "Walk the whole quickstart in one flow: define an agent, give it an environment, open a session, and send it the first message.",
    chip: "agent → environment → session → message",
  },
  {
    id: "agent",
    label: "Agent",
    Icon: AgentIcon,
    blurb:
      "Agent configs are the model, the system prompt, and the tools a session runs with. Versioned, so an update lands as a new version rather than a rewrite.",
    chip: "/v1/agent-configs",
    groupLabel: "Resources",
    Page: AgentConfigs,
  },
  {
    id: "environment",
    label: "Environment",
    Icon: EnvironmentIcon,
    blurb:
      "Env configs are the sandbox recipe: the base image a session's commands execute inside. One sandbox per session, bound in the store so it outlives any worker.",
    chip: "/v1/env-configs",
    Page: EnvConfigs,
  },
  {
    id: "session",
    label: "Session",
    Icon: SessionIcon,
    blurb:
      "A session is one agent config plus one env config plus a durable, append-only entry log — the log a fresh worker resumes from with nothing lost.",
    chip: "/v1/sessions",
    Page: Sessions,
  },
];

/** The hash the app lands on when none is given. */
export const DEFAULT_ROUTE = NAV_ITEMS[0].id;

/**
 * A hash route split at its first segment: the section it names, and the
 * rest for that section to resolve. "agent/2f9…" is the Agent section
 * addressing one config; "agent" is the section itself. An unknown section
 * resolves to the first rather than a blank page, and takes no remainder
 * with it — the rest of an unknown route means nothing to the page that
 * ends up rendering.
 */
export function resolveRoute(route: string): { item: NavItem; rest: string } {
  const cut = route.indexOf("/");
  const id = cut === -1 ? route : route.slice(0, cut);
  const rest = cut === -1 ? "" : route.slice(cut + 1);
  for (const item of NAV_ITEMS) {
    if (item.id === id) return { item, rest };
  }
  return { item: NAV_ITEMS[0], rest: "" };
}
