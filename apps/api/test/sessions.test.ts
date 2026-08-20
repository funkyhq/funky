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
  new URL("../../../packages/adapters/migrations/0000_init.sql", import.meta.url),
  "utf8",
);

let client: PGlite;
let app: ReturnType<typeof buildApp>;
let scoped: ReturnType<typeof buildApp>; // namespaceSource "header" over the SAME store

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  app = buildApp({ store, authToken: null, namespaceSource: "static", ping: async () => ({}) });
  scoped = buildApp({ store, authToken: null, namespaceSource: "header", ping: async () => ({}) });
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
