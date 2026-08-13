// The pg adapter under the conformance suite, bound to PGlite — real
// postgres in-process, zero setup. The CI binding against a network
// postgres container lives in pg-postgres.test.ts; PGlite serializes
// concurrent queries, so the contention cases only prove true parallelism
// there.

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll } from "vitest";
import { createPgStore, type StoreDb } from "../src";
import { describeStoreConformance } from "./store-conformance";

const ddl = readFileSync(new URL("../migrations/0000_init.sql", import.meta.url), "utf8");

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
});

afterAll(async () => {
  await client.close();
});

describeStoreConformance("pg over PGlite", async () => {
  await client.exec(
    "TRUNCATE agent_configs, env_configs, sessions, session_entries, work_items, pending_inputs RESTART IDENTITY CASCADE",
  );
  let offsetMs = 0;
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb, {
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
