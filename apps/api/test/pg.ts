// Shared testcontainers harness for the sessions integration + SSE tests. Like
// packages/sessions/src/store-queue.test.ts, these exercise behaviour a single-connection
// engine can't show (transactional atomicity, LISTEN/NOTIFY across connections), so they
// run against a REAL Postgres. One container per test file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { createDb, type Db } from "@funky/db";

// testcontainers' Ryuk reaper pulls its own image over the network; disable it and rely
// on stop(). Must be set before any container starts.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

export type PgHarness = {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: Db;
  uri: string;
  /** TRUNCATE the sessions tables between tests (jobs/events/pull are global). */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startPg(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const uri = container.getConnectionUri();
  const pool = new Pool({ connectionString: uri });

  // Apply the real migrations in order (breakpoint lines are `--` comments, so each file
  // runs as one multi-statement query).
  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }

  const db = createDb(pool);
  return {
    container,
    pool,
    db,
    uri,
    reset: async () => {
      await pool.query(
        "truncate table session_events, turn_jobs, sessions, agent_config_versions, agent_configs, env_configs cascade",
      );
    },
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
