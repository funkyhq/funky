// Route tests over the REAL store — PGlite + the pg adapter, as in
// sessions.test.ts. The worker is absent: what these pin is the create
// (one call → a session with a started run), the read, the cancel
// forwarded to the session, and the ownership boundary.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStore, type StoreDb } from "@funky/adapters";
import type { Store } from "@funky/agent";
import { migrateStore } from "../../../packages/adapters/test/migrate-store";
import { buildApp } from "../src/app";
import { get, post } from "./helpers";

let client: PGlite;
let store: Store;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  client = new PGlite();
  await migrateStore(client);
  store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  app = buildApp({ store, secrets: null, authToken: null, ping: async () => ({}) });
});

afterAll(async () => {
  await client.close();
});

/** Seed an agent config over HTTP; returns its id. */
async function seedConfig(namespace = "default"): Promise<string> {
  const res = await post(app, "/v1/agent-configs", {
    namespace,
    inference: { provider: "fake", model: "m" },
    systemPrompt: "s",
    network: { type: "unrestricted" },
    packages: {},
    credentials: [],
    setupCommands: [],
  });
  return (await res.json()).id;
}

/** Create a task over HTTP; returns the wire task. */
async function seedTask(namespace = "default", content: unknown = "do the thing") {
  const agentConfigId = await seedConfig(namespace);
  const res = await post(app, "/v1/tasks", { namespace, agentConfigId, content });
  expect(res.status).toBe(201);
  return res.json();
}

describe("POST /v1/tasks", () => {
  it("creates the task and starts its session's run, 201", async () => {
    const agentConfigId = await seedConfig();
    const res = await post(app, "/v1/tasks", {
      namespace: "default",
      agentConfigId,
      content: [{ type: "text", text: "summarize the report" }],
      metadata: { ticket: 42 },
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task).toEqual({
      id: expect.any(String),
      namespace: "default",
      agentConfigId,
      agentConfigVersion: 1,
      content: [{ type: "text", text: "summarize the report" }],
      metadata: { ticket: 42 },
      sessionId: expect.any(String),
      createdAt: expect.any(String),
    });

    // The session is an ordinary one, already running the task.
    const session = await (await get(app, `/v1/sessions/${task.sessionId}`)).json();
    expect(session).toMatchObject({ agentConfigId, agentConfigVersion: 1 });
    expect(session).not.toHaveProperty("metadata");
    const entries = await (await get(app, `/v1/sessions/${task.sessionId}/entries`)).json();
    expect(entries).toEqual([
      expect.objectContaining({
        seq: 0,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "summarize the report" }] },
      }),
    ]);
    const items = await (await get(app, `/v1/sessions/${task.sessionId}/items`)).json();
    expect(items).toEqual([expect.objectContaining({ type: "inference", status: "ready" })]);
  });

  it("normalizes a plain string into text content", async () => {
    const task = await seedTask("default", "plain");
    expect(task.content).toEqual([{ type: "text", text: "plain" }]);
  });

  it("defaults the namespace when the body omits it", async () => {
    const agentConfigId = await seedConfig();
    const res = await post(app, "/v1/tasks", { agentConfigId, content: "go" });
    expect(res.status).toBe(201);
    expect((await res.json()).namespace).toBe("default");
  });

  it("pins an explicitly requested agent config version", async () => {
    const agentConfigId = await seedConfig();
    await post(app, `/v1/agent-configs/${agentConfigId}`, { systemPrompt: "v2" });
    const res = await post(app, "/v1/tasks", {
      agentConfigId,
      agentConfigVersion: 1,
      content: "go",
    });
    expect((await res.json()).agentConfigVersion).toBe(1);
  });

  it("lets the session take follow-up messages", async () => {
    const task = await seedTask();
    const res = await post(app, `/v1/sessions/${task.sessionId}/messages`, {
      content: "and also this",
    });
    expect(res.status).toBe(202);
    expect((await res.json()).kind).toBe("queued");
  });

  it("400s a dangling config, an unknown version, and a foreign-namespace config alike", async () => {
    const foreign = await seedConfig("tenant-a");
    const own = await seedConfig();
    for (const body of [
      { agentConfigId: "nope" },
      { agentConfigId: own, agentConfigVersion: 2 },
      { namespace: "tenant-b", agentConfigId: foreign },
    ]) {
      const res = await post(app, "/v1/tasks", { ...body, content: "go" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatchObject({
        type: "invalid_request_error",
        message: expect.stringMatching(/^unknown agent config/),
      });
    }
  });

  it("409s an archived agent config", async () => {
    const agentConfigId = await seedConfig();
    await post(app, `/v1/agent-configs/${agentConfigId}/archive`);
    const res = await post(app, "/v1/tasks", { agentConfigId, content: "go" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("conflict_error");
  });

  it("400s a missing or malformed content", async () => {
    const agentConfigId = await seedConfig();
    for (const content of [undefined, 42, [{ type: "audio" }]]) {
      const res = await post(app, "/v1/tasks", { agentConfigId, content });
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });
});

describe("GET /v1/tasks", () => {
  it("returns the namespace's tasks newest first, whole rows, hasMore false", async () => {
    const older = await seedTask("list-whole", "first");
    const newer = await seedTask("list-whole", "second");
    const res = await get(app, "/v1/tasks?namespace=list-whole");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [newer, older], hasMore: false, lastId: older.id });
  });

  it("pages with limit and after: the walk equals the whole list", async () => {
    for (let i = 0; i < 3; i++) await seedTask("list-walk", `task ${i}`);
    const whole = (await (await get(app, "/v1/tasks?namespace=list-walk")).json()).data;

    const first = await (await get(app, "/v1/tasks?namespace=list-walk&limit=2")).json();
    expect(first.hasMore).toBe(true);
    const second = await (
      await get(app, `/v1/tasks?namespace=list-walk&limit=2&after=${first.lastId}`)
    ).json();
    expect(second.hasMore).toBe(false);
    expect([...first.data, ...second.data]).toEqual(whole);
  });

  it("answers an empty namespace with an empty page and no cursor", async () => {
    const res = await get(app, "/v1/tasks?namespace=list-empty");
    expect(await res.json()).toEqual({ data: [], hasMore: false });
  });

  it("400s a limit outside the bounds and a cursor the store can't resolve", async () => {
    const foreign = await seedTask("list-foreign");
    for (const query of [
      "limit=0",
      "limit=101",
      "after=nope",
      `namespace=list-other&after=${foreign.id}`,
    ]) {
      const res = await get(app, `/v1/tasks?${query}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });
});

describe("GET /v1/tasks/:id", () => {
  it("returns the task as created", async () => {
    const task = await seedTask("tenant-a");
    const res = await get(app, `/v1/tasks/${task.id}?namespace=tenant-a`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(task);
  });

  it("404s unknown and foreign tasks alike", async () => {
    const task = await seedTask("tenant-a");
    for (const path of ["/v1/tasks/nope", `/v1/tasks/${task.id}?namespace=tenant-b`]) {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatchObject({
        type: "not_found_error",
        message: "no such task",
      });
    }
  });
});

describe("POST /v1/tasks/:id/cancel", () => {
  it("accepts and appends a control entry to the task's session", async () => {
    const task = await seedTask();
    const res = await post(app, `/v1/tasks/${task.id}/cancel`);
    expect(res.status).toBe(202);

    const entries = await (await get(app, `/v1/sessions/${task.sessionId}/entries`)).json();
    expect(entries[entries.length - 1].type).toBe("control");
  });

  it("404s unknown and foreign tasks without touching the owned one", async () => {
    const task = await seedTask("tenant-a");
    expect((await post(app, "/v1/tasks/nope/cancel")).status).toBe(404);
    expect((await post(app, `/v1/tasks/${task.id}/cancel?namespace=tenant-b`)).status).toBe(404);

    const entries = await (
      await get(app, `/v1/sessions/${task.sessionId}/entries?namespace=tenant-a`)
    ).json();
    expect(entries).toHaveLength(1);
  });

  it("409s once the task's session is archived", async () => {
    const task = await seedTask("archived-task");
    const sessionRef = { namespace: "archived-task", sessionId: task.sessionId };
    // Finish the run by hand, as a worker would, so the session can be archived.
    const claim = await store.claimItem({ leaseMs: 60_000, session: sessionRef });
    await store.commitStep({
      itemRef: claim!.item,
      token: claim!.token,
      append: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "m",
          stopReason: "end_turn",
        },
      ],
      next: { kind: "end_run", status: "completed" },
    });
    await store.archiveSession(sessionRef);

    const res = await post(app, `/v1/tasks/${task.id}/cancel?namespace=archived-task`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      type: "conflict_error",
      message: `session archived-task/${task.sessionId} is archived`,
    });
  });
});
