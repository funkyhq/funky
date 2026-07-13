// apps/worker/src/health.ts — Phase E: liveness probe + Prometheus metrics.
//
// Plain node:http — NO Hono. This is plumbing, not an API. There is no readiness concept
// for a worker: nothing routes to it, so /healthz is liveness only (a SELECT 1).

import { createServer, type ServerResponse } from "node:http";
import type { Metrics } from "./worker";

export type QueueDepth = { queued: number; running: number; dead: number };

export type HealthDeps = {
  port: number;
  ping: () => Promise<unknown>; // SELECT 1 — liveness only
  metrics: Metrics;
  depth: () => Promise<QueueDepth>; // queue.depth() — the autoscaling signal
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
    if (path === "/metrics") {
      // Never let a transient depth() failure blank the worker's own counters.
      deps
        .depth()
        .then((d) => sendText(res, 200, renderPrometheus(deps.metrics, d)))
        .catch(() => sendText(res, 200, renderPrometheus(deps.metrics, null)));
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

/** Render the minimum metric set in Prometheus text format. depth === null when the
 *  queue.depth() probe failed — the worker's own counters still render. */
export function renderPrometheus(metrics: Metrics, depth: QueueDepth | null): string {
  const lines: string[] = [];
  const family = (name: string, type: string, help: string, samples: string[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };

  family("funky_worker_turns_inflight", "gauge", "Turns currently in flight.", [
    `funky_worker_turns_inflight ${metrics.inFlight}`,
  ]);

  family(
    "funky_worker_jobs_total",
    "counter",
    "Jobs processed, by queue outcome.",
    (Object.keys(metrics.jobs) as Array<keyof Metrics["jobs"]>).map(
      (outcome) => `funky_worker_jobs_total{outcome="${outcome}"} ${metrics.jobs[outcome]}`,
    ),
  );

  family(
    "funky_worker_append_conflicts_total",
    "counter",
    "Conditional-append races lost to another worker (split-brain smoke detector).",
    [`funky_worker_append_conflicts_total ${metrics.appendConflicts}`],
  );

  if (depth) {
    family("funky_queue_depth", "gauge", "Jobs in the queue by state (autoscaling signal).", [
      `funky_queue_depth{state="queued"} ${depth.queued}`,
      `funky_queue_depth{state="running"} ${depth.running}`,
      `funky_queue_depth{state="dead"} ${depth.dead}`,
    ]);
  }

  return `${lines.join("\n")}\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  res.end(body);
}
