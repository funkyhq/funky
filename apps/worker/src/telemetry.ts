// apps/worker/src/telemetry.ts — OpenTelemetry metrics: one MeterProvider, N exporters.
//
// The pull loop stays dumb: it mutates the plain `Metrics` object (worker.ts) and this
// module bridges it to OTel with observable instruments, read lazily at export time.
// Which exporters run is deploy-time configuration (FUNKY_METRICS, parsed in config.ts):
//
//   prometheus (default) — pull: a request handler for GET /metrics on the health server.
//   otlp                 — push over OTLP/HTTP; endpoint/headers/interval come from the
//                          standard OTEL_EXPORTER_OTLP_* / OTEL_METRIC_EXPORT_INTERVAL
//                          env vars (the SDK reads them natively — no invented config).
//   gcm                  — push straight to Google Cloud Monitoring; the exporter is
//                          dynamic-imported so non-Google deploys never load it.
//
// METRIC NAMES AND LABEL SETS ARE A STABLE CONTRACT — downstream dashboards and alerts
// key on them. The four series: funky_queue_depth{state}, funky_worker_turns_inflight,
// funky_worker_jobs_total{outcome}, funky_worker_append_conflicts_total.

import type { IncomingMessage, ServerResponse } from "node:http";
import { diag, DiagConsoleLogger, DiagLogLevel, type Meter } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import {
  detectResources,
  envDetector,
  defaultResource,
  resourceFromAttributes,
  type Resource,
} from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { Metrics } from "./worker";

export const METRICS_MODES = ["prometheus", "otlp", "gcm"] as const;
export type MetricsMode = (typeof METRICS_MODES)[number];

export type QueueDepth = { queued: number; running: number; dead: number };

export type TelemetryDeps = {
  modes: readonly MetricsMode[];
  metrics: Metrics; // shared mutable counters — the source of truth, owned by the pull loop
  depth: () => Promise<QueueDepth>; // queue.depth() — the autoscaling signal
  /** OTEL_* standard vars. Only index.ts passes process.env here (and the OTel SDK
   *  additionally reads its own OTEL_* config from process.env natively). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: where the GCP metadata server lives. */
  metadataBaseUrl?: string;
};

export type Telemetry = {
  /** Present iff "prometheus" mode is on. Mount at GET /metrics on the health server. */
  metricsHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Final flush (push modes) + release. Call while the DB pool is still alive. */
  shutdown(): Promise<void>;
};

export async function startTelemetry(deps: TelemetryDeps): Promise<Telemetry> {
  const env = deps.env ?? {};
  // Export failures must be visible but bounded and non-fatal: the SDK routes them
  // through diag, one line per failed export — never an exception into the pull loop.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const resource = await buildResource({ env, ...(deps.metadataBaseUrl ? { metadataBaseUrl: deps.metadataBaseUrl } : {}) });

  const readers: IMetricReader[] = [];
  let metricsHandler: Telemetry["metricsHandler"];
  for (const mode of deps.modes) {
    switch (mode) {
      case "prometheus": {
        // withoutScopeInfo: label sets are frozen — no otel_scope_name on the series.
        // (target_info stays: a new, additive family that breaks no existing query.)
        const exporter = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
        readers.push(exporter);
        metricsHandler = (req, res) => void exporter.getMetricsRequestHandler(req, res);
        break;
      }
      case "otlp": {
        const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
        readers.push(
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(), // endpoint/headers/timeout from OTEL_EXPORTER_OTLP_*
            exportIntervalMillis: exportIntervalMs(env),
          }),
        );
        break;
      }
      case "gcm": {
        // Optional convenience for Google deploys; dynamic import keeps the module —
        // and its transitive google-auth machinery — out of every other deploy's boot.
        const { MetricExporter } = await import(
          "@google-cloud/opentelemetry-cloud-monitoring-exporter"
        );
        readers.push(
          new PeriodicExportingMetricReader({
            exporter: new MetricExporter(),
            exportIntervalMillis: exportIntervalMs(env),
          }),
        );
        break;
      }
    }
  }

  const provider = new MeterProvider({ resource, readers });
  registerInstruments(provider.getMeter("funky-worker"), deps.metrics, deps.depth);

  return {
    ...(metricsHandler ? { metricsHandler } : {}),
    shutdown: () => provider.shutdown(),
  };
}

/** Resource identity is set EXPLICITLY — never inferred from platform env vars like
 *  K_SERVICE (Cloud Run worker pools don't get them; that failure is why this module
 *  exists). On GCP the metadata server is the authority for region/instance; elsewhere
 *  the probe silently misses. OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES merge last,
 *  so any deploy can override or extend. */
export async function buildResource(opts: {
  env: NodeJS.ProcessEnv;
  metadataBaseUrl?: string;
}): Promise<Resource> {
  const gcp = await probeGcpMetadata(opts.metadataBaseUrl);
  const explicit = resourceFromAttributes({
    "service.name": "funky-worker",
    ...(gcp
      ? {
          "cloud.region": gcp.region,
          "service.instance.id": gcp.instanceId,
          "faas.instance": gcp.instanceId,
        }
      : {}),
  });
  // envDetector reads OTEL_RESOURCE_ATTRIBUTES + OTEL_SERVICE_NAME from process.env.
  // Merged last: the operator's env wins over our defaults.
  return defaultResource().merge(explicit).merge(detectResources({ detectors: [envDetector] }));
}

const GCP_METADATA_BASE = "http://metadata.google.internal";

/** Works identically on Cloud Run services, jobs, and worker pools. Short timeout,
 *  null on any failure — off GCP this must cost almost nothing and never throw. */
async function probeGcpMetadata(
  baseUrl: string = GCP_METADATA_BASE,
): Promise<{ region: string; instanceId: string } | null> {
  const get = async (path: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/computeMetadata/v1/instance/${path}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) throw new Error(`metadata ${path}: ${res.status}`);
    return res.text();
  };
  try {
    const [regionPath, instanceId] = await Promise.all([get("region"), get("id")]);
    // region arrives as "projects/<num>/regions/<region>" — keep the last segment.
    const region = regionPath.split("/").pop() || regionPath;
    return { region, instanceId };
  } catch {
    return null;
  }
}

/** OTEL_METRIC_EXPORT_INTERVAL (ms) — the standard env var; spec default 60s.
 *  The JS SDK only applies it inside NodeSDK, so the standalone reader reads it here. */
function exportIntervalMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** Observable instruments over the shared Metrics object. Counter instruments are named
 *  WITHOUT the `_total` suffix — the OTel→Prometheus renderer appends it to monotonic
 *  counters, so "funky_worker_jobs" is exactly what ships as funky_worker_jobs_total
 *  (naming it with the suffix would ship funky_worker_jobs_total_total). */
function registerInstruments(
  meter: Meter,
  metrics: Metrics,
  depth: () => Promise<QueueDepth>,
): void {
  meter
    .createObservableGauge("funky_worker_turns_inflight", {
      description: "Turns currently in flight.",
    })
    .addCallback((r) => r.observe(metrics.inFlight));

  meter
    .createObservableCounter("funky_worker_jobs", {
      description: "Jobs processed, by queue outcome.",
    })
    .addCallback((r) => {
      for (const outcome of Object.keys(metrics.jobs) as Array<keyof Metrics["jobs"]>) {
        r.observe(metrics.jobs[outcome], { outcome });
      }
    });

  meter
    .createObservableCounter("funky_worker_append_conflicts", {
      description:
        "Conditional-append races lost to another worker (split-brain smoke detector).",
    })
    .addCallback((r) => r.observe(metrics.appendConflicts));

  meter
    .createObservableGauge("funky_queue_depth", {
      description: "Jobs in the queue by state (autoscaling signal).",
    })
    .addCallback(async (r) => {
      try {
        const d = await depth();
        r.observe(d.queued, { state: "queued" });
        r.observe(d.running, { state: "running" });
        r.observe(d.dead, { state: "dead" });
      } catch {
        // Probe failed: skip the observation — never report zeros that lie. The
        // worker's own counters still export.
      }
    });
}
