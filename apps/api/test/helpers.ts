// Request helpers — the app is exercised network-free via buildApp(deps)
// + app.request(), exactly as app.ts advertises.
import type { SecretProvider, Store } from "@funky/agent";
import { buildApp } from "../src/app";

export type App = ReturnType<typeof buildApp>;

/** An app whose store is never reached — for envelope/auth/health and
 *  secrets tests. No secret store unless one is given. */
export function makeApp(
  opts: { authToken?: string | null; secrets?: SecretProvider | null } = {},
): App {
  return buildApp({
    store: {} as unknown as Store,
    secrets: opts.secrets ?? null,
    authToken: opts.authToken ?? null,
    ping: async () => ({}),
    stream: { pollMs: 1000, heartbeatMs: 15_000 },
  });
}

export function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers });
}

export function post(app: App, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return send(app, "POST", path, body, headers);
}

export function put(app: App, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return send(app, "PUT", path, body, headers);
}

export function del(app: App, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { method: "DELETE", headers });
}

function send(
  app: App,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** uuid v7 shape — used to assert the request-id header/envelope value. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
