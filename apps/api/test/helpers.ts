// Request helpers — the app is exercised network-free via buildApp(deps)
// + app.request(), exactly as app.ts advertises.
import type { Packages } from "@funky/core";
import {
  type Store,
  type TemplateBuilder,
  type TemplateBuildStatus,
  UnsupportedPackagesError,
} from "@funky/agent";
import { buildApp } from "../src/app";

export type App = ReturnType<typeof buildApp>;

/**
 * A TemplateBuilder that records every start and answers status from a
 * table the test sets (`settle`); an unsettled build reads "building".
 * Like the E2B builder, "cargo" is a manager it cannot install, and
 * `failStatus` makes the provider unreachable.
 */
export function fakeTemplates() {
  const started: Packages[] = [];
  const statuses = new Map<string, TemplateBuildStatus>();
  const state = { failStatus: false };
  const templates: TemplateBuilder = {
    start: async (packages) => {
      if ((packages.cargo ?? []).length > 0) {
        throw new UnsupportedPackagesError("unsupported package manager(s): cargo");
      }
      started.push(packages);
      const n = started.length;
      return { templateId: `tpl_${n}`, buildId: `bld_${n}` };
    },
    status: async ({ buildId }) => {
      if (state.failStatus) throw new Error("provider unreachable");
      return statuses.get(buildId) ?? { status: "building" };
    },
  };
  return {
    templates,
    started,
    state,
    settle: (buildId: string, status: TemplateBuildStatus) => statuses.set(buildId, status),
  };
}

/** An app whose store is never reached — for envelope/auth/health tests. */
export function makeApp(opts: { authToken?: string | null } = {}): App {
  return buildApp({
    store: {} as unknown as Store,
    templates: fakeTemplates().templates,
    authToken: opts.authToken ?? null,
    ping: async () => ({}),
    stream: { pollMs: 1000, heartbeatMs: 15_000 },
  });
}

export function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers });
}

export function post(app: App, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** uuid v7 shape — used to assert the request-id header/envelope value. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
