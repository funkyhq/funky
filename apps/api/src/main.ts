// apps/api/src/main.ts — the api's composition root from the ratified P3
// service split, and the only file that touches process.env or the
// network. Stateless by construction: every row lives in the Store, so
// SIGKILL is the shutdown story here as much as in the worker — no drain
// path, no signal handlers; restart policy belongs to the container.
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPgStore, type StoreDb } from "@funky/adapters";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const cfg = loadConfig();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb);

const app = buildApp({
  store,
  authToken: cfg.authToken,
  namespaceSource: cfg.namespaceSource,
  ping: () => pool.query("SELECT 1"),
});

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`api: listening on :${info.port} (auth ${cfg.authToken ? "enabled" : "DISABLED"})`);
});
