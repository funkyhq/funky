// Route tests over the REAL store — PGlite + the pg adapter, the same
// binding the driver suites use — so materialization (defaults resolved
// at create) is asserted end to end, never mocked.
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

describe("POST /v1/env-configs", () => {
  it("materializes an empty request: every default becomes a stored decision", async () => {
    const res = await post(app, "/v1/env-configs", {});
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
    const res = await post(app, "/v1/env-configs", { network: { type: "limited" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("GET /v1/env-configs", () => {
  // The pagination machinery itself (limit bounds, over-fetched
  // hasMore, the page walk) is pinned in agent-configs.test.ts, which
  // shares it; here we pin this resource's own wiring.
  const asTenant = (tenant: string) => ({ "X-Funky-Namespace": tenant });

  it("lists env configs only — the two config kinds are separate collections", async () => {
    const created = await (
      await post(scoped, "/v1/env-configs", { packages: { npm: ["zod@4"] } }, asTenant("list-env"))
    ).json();
    await post(
      scoped,
      "/v1/agent-configs",
      { inference: { provider: "fake", model: "m" }, systemPrompt: "s" },
      asTenant("list-env"),
    );

    const res = await get(scoped, "/v1/env-configs", asTenant("list-env"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [created], hasMore: false, lastId: created.id });
  });

  it("is wired on the static namespace source too", async () => {
    const created = await (await post(app, "/v1/env-configs", {})).json();
    const body = await (await get(app, "/v1/env-configs?limit=100")).json();
    expect(body.data).toContainEqual(created);
    // The default page is bounded whether or not the caller asks.
    const capped = await (await get(app, "/v1/env-configs?limit=1")).json();
    expect(capped.data).toHaveLength(1);
  });

  it("400s a cursor from another namespace", async () => {
    const foreign = await (await post(scoped, "/v1/env-configs", {}, asTenant("env-cur-b"))).json();
    const res = await get(scoped, `/v1/env-configs?after=${foreign.id}`, asTenant("env-cur-a"));
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

describe("namespace scoping (namespaceSource=header — the managed-gateway shape)", () => {
  const asTenant = (tenant: string) => ({ "X-Funky-Namespace": tenant });

  it("stamps the middleware's namespace and ignores any client-supplied one", async () => {
    const res = await post(
      scoped,
      "/v1/env-configs",
      { namespace: "tenant-b" }, // stripped by the wire schema; the header decides
      asTenant("tenant-a"),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).namespace).toBe("tenant-a");
  });

  it("a foreign row 404s exactly like a nonexistent one", async () => {
    const created = await (await post(scoped, "/v1/env-configs", {}, asTenant("tenant-a"))).json();

    const foreign = await get(scoped, `/v1/env-configs/${created.id}`, asTenant("tenant-b"));
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.type).toBe("not_found_error");

    const own = await get(scoped, `/v1/env-configs/${created.id}`, asTenant("tenant-a"));
    expect(own.status).toBe(200);
    expect((await own.json()).namespace).toBe("tenant-a");
  });

  it("rejects a malformed namespace header", async () => {
    const res = await post(scoped, "/v1/env-configs", {}, asTenant("no spaces allowed"));
    expect(res.status).toBe(400);
  });
});
