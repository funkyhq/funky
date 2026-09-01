// Route tests over the REAL store — PGlite + the pg adapter. The
// worker is deliberately absent: what these pin is the intake half
// (create, started/queued branching, cancel-as-control-entry) and the
// inspection reads, all through HTTP, plus the ownership boundary.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStore, type StoreDb } from "@funky/adapters";
import { storeDdl } from "../../../packages/adapters/test/store-ddl";
import { buildApp } from "../src/app";
import { get, post } from "./helpers";

let client: PGlite;
let app: ReturnType<typeof buildApp>;
let heartbeatApp: ReturnType<typeof buildApp>; // heartbeat fires within a test's patience

// Fast enough that stream tests never wait on the poll; a heartbeat
// would mark the test hung, so it is effectively off everywhere but
// heartbeatApp.
const PACING = { pollMs: 10, heartbeatMs: 60_000 };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(storeDdl);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  const base = { store, authToken: null, ping: async () => ({}) };
  app = buildApp({ ...base, stream: PACING });
  heartbeatApp = buildApp({ ...base, stream: { pollMs: 10, heartbeatMs: 25 } });
});

afterAll(async () => {
  await client.close();
});

/** Seed the two configs over HTTP; returns their ids. Namespace is part
 *  of the request: it rides in the create bodies. */
async function seedConfigs(
  on: ReturnType<typeof buildApp>,
  namespace = "default",
): Promise<{ agentConfigId: string; envConfigId: string }> {
  const agent = await (
    await post(on, "/v1/agent-configs", {
      namespace,
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
    })
  ).json();
  const env = await (await post(on, "/v1/env-configs", { namespace })).json();
  return { agentConfigId: agent.id, envConfigId: env.id };
}

async function seedSession(
  on: ReturnType<typeof buildApp>,
  namespace = "default",
): Promise<string> {
  const configs = await seedConfigs(on, namespace);
  const res = await post(on, "/v1/sessions", { namespace, ...configs });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

describe("POST /v1/sessions", () => {
  it("creates and returns the materialized session, 201", async () => {
    const configs = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", {
      namespace: "default",
      ...configs,
      agentConfigVersion: 1,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agentConfigId).toBe(configs.agentConfigId);
    expect(body.agentConfigVersion).toBe(1);
    expect(body.envConfigId).toBe(configs.envConfigId);
    expect(body.namespace).toBe("default");
    expect(typeof body.id).toBe("string");
    // The recipe rides along resolved: the wire shows the world this
    // session will provision, not a pointer to a row that can change.
    expect(body.envConfigSnapshot).toEqual({
      network: { type: "unrestricted" },
      packages: {},
    });
  });

  it("returns the snapshot the session was created with, not the env config's current state", async () => {
    const agent = await (
      await post(app, "/v1/agent-configs", {
        inference: { provider: "fake", model: "m" },
        systemPrompt: "s",
      })
    ).json();
    const env = await (await post(app, "/v1/env-configs", { network: { type: "none" } })).json();
    const created = await (
      await post(app, "/v1/sessions", { agentConfigId: agent.id, envConfigId: env.id })
    ).json();

    const updated = await post(app, `/v1/env-configs/${env.id}`, {
      network: { type: "allowlist", domains: ["example.com"] },
    });
    expect(updated.status).toBe(200);

    const read = await (await get(app, `/v1/sessions/${created.id}`)).json();
    expect(read.envConfigSnapshot.network).toEqual({ type: "none" });
    expect(read.envConfigId).toBe(env.id); // provenance survives the edit
  });

  it("defaults the namespace when the body omits it", async () => {
    const configs = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", configs);
    expect(res.status).toBe(201);
    expect((await res.json()).namespace).toBe("default");
  });

  it("400s a dangling config reference", async () => {
    const { envConfigId } = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", {
      namespace: "default",
      agentConfigId: "nope",
      envConfigId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("400s an unknown agent config version", async () => {
    const configs = await seedConfigs(app);
    const res = await post(app, "/v1/sessions", {
      namespace: "default",
      ...configs,
      agentConfigVersion: 2,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("409s an archived agent config, while sessions already on it keep working", async () => {
    const configs = await seedConfigs(app);
    const create = { namespace: "default", ...configs };
    const sessionId = (await (await post(app, "/v1/sessions", create)).json()).id;
    expect((await post(app, `/v1/agent-configs/${configs.agentConfigId}/archive`)).status).toBe(
      200,
    );

    const res = await post(app, "/v1/sessions", create);
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("conflict_error");

    // Existing sessions continue: the archive closes the door to new ones.
    const message = await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });
    expect(message.status).toBe(202);
    expect((await message.json()).kind).toBe("started");
  });

  it("409s an archived env config, while sessions with its snapshot keep working", async () => {
    const configs = await seedConfigs(app);
    const create = { namespace: "default", ...configs };
    const sessionId = (await (await post(app, "/v1/sessions", create)).json()).id;
    expect((await post(app, `/v1/env-configs/${configs.envConfigId}/archive`)).status).toBe(200);

    const res = await post(app, "/v1/sessions", create);
    expect(res.status).toBe(409);
    const error = (await res.json()).error;
    expect(error.type).toBe("conflict_error");
    expect(error.message).toBe(`env config default/${configs.envConfigId} is archived`);

    const message = await post(app, `/v1/sessions/${sessionId}/messages`, { content: "hi" });
    expect(message.status).toBe(202);
    expect((await message.json()).kind).toBe("started");
  });

  it("400s a foreign-namespace config identically to a dangling one", async () => {
    const configs = await seedConfigs(app, "tenant-a");
    const res = await post(app, "/v1/sessions", { namespace: "tenant-b", ...configs });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/^unknown /);
  });
});

describe("GET /v1/sessions", () => {
  // Every list test gets its own tenant, so the page it reads contains
  // exactly the rows it created — the store's namespace scoping IS the
  // isolation. Order is asserted against the list itself, never against
  // creation order: the store's clock is real wall time here, so rows
  // created back to back can share a timestamp. That the order is
  // newest-first is pinned in the store conformance suite, which owns
  // an injected clock.
  async function seed(tenant: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await seedSession(app, tenant));
    return ids;
  }

  it("returns the namespace's rows in one page, whole rows, hasMore false", async () => {
    const ids = await seed("list-one", 3);
    const res = await get(app, "/v1/sessions?namespace=list-one");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((s: { id: string }) => s.id).sort()).toEqual([...ids].sort());
    expect(body.hasMore).toBe(false);
    expect(body.lastId).toBe(body.data[2].id);
    // A listed row is the same row a get returns.
    const one = await get(app, `/v1/sessions/${ids[0]}?namespace=list-one`);
    expect(body.data).toContainEqual(await one.json());
  });

  it("pages with limit and after: the walk equals the whole list", async () => {
    await seed("list-page", 3);
    const whole = await (await get(app, "/v1/sessions?namespace=list-page")).json();

    const first = await (await get(app, "/v1/sessions?namespace=list-page&limit=2")).json();
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true); // the over-fetched row, not a guess
    expect(first.lastId).toBe(first.data[1].id);

    const second = await (
      await get(app, `/v1/sessions?namespace=list-page&limit=2&after=${first.lastId}`)
    ).json();
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    expect([...first.data, ...second.data]).toEqual(whole.data);
  });

  it("answers an empty namespace with an empty page and no cursor", async () => {
    const body = await (await get(app, "/v1/sessions?namespace=list-empty")).json();
    expect(body).toEqual({ data: [], hasMore: false });
  });

  it("never crosses the namespace boundary", async () => {
    const mine = await seed("list-mine", 2);
    await seed("list-theirs", 1);
    const body = await (await get(app, "/v1/sessions?namespace=list-mine")).json();
    expect(body.data.map((s: { id: string }) => s.id).sort()).toEqual([...mine].sort());
  });

  // The switch is an enum, not z.coerce.boolean(): JS truthiness would read
  // the string "false" as true, so this is the case that pins it.
  it("treats include_archived=false as the default, not as truthy", async () => {
    const [archived, active] = await seed("list-false", 2);
    expect((await post(app, `/v1/sessions/${archived}/archive?namespace=list-false`)).status).toBe(
      200,
    );

    for (const q of ["", "&include_archived=false"]) {
      const body = await (await get(app, `/v1/sessions?namespace=list-false${q}`)).json();
      expect(body.data.map((s: { id: string }) => s.id)).toEqual([active]);
    }
  });

  it("400s a limit outside the bounds and a non-numeric one", async () => {
    for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5"]) {
      const res = await get(app, `/v1/sessions?namespace=list-one&${q}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("400s an include_archived that is neither spelling", async () => {
    for (const q of ["include_archived=1", "include_archived=yes", "include_archived=TRUE"]) {
      const res = await get(app, `/v1/sessions?namespace=list-one&${q}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("400s a cursor the store can't resolve — foreign like made-up", async () => {
    const [foreign] = await seed("list-cursor-b", 1);
    for (const after of ["nope", foreign]) {
      const res = await get(app, `/v1/sessions?namespace=list-cursor-a&after=${after}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });
});

describe("GET /v1/sessions/:id", () => {
  it("404s unknown and foreign sessions alike", async () => {
    expect((await get(app, "/v1/sessions/nope")).status).toBe(404);

    const sessionId = await seedSession(app, "tenant-a");
    expect((await get(app, `/v1/sessions/${sessionId}?namespace=tenant-b`)).status).toBe(404);
    expect((await get(app, `/v1/sessions/${sessionId}?namespace=tenant-a`)).status).toBe(200);
  });
});

describe("POST /v1/sessions/:id/archive", () => {
  it("archives an idle session, keeps it readable, and closes client writes", async () => {
    const namespace = "archive-idle";
    const sessionId = await seedSession(app, namespace);

    const res = await post(app, `/v1/sessions/${sessionId}/archive?namespace=${namespace}`);
    expect(res.status).toBe(200);
    const archived = await res.json();
    expect(archived).toMatchObject({
      id: sessionId,
      namespace,
      archivedAt: expect.any(String),
    });

    const read = await get(app, `/v1/sessions/${sessionId}?namespace=${namespace}`);
    expect(await read.json()).toEqual(archived);

    const message = await post(app, `/v1/sessions/${sessionId}/messages?namespace=${namespace}`, {
      content: "too late",
    });
    expect(message.status).toBe(409);
    expect((await message.json()).error.message).toBe(
      `session ${namespace}/${sessionId} is archived`,
    );
    expect(
      (await post(app, `/v1/sessions/${sessionId}/cancel?namespace=${namespace}`)).status,
    ).toBe(409);
  });

  it("is idempotent and preserves the first archivedAt", async () => {
    const namespace = "archive-repeat";
    const sessionId = await seedSession(app, namespace);
    const path = `/v1/sessions/${sessionId}/archive?namespace=${namespace}`;

    const first = await (await post(app, path)).json();
    const second = await post(app, path);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
  });

  it("409s while the session has an active run", async () => {
    const namespace = "archive-running";
    const sessionId = await seedSession(app, namespace);
    await post(app, `/v1/sessions/${sessionId}/messages?namespace=${namespace}`, {
      content: "start",
    });

    const res = await post(app, `/v1/sessions/${sessionId}/archive?namespace=${namespace}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      type: "conflict_error",
      message: `session ${namespace}/${sessionId} is not idle`,
    });
    const session = await (
      await get(app, `/v1/sessions/${sessionId}?namespace=${namespace}`)
    ).json();
    expect("archivedAt" in session).toBe(false);
  });

  it("drops archived sessions from the default list and includes them explicitly", async () => {
    const namespace = "archive-list";
    const archivedId = await seedSession(app, namespace);
    const activeId = await seedSession(app, namespace);
    await post(app, `/v1/sessions/${archivedId}/archive?namespace=${namespace}`);

    const active = await (await get(app, `/v1/sessions?namespace=${namespace}`)).json();
    expect(active.data.map((session: { id: string }) => session.id)).toEqual([activeId]);

    const all = await (
      await get(app, `/v1/sessions?namespace=${namespace}&include_archived=true`)
    ).json();
    expect(all.data.map((session: { id: string }) => session.id).sort()).toEqual(
      [archivedId, activeId].sort(),
    );
    expect(all.data.find((session: { id: string }) => session.id === archivedId)).toMatchObject({
      archivedAt: expect.any(String),
    });
  });

  it("404s unknown and foreign archive targets without touching the owned row", async () => {
    expect((await post(app, "/v1/sessions/nope/archive?namespace=archive-a")).status).toBe(404);

    const sessionId = await seedSession(app, "archive-a");
    expect((await post(app, `/v1/sessions/${sessionId}/archive?namespace=archive-b`)).status).toBe(
      404,
    );
    const own = await (await get(app, `/v1/sessions/${sessionId}?namespace=archive-a`)).json();
    expect("archivedAt" in own).toBe(false);
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
    const sessionId = await seedSession(app, "tenant-a");
    const res = await post(app, `/v1/sessions/${sessionId}/cancel?namespace=tenant-b`);
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
    const sessionId = await seedSession(app, "tenant-a");
    const res = await get(app, `/v1/sessions/${sessionId}/stream?namespace=tenant-b`);
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
