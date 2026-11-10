// The usage webhook end to end against a real HTTP server on localhost:
// the HTTP UsageSink's request (body, Idempotency-Key, a signature a
// receiver can verify with nothing but the secret), what counts as
// accepted, and — over the pg store on PGlite — the outbox it drains:
// a refused delivery is retried, and events a worker committed but never
// sent are delivered by the next worker's sweep.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_NAMESPACE, type UsageEvent, type UserMessage } from "@funky/core";
import { createUsageDelivery, type Store, USAGE_HANDOFF_MS } from "@funky/agent";
import { createHttpUsageSink, createPgStore, signUsageBody, type StoreDb } from "../src";
import { migrateStore } from "./migrate-store";

const SECRET = "whsec-test-0123456789";

interface Received {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A receiver on an ephemeral port. `answer` picks each reply: a status,
 *  or "hang" to never respond. */
async function receiver(answer: (n: number) => number | "hang" = () => 200) {
  const received: Received[] = [];
  const hung: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const reply = answer(received.length);
      if (reply === "hang") return void hung.push(res);
      if (reply >= 300 && reply < 400) res.setHeader("location", "/moved");
      res.writeHead(reply).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push({ server, hung });
  return { url: `http://127.0.0.1:${port}/usage`, received };
}

const servers: Array<{ server: Server; hung: ServerResponse[] }> = [];
afterEach(async () => {
  for (const { server, hung } of servers.splice(0)) {
    for (const res of hung) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const event: UsageEvent = {
  namespace: "acme",
  sessionId: "s1",
  eventId: "evt_1",
  kind: "tokens",
  entryId: "entry_1",
  provider: "anthropic",
  model: "claude-opus-5",
  usage: { input: 1200, output: 80, cacheRead: 1000, cacheWrite: 0, reasoning: 12 },
  createdAt: "2026-11-10T00:00:00.000Z",
};

/** What a receiver does, written from the header format alone. */
function verify(header: string, body: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

describe("HTTP usage sink", () => {
  it("POSTs the event as JSON, keyed by its id and signed with the secret", async () => {
    const { url, received } = await receiver(() => 202);
    const sink = createHttpUsageSink({
      url,
      secret: SECRET,
      now: () => new Date("2026-11-10T00:00:05.900Z"),
    });
    await sink.send(event);

    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req!.path).toBe("/usage");
    expect(JSON.parse(req!.body)).toEqual(event);
    expect(req!.headers["content-type"]).toBe("application/json");
    expect(req!.headers["idempotency-key"]).toBe("evt_1");
    const signature = String(req!.headers["funky-signature"]);
    expect(signature).toMatch(/^t=1794268805,v1=[0-9a-f]{64}$/);
    expect(verify(signature, req!.body, SECRET)).toBe(true);
    expect(verify(signature, req!.body, "another-secret")).toBe(false);
    expect(verify(signature, req!.body.replace("1200", "1"), SECRET)).toBe(false);
    expect(signature).toBe(signUsageBody(SECRET, 1794268805, req!.body));
  });

  it("rejects an error status", async () => {
    const { url } = await receiver(() => 500);
    await expect(createHttpUsageSink({ url, secret: SECRET }).send(event)).rejects.toThrow(
      "usage webhook answered 500 for event evt_1",
    );
  });

  it("rejects a redirect without following it", async () => {
    const { url, received } = await receiver(() => 307);
    await expect(createHttpUsageSink({ url, secret: SECRET }).send(event)).rejects.toThrow();
    expect(received.map((r) => r.path)).toEqual(["/usage"]);
  });

  it("rejects a receiver that doesn't answer within the timeout", async () => {
    const { url } = await receiver(() => "hang");
    await expect(
      createHttpUsageSink({ url, secret: SECRET, timeoutMs: 50 }).send(event),
    ).rejects.toThrow();
  });

  it("rejects when the caller aborts", async () => {
    const { url } = await receiver(() => "hang");
    const stop = new AbortController();
    const sending = createHttpUsageSink({ url, secret: SECRET }).send(event, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(sending).rejects.toThrow();
  });
});

describe("usage delivery over the pg store", () => {
  let client: PGlite;
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);

  beforeAll(async () => {
    client = new PGlite();
    await migrateStore(client);
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  /** A worker's view of the database: a fresh store over it. */
  const worker = (): Store => createPgStore(drizzle({ client }) as unknown as StoreDb, { now });

  const user = (text: string): UserMessage => ({ role: "user", content: [{ type: "text", text }] });

  /** One committed run whose reply carries usage; the commit's events:
   *  the reply's tokens, then the closed item's runtime. */
  async function commitWithUsage(store: Store): Promise<UsageEvent[]> {
    const agent = await store.createAgentConfig({
      namespace: DEFAULT_NAMESPACE,
      inference: { provider: "anthropic", model: "claude-opus-5" },
      systemPrompt: "s",
      network: { type: "unrestricted" },
      packages: {},
      credentials: [],
      setupCommands: [],
      resources: {},
    });
    const session = await store.createSession({
      namespace: DEFAULT_NAMESPACE,
      agentConfigId: agent.agentConfigId,
    });
    await store.intake(session, user("go"));
    const claim = await store.claimItem({ leaseMs: 60_000, session });
    const committed = await store.commitStep({
      itemRef: claim!.item,
      token: claim!.token,
      append: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-opus-5",
          stopReason: "end_turn",
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      next: { kind: "end_run", status: "completed" },
    });
    return committed.usage;
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("until: timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("retries a refused event after its backoff, under the same idempotency key", async () => {
    await client.exec("TRUNCATE agent_configs, sessions, usage_events CASCADE");
    const { url, received } = await receiver((n) => (n === 1 ? 503 : 200));
    const store = worker();
    const delivery = createUsageDelivery(store, createHttpUsageSink({ url, secret: SECRET }), {
      now,
      retryMs: 30_000,
      pollMs: 5,
    });

    const events = await commitWithUsage(store);
    // Tokens refused: deferred 30s. The delivery stops there — the
    // receiver is likely down — so the runtime event waits for the sweep.
    await delivery.deliver(events);
    expect(received).toHaveLength(1);

    const stop = new AbortController();
    const sweeping = delivery.sweep(stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(1); // not due yet
    offsetMs += 30_000;
    await until(() => received.length === 2);
    offsetMs += USAGE_HANDOFF_MS + 60 * 60_000;
    await until(() => received.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    await sweeping;

    // Delivered once accepted: never sent again, however long the sweep runs.
    expect(received).toHaveLength(3);
    expect(received.map((r) => r.headers["idempotency-key"])).toEqual([
      events[0]!.eventId,
      events[0]!.eventId,
      events[1]!.eventId,
    ]);
    expect(await store.claimUsage({ limit: 10, leaseMs: 60_000 })).toEqual([]);
  });

  it("delivers what a worker committed but never sent, from the next worker's sweep", async () => {
    await client.exec("TRUNCATE agent_configs, sessions, usage_events CASCADE");
    const { url, received } = await receiver();

    // The first worker commits, then dies before its delivery runs.
    const events = await commitWithUsage(worker());

    // The restarted worker sweeps on boot: the event is still the dead
    // committer's for the handoff, then it is due and goes out.
    const store = worker();
    const stop = new AbortController();
    const sweeping = createUsageDelivery(store, createHttpUsageSink({ url, secret: SECRET }), {
      now,
      pollMs: 5,
    }).sweep(stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(0);
    offsetMs += USAGE_HANDOFF_MS;
    await until(() => received.length === 2);
    stop.abort();
    await sweeping;

    // Both kinds ride the same outbox and the same signed POST.
    const bodies = received.map((r) => JSON.parse(r.body) as UsageEvent);
    expect(bodies.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([events[1], events[0]]);
    expect(events.map((e) => e.kind)).toEqual(["tokens", "runtime"]);
    expect(await store.claimUsage({ limit: 10, leaseMs: 60_000 })).toEqual([]);
  });
});
