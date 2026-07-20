// apps/worker/src/index.ts — the ONLY file that touches process.env or the network.
import "dotenv/config"; // dev convenience; production containers inject env directly
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { createDb } from "@funky/db";
import { type HarnessPort, makeHarness } from "@funky/harness";
import { FakeLlm, type LlmConfig, makeLlm } from "@funky/llm";
import { makeSandbox, type SandboxConfig } from "@funky/sandbox";
import { EventStore, JobQueue } from "@funky/sessions";
import { type Config, loadConfig } from "./config";
import { startHealthServer } from "./health";
import { createMetrics, startWorker } from "./worker";

// repo root .env, resolved from this file's location (cwd-independent), like apps/api.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const cfg = loadConfig();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
const db = createDb(pool);
const queue = new JobQueue(db);
const store = new EventStore(db);
const metrics = createMetrics();

// DEDICATED client for LISTEN — never a pooled connection (it gets recycled and the
// listener silently goes deaf, with no error).
const listenClient = new Client({ connectionString: cfg.databaseUrl });
await listenClient.connect();

// The claude-code harness needs an Anthropic key regardless of FUNKY_LLM; without
// one, harness sessions fail their turns with a terminal HARNESS error instead.
const harness: HarnessPort | undefined = cfg.anthropicApiKey
  ? makeHarness({
      driver: "claude-code",
      db,
      apiKey: cfg.anthropicApiKey,
      cwdRoot: cfg.harnessCwdRoot,
      scratchRoot: cfg.harnessScratchRoot,
    })
  : undefined;

const worker = startWorker({
  queue,
  store,
  llm: makeLlm(llmConfig(cfg)), // fake by default — no API key needed
  sandbox: makeSandbox(sandboxConfig(cfg)), // docker by default — isolated, no account needed
  ...(harness ? { harness } : {}),
  db,
  listenClient,
  concurrency: cfg.concurrency,
  metrics,
});

const health = await startHealthServer({
  port: cfg.healthPort,
  ping: () => pool.query("SELECT 1"),
  metrics,
  depth: () => queue.depth(),
});

console.log(
  `funky-worker: concurrency=${cfg.concurrency} health=:${health.port} ` +
    `llm=${cfg.llm} sandbox=${cfg.sandbox}`,
);

// The fake driver needs no API key: with no registered scripts every session runs the
// driver's DEFAULT_SCRIPT — a real sandbox command, then a summary. Real work uses
// FUNKY_LLM=ai-sdk.
function llmConfig(c: Config): LlmConfig {
  return c.llm === "ai-sdk"
    ? { driver: "ai-sdk" }
    : { driver: "fake", instance: new FakeLlm({ scripts: {} }) };
}

// docker (default) gives every session a real, isolated container from a base image on the
// local daemon — no account. e2b gives every session an isolated remote sandbox that
// outlives any single worker (and any single host).
function sandboxConfig(c: Config): SandboxConfig {
  switch (c.sandbox) {
    case "e2b":
      return {
        driver: "e2b",
        apiKey: c.e2bApiKey ?? "", // non-null per the config refine; "" can't slip through the driver's key check
        sandboxTimeoutMs: c.e2bSandboxTimeoutMs,
      };
    default:
      return { driver: "docker", image: c.dockerImage };
  }
}

// Shutdown: drain, don't kill. Stop pulling, let in-flight turns finish, then release
// resources. Draining is an optimization, not a correctness requirement — a SIGKILLed
// worker simply leaves its leases to expire and another worker resumes from the log.
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`funky-worker: ${sig} received, draining`);
  // safety net: if drain hasn't finished in 120s, exit anyway.
  setTimeout(() => process.exit(1), 120_000).unref();
  await worker.stop();
  await health.close();
  await listenClient.end();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// handle(job) is not awaited, so an unexpected throw must be logged, never fatal.
process.on("unhandledRejection", (reason) => console.error("[worker] unhandledRejection", reason));
