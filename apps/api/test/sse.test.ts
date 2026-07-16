// The SSE fan-out (apps/api/src/sse.ts) against a REAL Postgres: LISTEN/NOTIFY across
// connections and the append-driven live path can't be exercised on a single-connection
// engine. We drive runSseStream directly with a fake stream that records frames — the
// route wiring (headers, cursor) is HTTP-tested in sessions.integration.test.ts.
import { randomUUID } from "node:crypto";
import type { SSEStreamingApi } from "hono/streaming";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventStore, makeEvent, textContent } from "@funky/sessions";
import { EventBus, runSseStream } from "../src/sse";
import { startPg, type PgHarness } from "./pg";

const NS = "default";

let pg: PgHarness;
let store: EventStore;
let listenClient: Client;
let bus: EventBus;

// FK parents shared by every session (the FKs are on id only).
const agentConfigId = randomUUID();
const envConfigId = randomUUID();
let sessionId: string;

beforeAll(async () => {
  pg = await startPg();
  store = new EventStore(pg.db);

  listenClient = new Client({ connectionString: pg.uri });
  await listenClient.connect();
  bus = new EventBus(listenClient);
  await bus.start();

  await pg.pool.query("insert into agent_configs (id, namespace, name) values ($1, $2, $3)", [
    agentConfigId,
    NS,
    "a",
  ]);
  await pg.pool.query(
    "insert into env_configs (id, namespace, name) values ($1, $2, $3)",
    [envConfigId, NS, "e"],
  );
}, 120_000);

afterAll(async () => {
  await listenClient?.end();
  await pg?.stop();
});

beforeEach(async () => {
  await pg.pool.query("truncate table session_events cascade");
  sessionId = randomUUID();
  await pg.pool.query(
    "insert into sessions (id, namespace, agent_config_id, agent_version, env_config_id) values ($1,$2,$3,$4,$5)",
    [sessionId, NS, agentConfigId, 1, envConfigId],
  );
});

// runSseStream loops forever; every test starts it detached and ends it via abort.
let running: Promise<void> | null = null;
afterEach(async () => {
  await running?.catch(() => {});
  running = null;
});

// --------------------------------------------------------------------- helpers

/** Records every frame + raw write; can simulate a client disconnect. */
class FakeStream {
  frames: { id?: string; event?: string; data: string }[] = [];
  raw: string[] = [];
  aborted = false;
  private cbs: Array<() => void> = [];

  async writeSSE(m: { id?: string; event?: string; data: string | Promise<string> }) {
    this.frames.push({ id: m.id, event: m.event, data: await m.data });
  }
  async write(s: string | Uint8Array) {
    this.raw.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return this as unknown as SSEStreamingApi;
  }
  onAbort(cb: () => void) {
    this.cbs.push(cb);
  }
  simulateAbort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const cb of this.cbs) cb();
  }
  seqs(): number[] {
    return this.frames.map((f) => Number(f.id));
  }
  asStream(): SSEStreamingApi {
    return this as unknown as SSEStreamingApi;
  }
}

async function appendEvent(seq: number, text = `m${seq}`): Promise<void> {
  const evt = makeEvent({ sessionId, namespace: NS, seq }, "user_message", {
    content: textContent(text),
  });
  await store.appendEvent(NS, sessionId, seq, evt);
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ==================================================================== tests

describe("runSseStream", () => {
  it("replays existing events from seq 0, then goes live", async () => {
    await appendEvent(1);
    await appendEvent(2);

    const s = new FakeStream();
    running = runSseStream(s.asStream(), { store, bus, namespace: NS, sessionId, cursor: 0 });

    await waitFor(() => s.seqs().length === 2); // replay
    expect(s.seqs()).toEqual([1, 2]);
    expect(s.frames[0]).toMatchObject({ id: "1", event: "user_message" });
    expect(JSON.parse(s.frames[0]!.data)).toMatchObject({
      type: "user_message",
      seq: 1,
      session_id: sessionId,
      payload: { content: [{ type: "text", text: "m1" }] },
    });

    // live: an append (with its own NOTIFY) reaches the open stream quickly
    await appendEvent(3);
    await waitFor(() => s.seqs().length === 3);
    expect(s.seqs()).toEqual([1, 2, 3]);

    s.simulateAbort();
  });

  it("emits a live-appended event within ~100ms", async () => {
    const s = new FakeStream();
    running = runSseStream(s.asStream(), { store, bus, namespace: NS, sessionId, cursor: 0 });
    await waitFor(() => bus.subscriberCount() === 1); // ensure subscribed + replay done

    const t0 = Date.now();
    await appendEvent(1);
    await waitFor(() => s.seqs().length === 1);
    expect(Date.now() - t0).toBeLessThan(1_000);

    s.simulateAbort();
  });

  it("resumes from a Last-Event-ID cursor with no duplicates", async () => {
    for (const seq of [1, 2, 3, 4, 5]) await appendEvent(seq);

    const s = new FakeStream();
    running = runSseStream(s.asStream(), { store, bus, namespace: NS, sessionId, cursor: 3 });

    await waitFor(() => s.seqs().length === 2);
    expect(s.seqs()).toEqual([4, 5]); // strictly after seq 3, none repeated

    s.simulateAbort();
  });

  it("loses no event appended during the replay window (subscribe-first)", async () => {
    await appendEvent(1); // committed before the stream opens

    const s = new FakeStream();
    // subscribe happens synchronously inside runSseStream before its first await, so the
    // NOTIFY for seq 2 cannot slip through the replay/live gap.
    running = runSseStream(s.asStream(), { store, bus, namespace: NS, sessionId, cursor: 0 });
    await appendEvent(2); // races the replay read

    await waitFor(() => s.seqs().length === 2);
    expect(s.seqs()).toEqual([1, 2]);
    expect(new Set(s.seqs()).size).toBe(2); // no duplicates

    s.simulateAbort();
  });

  it("emits a heartbeat comment on an idle stream", async () => {
    const s = new FakeStream();
    running = runSseStream(s.asStream(), {
      store,
      bus,
      namespace: NS,
      sessionId,
      cursor: 0,
      heartbeatMs: 40,
    });

    await waitFor(() => s.raw.includes(":hb\n\n"));
    expect(s.raw).toContain(":hb\n\n");
    expect(s.frames).toHaveLength(0); // no data frames on an idle stream

    s.simulateAbort();
  });

  it("removes its subscription on client disconnect (no leak)", async () => {
    const s = new FakeStream();
    running = runSseStream(s.asStream(), { store, bus, namespace: NS, sessionId, cursor: 0 });

    await waitFor(() => bus.subscriberCount() === 1);
    s.simulateAbort();
    await waitFor(() => bus.subscriberCount() === 0);
    expect(bus.subscriberCount()).toBe(0);
  });
});
