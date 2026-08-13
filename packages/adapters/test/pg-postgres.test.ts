// The same conformance suite bound to a network postgres — the CI
// binding that exercises true concurrency (contended claims, lease
// races) that PGlite serializes away. Runs only when
// STORE_TEST_DATABASE_URL is set; the database is wiped per run.

import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createPgStore, type StoreDb } from "../src";
import { describeStoreConformance } from "./store-conformance";

const url = process.env.STORE_TEST_DATABASE_URL;

if (!url) {
  describe.skip("Store conformance: pg over network postgres", () => {
    it("skipped — set STORE_TEST_DATABASE_URL to run", () => {});
  });
} else {
  const ddl = readFileSync(new URL("../migrations/0000_init.sql", import.meta.url), "utf8");
  const pool = new Pool({ connectionString: url });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(ddl);
  });

  afterAll(async () => {
    await pool.end();
  });

  describeStoreConformance("pg over network postgres", async () => {
    await pool.query(
      "TRUNCATE agent_configs, env_configs, sessions, session_entries, work_items, pending_inputs RESTART IDENTITY CASCADE",
    );
    let offsetMs = 0;
    const store = createPgStore(drizzle({ client: pool }) as unknown as StoreDb, {
      now: () => new Date(Date.now() + offsetMs),
    });
    return {
      store,
      clock: {
        advance: (ms: number) => {
          offsetMs += ms;
        },
      },
    };
  });
}
