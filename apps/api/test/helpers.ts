// Shared test scaffolding: a fake AgentsService, fixtures, and request helpers.
// The whole app is exercised network-free via buildApp(deps) + app.request(),
// exactly as app.ts advertises. No database, no HTTP server.
import { vi, type Mock } from "vitest";
import type { Agent, AgentsService, AgentVersion, AuthContext } from "@funky/configs";
import { buildApp } from "../src/app";

/** What the static auth middleware injects for every /v1 request. */
export const CTX: AuthContext = { namespace: "default", principal: "token:default" };

/** A syntactically valid uuid v7 for path/query params. */
export const AGENT_ID = "0192f1b2-3c4d-7e5f-8a90-1b2c3d4e5f60";

/** Every AgentsService method, replaced by a spy the tests can program/inspect. */
export type FakeAgents = {
  create: Mock;
  list: Mock;
  get: Mock;
  update: Mock;
  archive: Mock;
  listVersions: Mock;
  getVersion: Mock;
};

function makeFakeAgents(overrides: Partial<FakeAgents> = {}): {
  service: AgentsService;
  fake: FakeAgents;
} {
  const fake: FakeAgents = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    ...overrides,
  };
  // AgentsService has a private field, so a structural cast is required for the double.
  return { service: fake as unknown as AgentsService, fake };
}

export type App = ReturnType<typeof buildApp>;

/** Build the app with sensible test defaults (auth off, ping ok) and a programmable service. */
export function makeApp(
  opts: {
    authToken?: string | null;
    ping?: () => Promise<unknown>;
    agents?: Partial<FakeAgents>;
  } = {},
): { app: App; fake: FakeAgents } {
  const { service, fake } = makeFakeAgents(opts.agents);
  const app = buildApp({
    agents: service,
    authToken: opts.authToken ?? null, // auth disabled by default; auth tests opt in
    ping: opts.ping ?? (async () => ({ rows: [{ "?column?": 1 }] })),
  });
  return { app, fake };
}

// --------------------------------------------------------------- request helpers

export function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers });
}

export function post(
  app: App,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------- fixtures

export function agentFixture(over: Partial<Agent> = {}): Agent {
  return {
    type: "agent",
    id: AGENT_ID,
    name: "data cruncher",
    description: null,
    metadata: {},
    version: 1,
    system_prompt: "You are a data analyst.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    tool_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    ...over,
  };
}

export function versionFixture(over: Partial<AgentVersion> = {}): AgentVersion {
  return {
    type: "agent_version",
    agent_id: AGENT_ID,
    version: 1,
    system_prompt: "You are a data analyst.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    tool_policy: {},
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "token:default",
    ...over,
  };
}

/** A minimal valid create body; override/extend fields per test. */
export function createBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "data cruncher",
    system_prompt: "You are a data analyst.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    ...over,
  };
}

/** uuid v7 shape — used to assert the request-id header/envelope value. */
export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
