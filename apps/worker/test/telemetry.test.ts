// telemetry.ts bridges the plain Metrics object to OTel exporters. The metric names and
// label sets are a FROZEN contract (dashboards/alerts key on them) — the prometheus tests
// here are the guard: they pin the four exact families, including the OTel→Prometheus
// rule that a counter instrument named funky_worker_jobs renders as funky_worker_jobs_total.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildResource, startTelemetry, type Telemetry } from "../src/telemetry";
import { createMetrics } from "../src/worker";

const okDepth = async () => ({ queued: 4, running: 3, dead: 0 });

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  // LIFO: telemetry shuts down (final push-mode flush) BEFORE its receiver closes —
  // flushing at a dead endpoint burns seconds in exporter retries.
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const k of ["OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
    delete process.env[k];
  }
});

/** A 200-OK OTLP/HTTP receiver capturing request bodies (the -http exporter sends JSON). */
async function otlpReceiver(): Promise<{ bodies: string[]; port: number }> {
  const bodies: string[] = [];
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const addr = srv.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { bodies, port };
}

/** Serve a telemetry's prometheus handler on an ephemeral port; return a scrape fn. */
async function serveMetrics(t: Telemetry): Promise<() => Promise<string>> {
  const srv = createServer((req, res) => t.metricsHandler?.(req, res));
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const addr = srv.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return async () => (await fetch(`http://localhost:${port}/metrics`)).text();
}

describe("prometheus mode — the frozen name/label contract", () => {
  it("renders exactly the four families, byte-identical names and labels", async () => {
    const m = createMetrics();
    m.inFlight = 3;
    m.jobs.completed = 10;
    m.jobs.retry_later = 2;
    m.appendConflicts = 1;
    const t = await startTelemetry({ modes: ["prometheus"], metrics: m, depth: okDepth });
    cleanups.push(() => t.shutdown());
    const scrape = await serveMetrics(t);
    const out = await scrape();

    expect(out).toContain("# TYPE funky_worker_turns_inflight gauge");
    expect(out).toContain("funky_worker_turns_inflight 3");
    expect(out).toContain("# TYPE funky_worker_jobs_total counter");
    expect(out).toContain('funky_worker_jobs_total{outcome="completed"} 10');
    expect(out).toContain('funky_worker_jobs_total{outcome="retry_later"} 2');
    expect(out).toContain('funky_worker_jobs_total{outcome="conflict"} 0');
    expect(out).toContain("# TYPE funky_worker_append_conflicts_total counter");
    expect(out).toContain("funky_worker_append_conflicts_total 1");
    expect(out).toContain("# TYPE funky_queue_depth gauge");
    expect(out).toContain('funky_queue_depth{state="queued"} 4');
    expect(out).toContain('funky_queue_depth{state="running"} 3');
    expect(out).toContain('funky_queue_depth{state="dead"} 0');

    // The naming rule this file exists to guard: instrument "funky_worker_jobs" must
    // ship as funky_worker_jobs_total — and never doubled.
    expect(out).not.toContain("_total_total");
    // Frozen label sets: no otel_scope_name smuggled onto the series.
    expect(out).not.toContain("otel_scope_name");
  });

  it("reflects live mutation of the shared Metrics object (the OTel path, end to end)", async () => {
    const m = createMetrics();
    const t = await startTelemetry({ modes: ["prometheus"], metrics: m, depth: okDepth });
    cleanups.push(() => t.shutdown());
    const scrape = await serveMetrics(t);

    expect(await scrape()).toContain('funky_worker_jobs_total{outcome="completed"} 0');
    m.jobs.completed += 1;
    expect(await scrape()).toContain('funky_worker_jobs_total{outcome="completed"} 1');
  });

  it("omits funky_queue_depth when the probe fails — the worker's own counters still render", async () => {
    const t = await startTelemetry({
      modes: ["prometheus"],
      metrics: createMetrics(),
      depth: async () => {
        throw new Error("db down");
      },
    });
    cleanups.push(() => t.shutdown());
    const out = await (await serveMetrics(t))();
    expect(out).not.toContain("funky_queue_depth{");
    expect(out).toContain("funky_worker_turns_inflight 0");
  });

  it("exposes no prometheus handler in otlp-only mode", async () => {
    const { port } = await otlpReceiver();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${port}`;
    const t = await startTelemetry({ modes: ["otlp"], metrics: createMetrics(), depth: okDepth });
    cleanups.push(() => t.shutdown());
    expect(t.metricsHandler).toBeUndefined();
  });
});

describe("otlp mode", () => {
  it("pushes the four series with service.name=funky-worker to an OTLP/HTTP receiver", async () => {
    const { bodies, port } = await otlpReceiver();

    // The standard env vars are the interface — no invented config.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${port}`;
    const m = createMetrics();
    m.jobs.completed = 7;
    const t = await startTelemetry({
      modes: ["otlp"],
      metrics: m,
      depth: okDepth,
      env: { OTEL_METRIC_EXPORT_INTERVAL: "50" },
    });
    cleanups.push(() => t.shutdown());

    const deadline = Date.now() + 5_000;
    while (bodies.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(bodies.length).toBeGreaterThan(0);

    const payload = JSON.parse(bodies[0] as string);
    const rm = payload.resourceMetrics[0];
    const resourceAttrs = Object.fromEntries(
      rm.resource.attributes.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resourceAttrs["service.name"]).toBe("funky-worker");

    const metricsByName = new Map<string, { name: string; sum?: unknown; gauge?: unknown }>();
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) metricsByName.set(metric.name, metric);
    }
    // Over OTLP the instrument name travels un-suffixed; the backend's Prometheus
    // renderer appends _total to the monotonic sums.
    expect([...metricsByName.keys()].sort()).toEqual([
      "funky_queue_depth",
      "funky_worker_append_conflicts",
      "funky_worker_jobs",
      "funky_worker_turns_inflight",
    ]);
    expect(metricsByName.get("funky_worker_jobs")?.sum).toMatchObject({ isMonotonic: true });
  });
});

describe("buildResource — explicit identity, no platform env guessing", () => {
  /** A fake GCP metadata server (Cloud Run worker pools have one; K_SERVICE they don't). */
  async function fakeMetadataServer(): Promise<string> {
    const srv = createServer((req, res) => {
      if (req.headers["metadata-flavor"] !== "Google") {
        res.writeHead(403).end();
        return;
      }
      if (req.url?.endsWith("/instance/region")) {
        res.writeHead(200).end("projects/12345/regions/us-central1");
      } else if (req.url?.endsWith("/instance/id")) {
        res.writeHead(200).end("instance-abc-123");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const addr = srv.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    return `http://localhost:${port}`;
  }

  it("stamps region + instance id from the metadata server when present", async () => {
    const base = await fakeMetadataServer();
    const r = await buildResource({ env: {}, metadataBaseUrl: base });
    expect(r.attributes["service.name"]).toBe("funky-worker");
    expect(r.attributes["cloud.region"]).toBe("us-central1");
    expect(r.attributes["service.instance.id"]).toBe("instance-abc-123");
    expect(r.attributes["faas.instance"]).toBe("instance-abc-123");
  });

  it("silently skips GCP attributes when the metadata server is absent", async () => {
    const r = await buildResource({ env: {}, metadataBaseUrl: "http://127.0.0.1:1" });
    expect(r.attributes["service.name"]).toBe("funky-worker");
    expect(r.attributes["cloud.region"]).toBeUndefined();
    expect(r.attributes["faas.instance"]).toBeUndefined();
  });

  it("honors OTEL_SERVICE_NAME and merges OTEL_RESOURCE_ATTRIBUTES (operator wins)", async () => {
    process.env.OTEL_SERVICE_NAME = "renamed-worker";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=prod,cloud.region=eu-west1";
    const r = await buildResource({ env: process.env, metadataBaseUrl: "http://127.0.0.1:1" });
    expect(r.attributes["service.name"]).toBe("renamed-worker");
    expect(r.attributes["deployment.environment"]).toBe("prod");
    expect(r.attributes["cloud.region"]).toBe("eu-west1");
  });
});
