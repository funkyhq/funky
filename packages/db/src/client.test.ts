// Tests for the createDb() factory and the `tables` re-export. These stay
// offline: a pg Pool connects lazily, and Drizzle builds SQL synchronously, so
// we can assert wiring and rendered SQL without a running Postgres.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { createDb, tables, type Db } from "./client";
import { agentConfigs, agentConfigVersions } from "./schema";

const DUMMY_URL = "postgres://user:pass@localhost:5432/funky_test";

test("createDb returns a Drizzle query builder without opening a connection", async () => {
  const pool = new Pool({ connectionString: DUMMY_URL });
  try {
    const db: Db = createDb(pool);
    assert.equal(typeof db.select, "function");
    assert.equal(typeof db.insert, "function");
    assert.equal(typeof db.update, "function");
    assert.equal(typeof db.transaction, "function");
  } finally {
    await pool.end(); // no queries ran, so the pool never actually connected
  }
});

test("the query builder renders schema tables into SQL", async () => {
  const pool = new Pool({ connectionString: DUMMY_URL });
  try {
    const db = createDb(pool);
    const identity = db.select().from(agentConfigs).toSQL();
    assert.match(identity.sql, /from "agent_configs"/);

    const versions = db.select().from(agentConfigVersions).toSQL();
    assert.match(versions.sql, /from "agent_config_versions"/);
  } finally {
    await pool.end();
  }
});

test("`tables` re-exports both schema tables by their identifiers", () => {
  assert.equal(tables.agentConfigs, agentConfigs);
  assert.equal(tables.agentConfigVersions, agentConfigVersions);
  assert.deepEqual(Object.keys(tables).sort(), ["agentConfigVersions", "agentConfigs"].sort());
});
