// packages/ports/harness/src/pi-store.test.ts — the fenced pi transcript mirror
// against a real Postgres. The contract mirrors the claude-code store's: entries
// round-trip verbatim and in file order; re-flushing is a no-op (seen-set + entry-id
// dedupe); and a writer whose attempt token no longer matches
// sessions.harness_attempt is REJECTED (fenced), not interleaved.

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import { latestSdkSessionId } from "./drivers/claude-code-store";
import { loadPiTranscript, type PiFileEntry, PiTranscriptStore } from "./drivers/pi-store";
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
  return new PiTranscriptStore({ db, namespace: NS, funkySessionId: sessionId, attempt });
}

const header = (id: string): PiFileEntry => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/workspace",
});

const entry = (i: number, parentId: string | null): PiFileEntry => ({
  type: "message",
  id: `e${i}`,
  parentId,
  message: { role: "user", content: [{ type: "text", text: `m${i}` }] },
});

describe("flush/load round-trip", () => {
  it("mirrors the file — header first, entries in order — and loads it back verbatim", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    const file = [header("pi-1"), entry(1, null), entry(2, "e1")];
    await store.flush("pi-1", file);

    expect(await loadPiTranscript(db, NS, sessionId, "pi-1")).toEqual(file);
  });

  it("incremental flushes append only what is new; re-flushing everything is a no-op", async () => {
    await setFence("a1");
    const store = makeStore("a1");
    const file = [header("pi-1"), entry(1, null)];
    await store.flush("pi-1", file);
    file.push(entry(2, "e1"));
    await store.flush("pi-1", file); // grows by one
    await store.flush("pi-1", file); // everything already seen

    expect(await loadPiTranscript(db, NS, sessionId, "pi-1")).toEqual(file);
  });

  it("preload() marks the materialized prefix as already mirrored", async () => {
    await setFence("a1");
    const prior = [header("pi-1"), entry(1, null)];
    await makeStore("a1").flush("pi-1", prior);

    // A new attempt resumes: it preloads what it materialized, then flushes the
    // whole file — only the new entry may land.
    await setFence("a2");
    const store = makeStore("a2");
    store.preload(prior);
    await store.flush("pi-1", [...prior, entry(2, "e1")]);

    expect(await loadPiTranscript(db, NS, sessionId, "pi-1")).toEqual([...prior, entry(2, "e1")]);
  });

  it("a fresh store re-flushing rows another attempt already mirrored dedupes by entry id", async () => {
    await setFence("a1");
    await makeStore("a1").flush("pi-1", [header("pi-1"), entry(1, null)]);

    await setFence("a2");
    // No preload — the unique index is the backstop.
    await makeStore("a2").flush("pi-1", [header("pi-1"), entry(1, null), entry(2, "e1")]);

    expect(await loadPiTranscript(db, NS, sessionId, "pi-1")).toEqual([
      header("pi-1"),
      entry(1, null),
      entry(2, "e1"),
    ]);
  });
});

describe("★ the write fence", () => {
  it("a writer whose token no longer matches is rejected and inserts NOTHING", async () => {
    await setFence("a1");
    const zombie = makeStore("a1");
    await zombie.flush("pi-1", [header("pi-1"), entry(1, null)]); // accepted while current

    await setFence("a2"); // a new attempt took the turn
    await expect(
      zombie.flush("pi-1", [header("pi-1"), entry(1, null), entry(2, "e1")]),
    ).rejects.toBeInstanceOf(HarnessFencedError);

    // The zombie's post-fence entry never landed — no interleaving, ever.
    expect(await loadPiTranscript(db, NS, sessionId, "pi-1")).toEqual([
      header("pi-1"),
      entry(1, null),
    ]);
  });

  it("a fence of null (no active attempt) rejects writers too", async () => {
    await setFence(null);
    await expect(
      makeStore("a1").flush("pi-1", [header("pi-1")]),
    ).rejects.toBeInstanceOf(HarnessFencedError);
  });
});

describe("the resume tip", () => {
  it("pi rows feed the same latestSdkSessionId tip query the strategy uses", async () => {
    expect(await latestSdkSessionId(db, NS, sessionId)).toBeNull();
    await setFence("a1");
    await makeStore("a1").flush("pi-1", [header("pi-1"), entry(1, null)]);
    expect(await latestSdkSessionId(db, NS, sessionId)).toBe("pi-1");
  });
});
