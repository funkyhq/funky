// packages/ports/harness/src/claude-code-store.test.ts — the fenced SessionStore
// against a real Postgres. The contract under test is DESIGN.md §5: entries round-trip
// verbatim and in order; re-delivered batches dedupe by uuid; and a writer whose
// attempt token no longer matches sessions.harness_attempt is REJECTED (fenced), not
// interleaved.

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import { DrizzleSessionStore, latestSdkSessionId } from "./drivers/claude-code-store";
import { HarnessFencedError } from "./port";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

const NS = "test-ns";
const agentConfigId = randomUUID();
const envConfigId = randomUUID();
let sessionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const dir of readdirSync(migrationsDir).sort()) {
    await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  db = createDb(pool);
  await pool.query(
    "insert into agent_configs (id, namespace, name, latest_version) values ($1,$2,$3,1)",
    [agentConfigId, NS, "test-agent"],
  );
  await pool.query("insert into env_configs (id, namespace, name) values ($1,$2,$3)", [
    envConfigId,
    NS,
    "test-env",
  ]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("truncate table harness_transcript_entries");
  sessionId = randomUUID();
  await pool.query(
    `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status)
     values ($1,$2,$3,1,$4,'ready')`,
    [sessionId, NS, agentConfigId, envConfigId],
  );
});

async function setFence(attempt: string | null) {
  await pool.query("update sessions set harness_attempt=$1 where id=$2", [attempt, sessionId]);
}

function makeStore(attempt: string) {
  return new DrizzleSessionStore({ db, namespace: NS, funkySessionId: sessionId, attempt });
}

const key = (sdkSessionId: string, subpath?: string) => ({
  projectKey: "pk-test",
  sessionId: sdkSessionId,
  ...(subpath !== undefined ? { subpath } : {}),
});

const entry = (i: number, extra: Record<string, unknown> = {}): SessionStoreEntry => ({
  type: "user",
  uuid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  message: { i, nested: { deep: true } },
  ...extra,
});

describe("append/load round-trip", () => {
  it("returns entries deep-equal to what was appended, in append order", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    const batch1 = [entry(1), entry(2)];
    const batch2 = [entry(3)];
    await store.append(key("cc-1"), batch1);
    await store.append(key("cc-1"), batch2);

    const loaded = await store.load(key("cc-1"));
    expect(loaded).toEqual([...batch1, ...batch2]);
  });

  it("load returns null for a key never written", async () => {
    await setFence("a1");
    expect(await makeStore("a1").load(key("cc-unknown"))).toBeNull();
  });

  it("uuid-less entries append without dedup", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    const noUuid: SessionStoreEntry = { type: "custom-title", title: "t" };
    await store.append(key("cc-1"), [noUuid]);
    await store.append(key("cc-1"), [noUuid]); // no uuid → both land
    expect(await store.load(key("cc-1"))).toHaveLength(2);
  });

  it("a re-delivered batch dedupes by uuid instead of duplicating rows", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    const batch = [entry(1), entry(2)];
    await store.append(key("cc-1"), batch);
    await store.append(key("cc-1"), batch); // mirror retry re-delivers
    expect(await store.load(key("cc-1"))).toEqual(batch);
  });

  it("main and subagent transcripts are separate keys; listSubkeys finds subagents", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    await store.append(key("cc-1"), [entry(1)]);
    await store.append(key("cc-1", "subagents/agent-7"), [entry(2)]);

    expect(await store.load(key("cc-1"))).toEqual([entry(1)]);
    expect(await store.load(key("cc-1", "subagents/agent-7"))).toEqual([entry(2)]);
    expect(await store.listSubkeys({ projectKey: "pk-test", sessionId: "cc-1" })).toEqual([
      "subagents/agent-7",
    ]);
  });

  it("deleting the main key cascades to subkeys", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    await store.append(key("cc-1"), [entry(1)]);
    await store.append(key("cc-1", "subagents/agent-7"), [entry(2)]);

    await store.delete(key("cc-1")); // no subpath → cascade
    expect(await store.load(key("cc-1"))).toBeNull();
    expect(await store.load(key("cc-1", "subagents/agent-7"))).toBeNull();
  });
});

describe("★ the write fence", () => {
  it("a writer whose token no longer matches is rejected and inserts NOTHING", async () => {
    await setFence("a1");
    const zombie = makeStore("a1");
    await zombie.append(key("cc-1"), [entry(1)]); // accepted while current

    await setFence("a2"); // a new attempt took the turn
    await expect(zombie.append(key("cc-1"), [entry(2)])).rejects.toBeInstanceOf(
      HarnessFencedError,
    );
    expect(zombie.fenced).toBe(true); // the driver reads this to classify mirror_error

    // The zombie's post-fence batch never landed — no interleaving, ever.
    expect(await makeStore("a2").load(key("cc-1"))).toEqual([entry(1)]);
  });

  it("a fence of null (no active attempt) rejects writers too", async () => {
    await setFence(null);
    await expect(makeStore("a1").append(key("cc-1"), [entry(1)])).rejects.toBeInstanceOf(
      HarnessFencedError,
    );
  });

  it("duplicates under the CURRENT fence are benign, not a fence rejection", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    await store.append(key("cc-1"), [entry(1)]);
    await expect(store.append(key("cc-1"), [entry(1)])).resolves.toBeUndefined();
    expect(store.fenced).toBe(false);
  });
});

describe("latestSdkSessionId (the resume tip)", () => {
  it("null with no transcript; then the newest main-transcript session id", async () => {
    expect(await latestSdkSessionId(db, NS, sessionId)).toBeNull();

    await setFence("a1");
    const store = makeStore("a1");
    await store.append(key("cc-old"), [entry(1)]);
    await store.append(key("cc-new"), [entry(2)]);
    // Subagent rows must not win the tip.
    await store.append(key("cc-old", "subagents/agent-1"), [entry(3)]);

    expect(await latestSdkSessionId(db, NS, sessionId)).toBe("cc-new");
  });
});
