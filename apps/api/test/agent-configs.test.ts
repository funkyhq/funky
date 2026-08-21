// Route tests over the REAL store — PGlite + the pg adapter — same
// pattern as env-configs.test.ts. The middleware machinery (auth,
// header source validation) is covered there and in app.test.ts; here
// we pin this resource's wiring, materialization, and its own
// fetch-then-check scoping.
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

const RECIPE = {
  inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
  systemPrompt: "You are a data analyst.",
};

let client: PGlite;
let app: ReturnType<typeof buildApp>;
let scoped: ReturnType<typeof buildApp>; // namespaceSource "header" over the SAME store

beforeAll(async () => {
  client = new PGlite();
  await client.exec(ddl);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  const base = { store, authToken: null, ping: async () => ({}) };
  const stream = { pollMs: 1000, heartbeatMs: 15_000 };
  app = buildApp({ ...base, namespaceSource: "static", stream });
  scoped = buildApp({ ...base, namespaceSource: "header", stream });
});

afterAll(async () => {
  await client.close();
});

describe("POST /v1/agent-configs", () => {
  it("creates and returns the stored row, 201", async () => {
    const res = await post(app, "/v1/agent-configs", RECIPE);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.inference).toEqual(RECIPE.inference);
    expect(body.systemPrompt).toBe(RECIPE.systemPrompt);
    expect(body.namespace).toBe("default");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");

    const fetched = await get(app, `/v1/agent-configs/${body.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
  });

  it("rejects a bare-string inference config, 400", async () => {
    const res = await post(app, "/v1/agent-configs", {
      inference: "claude-sonnet-5",
      systemPrompt: "s",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("rejects a missing system prompt, 400", async () => {
    const res = await post(app, "/v1/agent-configs", { inference: RECIPE.inference });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/agent-configs/:id", () => {
  it("404s an unknown id with the error envelope", async () => {
    const res = await get(app, "/v1/agent-configs/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe("not_found_error");
  });

  it("scopes by namespace: a foreign row 404s exactly like a nonexistent one", async () => {
    const asTenant = (tenant: string) => ({ "X-Funky-Namespace": tenant });
    const created = await (
      await post(scoped, "/v1/agent-configs", RECIPE, asTenant("tenant-a"))
    ).json();
    expect(created.namespace).toBe("tenant-a");

    const foreign = await get(scoped, `/v1/agent-configs/${created.id}`, asTenant("tenant-b"));
    expect(foreign.status).toBe(404);

    const own = await get(scoped, `/v1/agent-configs/${created.id}`, asTenant("tenant-a"));
    expect(own.status).toBe(200);
  });
});
