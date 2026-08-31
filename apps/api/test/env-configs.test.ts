// Route tests over the REAL store — PGlite + the pg adapter, the same
// binding the driver suites use — so materialization (defaults resolved
// at create) is asserted end to end, never mocked.
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

describe("POST /v1/env-configs", () => {
  it("materializes a request without recipe overrides", async () => {
    const res = await post(app, "/v1/env-configs", { namespace: "default" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.network).toEqual({ type: "unrestricted" });
    expect(body.packages).toEqual({});
    expect(body.namespace).toBe("default");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
  });

  it("stores an explicit recipe verbatim and GET returns the same row", async () => {
    const recipe = {
      namespace: "default",
      network: { type: "allowlist", domains: ["registry.npmjs.org"] },
      packages: { npm: ["express@4.18.0"] },
      metadata: { label: "npm-only" },
    };
    const created = await (await post(app, "/v1/env-configs", recipe)).json();
    expect(created.network).toEqual(recipe.network);
    expect(created.packages).toEqual(recipe.packages);
    expect(created.metadata).toEqual(recipe.metadata);

    const fetched = await get(app, `/v1/env-configs/${created.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(created);
  });

  it("rejects a malformed network policy, 400", async () => {
    const res = await post(app, "/v1/env-configs", {
      namespace: "default",
      network: { type: "limited" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("defaults the namespace when the body omits it", async () => {
    const res = await post(app, "/v1/env-configs", {});
    expect(res.status).toBe(201);
    expect((await res.json()).namespace).toBe("default");
  });

  it("rejects an empty namespace — absence defaults, emptiness is a mistake", async () => {
    const res = await post(app, "/v1/env-configs", { namespace: "" });
    expect(res.status).toBe(400);
  });

  // Namespace is a PK component on every table; without the format
  // bound an oversized value overflows the btree tuple limit and
  // surfaces as a 500 instead of this 400.
  it("rejects a malformed namespace, 400 — oversized or bad characters", async () => {
    for (const namespace of ["x".repeat(65), "tenant a", "tenant/../b"]) {
      const res = await post(app, "/v1/env-configs", { namespace });
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });
});

describe("GET /v1/env-configs", () => {
  // The pagination machinery itself (limit bounds, over-fetched
  // hasMore, the page walk) is pinned in agent-configs.test.ts, which
  // shares it; here we pin this resource's own wiring.

  it("lists env configs only — the two config kinds are separate collections", async () => {
    const created = await (
      await post(app, "/v1/env-configs", { namespace: "list-env", packages: { npm: ["zod@4"] } })
    ).json();
    await post(app, "/v1/agent-configs", {
      namespace: "list-env",
      inference: { provider: "fake", model: "m" },
      systemPrompt: "s",
    });

    const res = await get(app, "/v1/env-configs?namespace=list-env");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [created], hasMore: false, lastId: created.id });
  });

  it("defaults the namespace when the query omits it", async () => {
    const created = await (await post(app, "/v1/env-configs", { namespace: "default" })).json();
    const body = await (await get(app, "/v1/env-configs?limit=100")).json();
    expect(body.data).toContainEqual(created);
    // The default page is bounded whether or not the caller asks.
    const capped = await (await get(app, "/v1/env-configs?limit=1")).json();
    expect(capped.data).toHaveLength(1);
  });

  it("400s a cursor from another namespace", async () => {
    const foreign = await (await post(app, "/v1/env-configs", { namespace: "env-cur-b" })).json();
    const res = await get(app, `/v1/env-configs?namespace=env-cur-a&after=${foreign.id}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });
});

describe("GET /v1/env-configs/:id", () => {
  it("404s an unknown id with the error envelope", async () => {
    const res = await get(app, "/v1/env-configs/nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("not_found_error");
  });
});

describe("POST /v1/env-configs/:id", () => {
  it("partially updates the recipe in place", async () => {
    const created = await (
      await post(app, "/v1/env-configs", {
        namespace: "default",
        network: { type: "allowlist", domains: ["pypi.org"] },
        packages: { pip: ["numpy"] },
        metadata: { stage: "initial" },
      })
    ).json();

    const res = await post(app, `/v1/env-configs/${created.id}`, {
      packages: { npm: ["zod@4"] },
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated).toEqual({
      ...created,
      packages: { npm: ["zod@4"] },
    });
    expect(await (await get(app, `/v1/env-configs/${created.id}`)).json()).toEqual(updated);
  });

  it("accepts an empty update as a no-op", async () => {
    const created = await (await post(app, "/v1/env-configs", { namespace: "default" })).json();
    const res = await post(app, `/v1/env-configs/${created.id}`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });

  it("validates the update body", async () => {
    const created = await (await post(app, "/v1/env-configs", { namespace: "default" })).json();
    for (const body of [{ network: { type: "vpn" } }, { packages: ["numpy"] }]) {
      const res = await post(app, `/v1/env-configs/${created.id}`, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request_error");
    }
  });

  it("404s unknown and foreign ids without mutating the foreign config", async () => {
    const unknown = await post(app, "/v1/env-configs/nope?namespace=update-a", {
      packages: { npm: ["zod"] },
    });
    expect(unknown.status).toBe(404);

    const created = await (
      await post(app, "/v1/env-configs", { namespace: "update-a", packages: { pip: ["numpy"] } })
    ).json();
    const foreign = await post(app, `/v1/env-configs/${created.id}?namespace=update-b`, {
      packages: { npm: ["zod"] },
    });
    expect(foreign.status).toBe(404);
    const own = await (await get(app, `/v1/env-configs/${created.id}?namespace=update-a`)).json();
    expect(own.packages).toEqual({ pip: ["numpy"] });
  });
});

describe("namespace scoping", () => {
  it("creates in the namespace the request names and scopes reads by the query", async () => {
    const res = await post(app, "/v1/env-configs", { namespace: "tenant-a" });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.namespace).toBe("tenant-a");
    expect((await get(app, `/v1/env-configs/${created.id}?namespace=tenant-a`)).status).toBe(200);
    expect((await get(app, `/v1/env-configs/${created.id}?namespace=tenant-b`)).status).toBe(404);
  });

  it("a foreign row 404s exactly like a nonexistent one", async () => {
    const created = await (await post(app, "/v1/env-configs", { namespace: "tenant-a" })).json();

    const foreign = await get(app, `/v1/env-configs/${created.id}?namespace=tenant-b`);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.type).toBe("not_found_error");

    const own = await get(app, `/v1/env-configs/${created.id}?namespace=tenant-a`);
    expect(own.status).toBe(200);
    expect((await own.json()).namespace).toBe("tenant-a");
  });

  it("400s an empty or malformed namespace in the query", async () => {
    for (const namespace of ["", "x".repeat(65), "tenant%20a"]) {
      const res = await get(app, `/v1/env-configs/some-id?namespace=${namespace}`);
      expect(res.status).toBe(400);
    }
  });
});
