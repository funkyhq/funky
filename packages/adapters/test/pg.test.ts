// The pg adapter under the conformance suite, bound to PGlite — real
// postgres in-process, zero setup. The CI binding against a network
// postgres container lives in pg-postgres.test.ts; PGlite serializes
// concurrent queries, so the contention cases only prove true parallelism
// there.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { DEFAULT_NAMESPACE, type UserMessage } from "@funky/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStore, type StoreDb } from "../src";
import { migrateStore } from "./migrate-store";
import { describeStoreConformance } from "./store-conformance";

let client: PGlite;

const TRUNCATE =
  "TRUNCATE agent_configs, sessions, tasks, session_entries, work_items, pending_inputs RESTART IDENTITY CASCADE";

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
  await client.exec(TRUNCATE);
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

// finished_at is adapter bookkeeping the port never returns, so the
// conformance suite cannot see it; it is read off the table here.
describe("pg store: work item finished_at", () => {
  it("closes each item at the instant the next one opens, and leaves the open one null", async () => {
    await client.exec(TRUNCATE);
    let nowMs = Date.parse("2026-11-03T00:00:00.000Z");
    const store = createPgStore(drizzle({ client }) as unknown as StoreDb, {
      now: () => new Date(nowMs),
    });
    const user = (text: string): UserMessage => ({
      role: "user",
      content: [{ type: "text", text }],
    });
    const reply = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok" }],
      model: "m",
      stopReason: "end_turn" as const,
    };
    const agent = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
      setupCommands: [],
    });
    const session = await store.createSession({
      namespace: DEFAULT_NAMESPACE,
      agentConfigId: agent.agentConfigId,
    });
    const claim = async () => (await store.claimItem({ leaseMs: 60_000, session }))!;

    // A run of two items, and a follow-up queued while it ran: the
    // ending commit chains it into a second run, left open.
    await store.intake(session, user("go"));
    const first = await claim();
    nowMs += 5_000;
    await store.commitStep({
      itemRef: first.item,
      token: first.token,
      append: [reply],
      next: { kind: "execute_tools" },
    });
    const second = await claim();
    await store.intake(session, user("and then"));
    nowMs += 3_000;
    await store.commitStep({
      itemRef: second.item,
      token: second.token,
      append: [reply],
      next: { kind: "end_run", status: "completed" },
    });

    const { rows } = await client.query<{ created_at: Date; finished_at: Date | null }>(
      "SELECT created_at, finished_at FROM work_items ORDER BY created_at",
    );
    const at = (offsetMs: number) => new Date(Date.parse("2026-11-03T00:00:00.000Z") + offsetMs);
    expect(rows).toEqual([
      { created_at: at(0), finished_at: at(5_000) },
      { created_at: at(5_000), finished_at: at(8_000) },
      { created_at: at(8_000), finished_at: null },
    ]);
  });
});
