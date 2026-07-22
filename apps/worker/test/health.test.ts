// health.ts is plumbing: a plain node:http server with /healthz (liveness) and an
// injected /metrics handler (telemetry.ts owns rendering). Exercised with fakes here;
// the real prometheus handler is covered in telemetry.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { type HealthServer, startHealthServer } from "../src/health";

describe("health server", () => {
  let server: HealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns 200 {status:ok} on /healthz when ping resolves", async () => {
    server = await startHealthServer({ port: 0, ping: async () => 1 });
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
    });
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.status).toBe(503);
  });

  it("dispatches /metrics to the injected handler", async () => {
    server = await startHealthServer({
      port: 0,
      ping: async () => 1,
      metricsHandler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("funky_worker_turns_inflight 2\n");
      },
    });
    const res = await fetch(`http://localhost:${server.port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("funky_worker_turns_inflight 2");
  });

  it("404s /metrics when no handler is mounted (otlp-only deploys)", async () => {
    server = await startHealthServer({ port: 0, ping: async () => 1 });
    const res = await fetch(`http://localhost:${server.port}/metrics`);
    expect(res.status).toBe(404);
  });

  it("404s unknown paths", async () => {
    server = await startHealthServer({ port: 0, ping: async () => 1 });
    const res = await fetch(`http://localhost:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});
