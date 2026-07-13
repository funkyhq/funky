// health.ts is plumbing: a plain node:http server + a pure Prometheus renderer. No DB here
// — the renderer is exercised directly, and the server with fake ping/depth probes.
import { afterEach, describe, expect, it } from "vitest";
import { type HealthServer, renderPrometheus, startHealthServer } from "../src/health";
import { createMetrics } from "../src/worker";

const okDepth = async () => ({ queued: 0, running: 0, dead: 0 });

describe("renderPrometheus", () => {
  it("emits every required metric family", () => {
    const m = createMetrics();
    m.inFlight = 3;
    m.jobs.completed = 10;
    m.jobs.retry_later = 2;
    m.appendConflicts = 1;
    const out = renderPrometheus(m, { queued: 4, running: 3, dead: 0 });

    expect(out).toContain("# TYPE funky_worker_turns_inflight gauge");
    expect(out).toContain("funky_worker_turns_inflight 3");
    expect(out).toContain("# TYPE funky_worker_jobs_total counter");
    expect(out).toContain('funky_worker_jobs_total{outcome="completed"} 10');
    expect(out).toContain('funky_worker_jobs_total{outcome="retry_later"} 2');
    expect(out).toContain('funky_worker_jobs_total{outcome="conflict"} 0');
    expect(out).toContain("funky_worker_append_conflicts_total 1");
    expect(out).toContain('funky_queue_depth{state="queued"} 4');
    expect(out).toContain('funky_queue_depth{state="running"} 3');
  });

  it("omits queue depth when the probe is unavailable", () => {
    const out = renderPrometheus(createMetrics(), null);
    expect(out).not.toContain("funky_queue_depth");
    expect(out).toContain("funky_worker_turns_inflight 0");
  });
});

describe("health server", () => {
  let server: HealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns 200 {status:ok} on /healthz when ping resolves", async () => {
    server = await startHealthServer({
      port: 0,
      ping: async () => 1,
      metrics: createMetrics(),
      depth: okDepth,
    });
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 on /healthz when ping rejects", async () => {
    server = await startHealthServer({
      port: 0,
      ping: async () => {
        throw new Error("db down");
      },
      metrics: createMetrics(),
      depth: okDepth,
    });
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.status).toBe(503);
  });

  it("serves /metrics as Prometheus text", async () => {
    const m = createMetrics();
    m.inFlight = 2;
    server = await startHealthServer({
      port: 0,
      ping: async () => 1,
      metrics: m,
      depth: async () => ({ queued: 5, running: 2, dead: 1 }),
    });
    const res = await fetch(`http://localhost:${server.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("funky_worker_turns_inflight 2");
    expect(body).toContain('funky_queue_depth{state="dead"} 1');
  });

  it("404s unknown paths", async () => {
    server = await startHealthServer({
      port: 0,
      ping: async () => 1,
      metrics: createMetrics(),
      depth: okDepth,
    });
    const res = await fetch(`http://localhost:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});
