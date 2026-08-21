// packages/adapters/src/store/migrate.ts
// The store's migration runner — a one-shot process entry (the compose
// `migrate` service), not part of the package barrel. Applies
// ../../migrations (drizzle v1 layout: one `<timestamp>_<name>/` dir per
// migration); each applied migration is recorded by name in the
// database, so re-running is a no-op and `docker compose up` can run
// this on every boot.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });
await migrate(drizzle({ client: pool }), {
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});
await pool.end();
console.log("migrate: schema is current");
