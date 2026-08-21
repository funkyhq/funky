// Route tests over the REAL store — PGlite + the pg adapter. The
// worker is deliberately absent: what these pin is the intake half
// (create, started/queued branching, cancel-as-control-entry) and the
// inspection reads, all through HTTP, plus the ownership boundary.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStore, type StoreDb } from "@funky/adapters";
import { buildApp } from "../src/app";
import { get, post } from "./helpers";

const ddl = readFileSync(
  new URL(
    "../../../packages/adapters/migrations/20260820000000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

let client: PGlite;
let app: ReturnType<typeof buildApp>;
let scoped: ReturnType<typeof buildApp>; // namespaceSource "header" over the SAME store
let heartbeatApp: ReturnType<typeof buildApp>; // heartbeat fires within a test's patience

// Fast enough that stream tests never wait on the poll; a heartbeat
// would mark the test hung, so it is effectively off everywhere but
// heartbeatApp.
const PACING = { pollMs: 10, heartbeatMs: 60_000 };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  const base = { store, authToken: null, ping: async () => ({}) };
  app = buildApp({ ...base, namespaceSource: "static", stream: PACING });
  scoped = buildApp({ ...base, namespaceSource: "header", stream: PACING });
  heartbeatApp = buildApp({
    ...base,
    namespaceSource: "static",
    stream: { pollMs: 10, heartbeatMs: 25 },
  });
});

afterAll(async () => {
  await client.close();
});

const asTenant = (tenant: string) => ({ "X-Funky-Namespace": tenant });

/** Seed the two configs over HTTP; returns their ids. */
async function seedConfigs(
  on: ReturnType<typeof buildApp>,
  headers: Record<string, string> = {},
): Promise<{ agentConfigId: string; envConfigId: string }> {
  const agent = await (
    await post(
      on,
      "/v1/agent-configs",
      { inference: { provider: "fake", model: "m" }, systemPrompt: "s" },
      headers,
    )
  ).json();
  const env = await (await post(on, "/v1/env-configs", {}, headers)).json();
  return { agentConfigId: agent.id, envConfigId: env.id };
}

async function seedSession(
  on: ReturnType<typeof buildApp>,
  headers: Record<string, string> = {},
): Promise<string> {
  const configs = await seedConfigs(on, headers);
  const res = await post(on, "/v1/sessions", configs, headers);
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

describe("POST /v1/sessions", () => {
  it("creates and returns the materialized session, 201", async () => {
    const configs = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", configs);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentConfigId).toBe(configs.agentConfigId);
    expect(body.envConfigId).toBe(configs.envConfigId);
    expect(body.namespace).toBe("default");
    expect(typeof body.id).toBe("string");
  });

  it("400s a dangling config reference", async () => {
    const { envConfigId } = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", { agentConfigId: "nope", envConfigId });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("400s a foreign-namespace config identically to a dangling one", async () => {
    const configs = await seedConfigs(scoped, asTenant("tenant-a"));
    const res = await post(scoped, "/v1/sessions", configs, asTenant("tenant-b"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/^unknown /);
  });
});

describe("GET /v1/sessions/:id", () => {
  it("404s unknown and foreign sessions alike", async () => {
    expect((await get(app, "/v1/sessions/nope")).status).toBe(404);

    const sessionId = await seedSession(scoped, asTenant("tenant-a"));
    expect((await get(scoped, `/v1/sessions/${sessionId}`, asTenant("tenant-b"))).status).toBe(404);
    expect((await get(scoped, `/v1/sessions/${sessionId}`, asTenant("tenant-a"))).status).toBe(200);
  });
});

describe("POST /v1/sessions/:id/messages", () => {
  it("starts a run on an idle session, queues while one is active", async () => {
    const sessionId = await seedSession(app);

    const first = await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });
    expect(first.status).toBe(202);
    const started = await first.json();
    expect(started.kind).toBe("started");
    expect(typeof started.itemId).toBe("string");

    // The open item bars a second run: the message parks as pending input.
    const second = await post(app, `/v1/sessions/${sessionId}/messages`, {
      content: [{ type: "text", text: "also this" }],
    });
    expect(second.status).toBe(202);
    const queued = await second.json();
    expect(queued.kind).toBe("queued");
    expect(typeof queued.inputId).toBe("string");
  });

  it("normalizes a plain string into text content", async () => {
    const sessionId = await seedSession(app);
    await post(app, `/v1/sessions/${sessionId}/messages`, { content: "plain" });
    const entries = await (await get(app, `/v1/sessions/${sessionId}/entries`)).json();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toEqual({
      role: "user",
      content: [{ type: "text", text: "plain" }],
    });
  });

  it("404s an unknown session", async () => {
    const res = await post(app, "/v1/sessions/nope/messages", { content: "hi" });
    expect(res.status).toBe(404);
  });
});

describe("inspection", () => {
  it("entries?after= is a seq cursor", async () => {
    const sessionId = await seedSession(app);
    await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });

    const all = await (await get(app, `/v1/sessions/${sessionId}/entries`)).json();
    expect(all).toHaveLength(1);
    const afterTail = await (
      await get(app, `/v1/sessions/${sessionId}/entries?after=${all[0].seq}`)
    ).json();
    expect(afterTail).toHaveLength(0);
  });

  it("items shows the started run's ready inference item", async () => {
    const sessionId = await seedSession(app);
    const started = await (
      await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" })
    ).json();

    const items = await (await get(app, `/v1/sessions/${sessionId}/items`)).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: started.itemId, type: "inference", status: "ready" });
  });
});

describe("POST /v1/sessions/:id/cancel", () => {
  it("accepts and appends a control entry", async () => {
    const sessionId = await seedSession(app);
    await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });

    const res = await post(app, `/v1/sessions/${sessionId}/cancel`);
    expect(res.status).toBe(202);

    const entries = await (await get(app, `/v1/sessions/${sessionId}/entries`)).json();
    expect(entries[entries.length - 1].type).toBe("control");
  });

  it("404s a foreign session", async () => {
    const sessionId = await seedSession(scoped, asTenant("tenant-a"));
    const res = await post(
      scoped,
      `/v1/sessions/${sessionId}/cancel`,
      undefined,
      asTenant("tenant-b"),
    );
    expect(res.status).toBe(404);
  });
});

/** Incremental SSE consumer over a fetch Response. Always cancel() —
 *  the server loop only stops when the client hangs up. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextFrame = async (): Promise<string> => {
    while (true) {
      const cut = buffer.indexOf("\n\n");
      if (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        return frame;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before an event arrived");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    /** raw frame, comments included */
    nextFrame,
    /** next data event, comments skipped */
    async next(): Promise<{ id?: string; data: string }> {
      while (true) {
        const event: { id?: string; data: string } = { data: "" };
        for (const line of (await nextFrame()).split("\n")) {
          if (line.startsWith("id:")) event.id = line.slice(3).trim();
          else if (line.startsWith("data:")) event.data += line.slice(5).trim();
        }
        if (event.data !== "") return event;
      }
    },
    cancel: () => reader.cancel(),
  };
}

describe("GET /v1/sessions/:id/stream", () => {
  it("replays committed entries, then tails ones landing while open", async () => {
    const sessionId = await seedSession(app);
    await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });
    const expected = await (await get(app, `/v1/sessions/${sessionId}/entries`)).json();

    const res = await get(app, `/v1/sessions/${sessionId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseReader(res);
    try {
      const replayed = await reader.next();
      expect(replayed.id).toBe(String(expected[0].seq));
      expect(JSON.parse(replayed.data)).toEqual(expected[0]);

      // Cancel is the one entry writer these worker-less tests have; its
      // control entry landing mid-stream is the live-tail proof.
      await post(app, `/v1/sessions/${sessionId}/cancel`);
      const tailed = await reader.next();
      expect(JSON.parse(tailed.data).type).toBe("control");
      expect(Number(tailed.id)).toBeGreaterThan(expected[0].seq);
    } finally {
      await reader.cancel();
    }
  });

  it("resumes from ?after=, and Last-Event-ID wins over it", async () => {
    // Three entries: the message, then two cancels (re-cancelling is legal).
    const sessionId = await seedSession(app);
    await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });
    await post(app, `/v1/sessions/${sessionId}/cancel`);
    await post(app, `/v1/sessions/${sessionId}/cancel`);
    const entries = await (await get(app, `/v1/sessions/${sessionId}/entries`)).json();
    expect(entries).toHaveLength(3);

    // ?after= alone would skip everything; the header rewinds to the
    // first entry and must win: the stream resumes at the second.
    const res = await get(app, `/v1/sessions/${sessionId}/stream?after=${entries[2].seq}`, {
      "Last-Event-ID": String(entries[0].seq),
    });
    const reader = sseReader(res);
    try {
      expect((await reader.next()).id).toBe(String(entries[1].seq));
    } finally {
      await reader.cancel();
    }
  });

  it("400s a malformed Last-Event-ID", async () => {
    const sessionId = await seedSession(app);
    const res = await get(app, `/v1/sessions/${sessionId}/stream`, { "Last-Event-ID": "abc" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("404s a foreign session before any byte streams", async () => {
    const sessionId = await seedSession(scoped, asTenant("tenant-a"));
    const res = await get(scoped, `/v1/sessions/${sessionId}/stream`, asTenant("tenant-b"));
    expect(res.status).toBe(404);
  });

  it("keeps a quiet stream alive with heartbeat comments", async () => {
    // No entries at all: nothing will ever be emitted but the heartbeat.
    const sessionId = await seedSession(heartbeatApp);
    const res = await get(heartbeatApp, `/v1/sessions/${sessionId}/stream`);
    const reader = sseReader(res);
    try {
      let frame = "";
      while (!frame.includes(": ping")) frame = await reader.nextFrame();
      expect(frame).toContain(": ping");
    } finally {
      await reader.cancel();
    }
  });
});
