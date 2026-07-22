// apps/worker/src/health.ts — Phase E: liveness probe + metrics mount point.
//
// Plain node:http — NO Hono. This is plumbing, not an API. There is no readiness concept
// for a worker: nothing routes to it, so /healthz is liveness only (a SELECT 1).
// Metrics rendering lives in telemetry.ts (OTel); when prometheus mode is on, its
// request handler is mounted here so /healthz and /metrics share one port, one server.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type HealthDeps = {
  port: number;
  ping: () => Promise<unknown>; // SELECT 1 — liveness only
  /** GET /metrics handler (telemetry.ts, prometheus mode). Absent → /metrics 404s. */
  metricsHandler?: (req: IncomingMessage, res: ServerResponse) => void;
};

export type HealthServer = {
  readonly port: number;
  close(): Promise<void>;
};

export function startHealthServer(deps: HealthDeps): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

    if (path === "/healthz") {
      deps
        .ping()
        .then(() => sendJson(res, 200, { status: "ok" }))
        .catch(() => sendJson(res, 503, { status: "error" }));
      return;
    }
    if (path === "/metrics" && deps.metricsHandler) {
      deps.metricsHandler(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(deps.port, () => {
      server.removeListener("error", onError);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : deps.port;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
