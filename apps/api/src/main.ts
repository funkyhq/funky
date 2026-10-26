// apps/api/src/main.ts — the api's composition root from the ratified P3
// service split, and the only file that touches process.env or the
// network (through listen.ts, which serves HTTP/1.1 and h2c on one port). Stateless by construction: every row lives in the Store, so
// SIGKILL is the shutdown story — no drain path, no signal handlers;
// restart policy belongs to the container. (The worker drains, but only
// to hand a held claim back sooner; the api holds nothing.)
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createInfisicalSecretProvider, createPgStore, type StoreDb } from "@funky/adapters";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { listen } from "./listen";

const cfg = loadConfig();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);
// Secret values go to Infisical, never to Postgres.
const secrets = cfg.infisical ? createInfisicalSecretProvider(cfg.infisical) : null;

const app = buildApp({
  store,
  secrets,
  authToken: cfg.authToken,
  ping: () => pool.query("SELECT 1"),
  stream: { pollMs: cfg.streamPollMs, heartbeatMs: cfg.streamHeartbeatMs },
});

const { port } = await listen(app.fetch, cfg.port);
console.log(
  `api: listening on :${port}, HTTP/1.1 and h2c (auth ${cfg.authToken ? "enabled" : "DISABLED"}, ` +
    `secret store ${secrets ? "Infisical" : "off"})`,
);
