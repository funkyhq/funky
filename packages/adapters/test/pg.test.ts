// The pg adapter under the conformance suite, bound to PGlite — real
// postgres in-process, zero setup. The CI binding against a network
// postgres container lives in pg-postgres.test.ts; PGlite serializes
// concurrent queries, so the contention cases only prove true parallelism
// there.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll } from "vitest";
import { createPgStore, type StoreDb } from "../src";
import { migrateStore } from "./migrate-store";
import { describeStoreConformance } from "./store-conformance";

let client: PGlite;

// Booting PGlite can outlast the 10s default when crash-resume's
// subprocesses share the CPU.
beforeAll(async () => {
  client = new PGlite();
  await migrateStore(client);
}, 60_000);

afterAll(async () => {
  await client.close();
});

describeStoreConformance("pg over PGlite", async () => {
  await client.exec(
    "TRUNCATE agent_configs, sessions, session_entries, work_items, pending_inputs RESTART IDENTITY CASCADE",
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
