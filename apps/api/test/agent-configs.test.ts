// Route tests over the REAL store — PGlite + the pg adapter — same
// pattern as env-configs.test.ts. The middleware machinery (auth) is
// covered in app.test.ts; here we pin this resource's wiring,
// materialization, and its namespace-scoped Store references.
//
// Namespace is part of the request: create bodies carry it, every other
// route takes ?namespace= — and in both spots absence defaults to
// "default" (common.ts NamespaceQuery).
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStore, type StoreDb } from "@funky/adapters";
import { storeDdl } from "../../../packages/adapters/test/store-ddl";
import { buildApp } from "../src/app";
import { get, post } from "./helpers";

const RECIPE = {
  namespace: "default",
  inference: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 8192 },
  systemPrompt: "You are a data analyst.",
};

const recipeFor = (namespace: string) => ({ ...RECIPE, namespace });

let client: PGlite;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(storeDdl);
  const store = createPgStore(drizzle({ client }) as unknown as StoreDb);
  app = buildApp({
    store,
    authToken: null,
    ping: async () => ({}),
    stream: { pollMs: 1000, heartbeatMs: 15_000 },
  });
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
    expect(body.version).toBe(1);
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect(body.updatedAt).toBe(body.createdAt);

    // Reads default ?namespace= to "default" — the self-deploy shape.
    const fetched = await get(app, `/v1/agent-configs/${body.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
  });

  it("uses the namespace supplied in the request", async () => {
    const res = await post(app, "/v1/agent-configs", recipeFor("caller-namespace"));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.namespace).toBe("caller-namespace");
    expect(
      (await get(app, `/v1/agent-configs/${created.id}?namespace=caller-namespace`)).status,
    ).toBe(200);
    // Without the query the read defaults to "default" — a different
    // namespace, so the row is unknown there.
    expect((await get(app, `/v1/agent-configs/${created.id}`)).status).toBe(404);
  });

  it("defaults the namespace when the body omits it", async () => {
    const res = await post(app, "/v1/agent-configs", {
      inference: RECIPE.inference,
      systemPrompt: RECIPE.systemPrompt,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).namespace).toBe("default");
  });

  it("rejects a bare-string inference config, 400", async () => {
    const res = await post(app, "/v1/agent-configs", {
      namespace: "default",
      inference: "claude-sonnet-5",
      systemPrompt: "s",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("rejects a missing system prompt, 400", async () => {
    const res = await post(app, "/v1/agent-configs", {
      namespace: "default",
      inference: RECIPE.inference,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/agent-configs", () => {
  // Every list test gets its own tenant, so the page it reads contains
  // exactly the rows it created — the store's namespace scoping IS the
  // isolation. Order is asserted against the list itself, never against
  // creation order: the store's clock is real wall time here, so rows
  // created back to back can share a timestamp. That the order is
  // newest-first is pinned in the store conformance suite, which owns
  // an injected clock.
  async function seed(tenant: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await post(app, "/v1/agent-configs", recipeFor(tenant));
      expect(res.status).toBe(201);
      ids.push((await res.json()).id);
    }
    return ids;
  }

  it("returns the namespace's rows in one page, whole rows, hasMore false", async () => {
    const ids = await seed("list-one", 3);
    const res = await get(app, "/v1/agent-configs?namespace=list-one");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((c: { id: string }) => c.id).sort()).toEqual([...ids].sort());
    expect(body.hasMore).toBe(false);
    expect(body.lastId).toBe(body.data[2].id);
    // A listed row is the same row a get returns.
    const one = await get(app, `/v1/agent-configs/${ids[0]}?namespace=list-one`);
    expect(body.data).toContainEqual(await one.json());
  });

  it("pages with limit and after: the walk equals the whole list", async () => {
    await seed("list-page", 3);
    const whole = await (await get(app, "/v1/agent-configs?namespace=list-page")).json();

    const first = await (await get(app, "/v1/agent-configs?namespace=list-page&limit=2")).json();
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true); // the over-fetched row, not a guess
    expect(first.lastId).toBe(first.data[1].id);

    const second = await (
      await get(app, `/v1/agent-configs?namespace=list-page&limit=2&after=${first.lastId}`)
    ).json();
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    expect([...first.data, ...second.data]).toEqual(whole.data);
  });

  it("answers an empty namespace with an empty page and no cursor", async () => {
    const body = await (await get(app, "/v1/agent-configs?namespace=list-empty")).json();
    expect(body).toEqual({ data: [], hasMore: false });
  });

  it("never crosses the namespace boundary", async () => {
    const mine = await seed("list-mine", 2);
    await seed("list-theirs", 1);
    const body = await (await get(app, "/v1/agent-configs?namespace=list-mine")).json();
    expect(body.data.map((c: { id: string }) => c.id).sort()).toEqual([...mine].sort());
  });

  it("400s a limit outside the bounds and a non-numeric one", async () => {
    for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5"]) {
      const res = await get(app, `/v1/agent-configs?namespace=list-one&${q}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("400s a cursor the store can't resolve — foreign like made-up", async () => {
    const [foreign] = await seed("list-cursor-b", 1);
    for (const after of ["nope", foreign]) {
      const res = await get(app, `/v1/agent-configs?namespace=list-cursor-a&after=${after}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });
});

describe("POST /v1/agent-configs/:id", () => {
  it("partially updates the config and increments its version", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    const res = await post(app, `/v1/agent-configs/${created.id}`, {
      systemPrompt: "You are a research analyst.",
      version: 1,
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({
      id: created.id,
      inference: RECIPE.inference,
      systemPrompt: "You are a research analyst.",
      namespace: "default",
      version: 2,
      createdAt: created.createdAt,
    });
    expect(typeof updated.updatedAt).toBe("string");

    const fetched = await get(app, `/v1/agent-configs/${created.id}`);
    expect(await fetched.json()).toEqual(updated);
  });

  it("returns 409 for a stale version and leaves the winning update intact", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    const winner = await post(app, `/v1/agent-configs/${created.id}`, {
      systemPrompt: "winner",
      version: 1,
    });
    expect(winner.status).toBe(200);

    const stale = await post(app, `/v1/agent-configs/${created.id}`, {
      systemPrompt: "stale",
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.type).toBe("conflict_error");

    const fetched = await (await get(app, `/v1/agent-configs/${created.id}`)).json();
    expect(fetched).toMatchObject({ systemPrompt: "winner", version: 2 });
  });

  it("updates unconditionally when version is omitted", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    await post(app, `/v1/agent-configs/${created.id}`, { systemPrompt: "first", version: 1 });
    const res = await post(app, `/v1/agent-configs/${created.id}`, {
      inference: { provider: "anthropic", model: "claude-opus-5" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      inference: { provider: "anthropic", model: "claude-opus-5" },
      systemPrompt: "first",
      version: 3,
    });
  });

  it("accepts an empty update as a no-op", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    const res = await post(app, `/v1/agent-configs/${created.id}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  it("validates the update body", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    for (const body of [{ version: 0 }, { inference: "model-only" }]) {
      const res = await post(app, `/v1/agent-configs/${created.id}`, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("404s unknown and foreign ids without mutating the foreign config", async () => {
    const unknown = await post(app, "/v1/agent-configs/nope?namespace=update-a", {
      systemPrompt: "x",
    });
    expect(unknown.status).toBe(404);

    const created = await (await post(app, "/v1/agent-configs", recipeFor("update-a"))).json();
    const foreign = await post(app, `/v1/agent-configs/${created.id}?namespace=update-b`, {
      systemPrompt: "x",
      version: 1,
    });
    expect(foreign.status).toBe(404);
    const own = await (await get(app, `/v1/agent-configs/${created.id}?namespace=update-a`)).json();
    expect(own).toMatchObject({ systemPrompt: RECIPE.systemPrompt, version: 1 });
  });
});

describe("POST /v1/agent-configs/:id/archive", () => {
  it("archives the config and returns it with the mark, 200", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    const res = await post(app, `/v1/agent-configs/${created.id}/archive`);
    expect(res.status).toBe(200);
    const archived = await res.json();
    // The config is retired, not edited: same version, same payload.
    expect(archived).toMatchObject({ ...created, archivedAt: expect.any(String) });

    const fetched = await get(app, `/v1/agent-configs/${created.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(archived);
  });

  it("is idempotent — re-archiving answers 200 with the first archivedAt", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    const first = await (await post(app, `/v1/agent-configs/${created.id}/archive`)).json();
    const again = await post(app, `/v1/agent-configs/${created.id}/archive`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
  });

  it("409s a later update — the config is read-only, and there is no way back", async () => {
    const created = await (await post(app, "/v1/agent-configs", RECIPE)).json();
    await post(app, `/v1/agent-configs/${created.id}/archive`);

    const res = await post(app, `/v1/agent-configs/${created.id}`, { systemPrompt: "after" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.type).toBe("conflict_error");

    const fetched = await (await get(app, `/v1/agent-configs/${created.id}`)).json();
    expect(fetched.systemPrompt).toBe(RECIPE.systemPrompt);
  });

  it("404s unknown and foreign ids without archiving the foreign config", async () => {
    expect((await post(app, "/v1/agent-configs/nope/archive?namespace=arch-a")).status).toBe(404);

    const created = await (await post(app, "/v1/agent-configs", recipeFor("arch-a"))).json();
    const foreign = await post(app, `/v1/agent-configs/${created.id}/archive?namespace=arch-b`);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.type).toBe("not_found_error");

    const own = await (await get(app, `/v1/agent-configs/${created.id}?namespace=arch-a`)).json();
    expect("archivedAt" in own).toBe(false);
  });
});

describe("GET /v1/agent-configs/:id", () => {
  it("404s an unknown id with the error envelope", async () => {
    const res = await get(app, "/v1/agent-configs/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe("not_found_error");
  });

  it("scopes by namespace: a foreign row 404s exactly like a nonexistent one", async () => {
    const created = await (await post(app, "/v1/agent-configs", recipeFor("tenant-a"))).json();

    const foreign = await get(app, `/v1/agent-configs/${created.id}?namespace=tenant-b`);
    expect(foreign.status).toBe(404);

    const own = await get(app, `/v1/agent-configs/${created.id}?namespace=tenant-a`);
    expect(own.status).toBe(200);
    expect((await own.json()).namespace).toBe("tenant-a");
  });
});
