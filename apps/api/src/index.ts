// apps/api/src/index.ts — the ONLY file that touches process.env or the network.
import "dotenv/config"; // dev convenience; production containers inject env directly
import { serve } from "@hono/node-server";
import { Client, Pool } from "pg";
import { createDb } from "@funky/db";
import { AgentsService, EnvsService } from "@funky/configs";
import { EventStore, JobQueue, SessionsService } from "@funky/sessions";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { EventBus } from "./sse";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// repo root .env, resolved from this file's location (cwd-independent)
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const cfg = loadConfig();

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  max: cfg.dbPoolMax,
});

const db = createDb(pool);
const store = new EventStore(db);
const queue = new JobQueue(db);

// DEDICATED client for LISTEN — never a pooled connection (it gets recycled and the
// listener silently goes deaf). The EventBus fans NOTIFYs out to open SSE streams.
const listenClient = new Client({ connectionString: cfg.databaseUrl });
await listenClient.connect();
const bus = new EventBus(listenClient);
await bus.start();

const app = buildApp({
  agents: new AgentsService(db),
  envs: new EnvsService(db),
  sessions: new SessionsService(db, store, queue),
  store,
  bus,
  authToken: cfg.authToken,
  namespaceSource: cfg.namespaceSource,
  ping: () => pool.query("SELECT 1"),
});

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`funky-api listening on http://localhost:${info.port}`);
});

// Graceful shutdown: stop accepting → close connections → release the pool + LISTEN client.
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await listenClient.end().catch(() => {});
    await pool.end();
    process.exit(0);
  });
  // safety net: force-exit if close hangs (stuck keep-alives, e.g. an open SSE stream)
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
