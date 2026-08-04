// packages/ports/harness/src/pi-live.test.ts — gated LIVE smoke of the pi driver.
//
// Runs the FULL harness turn path — runTurn shell → harnessStrategy (fence,
// recovery, projection, commit) → PiHarness → the REAL createAgentSession → the
// REAL Anthropic API — with the model's commands executing in the in-process
// subprocess sandbox. Two turns: the second resumes from the mirrored transcript,
// proving materialize → SessionManager.open() → continue against the real SDK.
//
// Skipped without ANTHROPIC_API_KEY (CI). Run locally once per pi SDK upgrade
// (DESIGN.md §11 "Not covered offline"):
//   ANTHROPIC_API_KEY=sk-... pnpm vitest run src/pi-live.test.ts

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@funky/db";
import { type SandboxHandle, SubprocessDriver } from "@funky/sandbox";
import {
  EventStore,
  makeEvent,
  plainText,
  runTurn,
  textContent,
  type EventPayload,
  type Job,
  type SessionEvent,
  type TurnDeps,
} from "@funky/sessions";
import { PiHarness } from "./drivers/pi";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

const NS = "live-ns";
const agentConfigId = randomUUID();
const envConfigId = randomUUID();
const sessionId = randomUUID();

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let store: EventStore;
let sandbox: SubprocessDriver;
let handle: SandboxHandle;

describe.skipIf(!hasKey)("PiHarness LIVE smoke (real Anthropic + subprocess sandbox)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const dir of readdirSync(migrationsDir).sort()) {
      await pool.query(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
    }
    db = createDb(pool);
    store = new EventStore(db);
    sandbox = new SubprocessDriver();

    await pool.query(
      "insert into agent_configs (id, namespace, name, latest_version) values ($1,$2,$3,1)",
      [agentConfigId, NS, "live-agent"],
    );
    await pool.query("insert into env_configs (id, namespace, name) values ($1,$2,$3)", [
      envConfigId,
      NS,
      "live-env",
    ]);
    await pool.query(
      `insert into agent_config_versions (agent_config_id, version, namespace, system_prompt, model, tool_policy, runtime)
       values ($1, 1, $2, $3, $4, $5, $6)`,
      [
        agentConfigId,
        NS,
        "You are a terse coding agent. Use your tools; do not ask questions.",
        JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }),
        JSON.stringify({ max_iterations: 10 }),
        JSON.stringify({ type: "pi" }),
      ],
    );
    handle = await sandbox.provision({ network: { type: "unrestricted" } }, sessionId);
    await pool.query(
      `insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id, status, sandbox_handle)
       values ($1,$2,$3,1,$4,'ready',$5)`,
      [sessionId, NS, agentConfigId, envConfigId, JSON.stringify(handle)],
    );
  }, 120_000);

  afterAll(async () => {
    if (handle) await sandbox.teardown(handle).catch(() => {});
    await pool?.end();
    await container?.stop();
  });

  const deps = (): TurnDeps => ({
    store,
    llm: {
      complete: async () => {
        throw new Error("llm port must not be called for harness sessions");
      },
    } as TurnDeps["llm"],
    sandbox,
    db,
    harnesses: {
      pi: new PiHarness({ db, apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } }),
    },
  });

  const job = (): Job => ({
    id: randomUUID(),
    namespace: NS,
    sessionId,
    kind: "turn",
    attempts: 1,
    maxAttempts: 5,
  });

  async function sendUser(text: string): Promise<void> {
    const events = await store.readEvents(NS, sessionId);
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    const evt = makeEvent({ sessionId, namespace: NS, seq }, "user_message", {
      content: textContent(text),
    });
    await store.appendEvent(NS, sessionId, seq, evt);
  }

  it("turn 1: the model writes and verifies a file through its sandbox-bridged tools", async () => {
    await sendUser(
      "Create a file named hello.txt containing exactly the text funky-pi-smoke " +
        "(no trailing newline is fine). Then read it back to verify, and reply " +
        "with its contents.",
    );

    const outcome = await runTurn(job(), deps());
    if (outcome !== "completed") {
      // Live-debug aid: the recorded failure (if any) is the fastest diagnosis.
      const evts = await store.readEvents(NS, sessionId);
      console.log("LAST EVENTS:", JSON.stringify(evts.slice(-3), null, 2));
    }
    expect(outcome).toBe("completed");

    const events = await store.readEvents(NS, sessionId);
    const types = events.map((e) => e.type);
    expect(types[1]).toBe("harness_attempt_started");
    expect(types.at(-1)).toBe("turn_completed");
    // At least one journaled exec decision and its recorded result.
    const execs = events.filter(
      (e) =>
        e.type === "assistant_message" &&
        (e.payload as EventPayload<"assistant_message">).tool_calls.length > 0,
    );
    expect(execs.length).toBeGreaterThan(0);
    expect(types).toContain("tool_result");

    // The file REALLY landed in the sandbox workdir.
    const workdir = (handle as unknown as { workdir: string }).workdir;
    const content = await readFile(join(workdir, "hello.txt"), "utf8");
    expect(content.trim()).toBe("funky-pi-smoke");

    // Committed state: driver name + a mirrored transcript under the returned tip.
    const row = await pool.query("select harness_state from sessions where id=$1", [sessionId]);
    expect(row.rows[0].harness_state.driver).toBe("pi");
    const transcript = await pool.query(
      "select count(*)::int as n from harness_transcript_entries where funky_session_id=$1",
      [sessionId],
    );
    expect(transcript.rows[0].n).toBeGreaterThan(0);
  }, 300_000);

  it("turn 2: resumes from the mirrored transcript and remembers the file", async () => {
    await sendUser(
      "What are the exact contents of the file you created earlier? Reply with just the contents.",
    );

    expect(await runTurn(job(), deps())).toBe("completed");

    const events = await store.readEvents(NS, sessionId);
    // The second attempt resumed from turn 1's transcript tip.
    const attempts = events.filter(
      (e) => e.type === "harness_attempt_started",
    ) as SessionEvent<"harness_attempt_started">[];
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.payload.resumed_from).not.toBeNull();

    // The final answer names the content — pi reopened the materialized session
    // (or re-read the file); either way the session carried across turns.
    const finalTexts = events
      .filter((e) => e.type === "assistant_message")
      .map((e) => plainText((e.payload as EventPayload<"assistant_message">).content))
      .join("\n");
    expect(finalTexts).toContain("funky-pi-smoke");
  }, 300_000);
});
