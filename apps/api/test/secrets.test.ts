// The secrets routes over the in-memory SecretProvider. Each adapter
// meets the port's contract in its own conformance run (packages/
// adapters); here, the routes: the wire shapes, validation, namespace
// scoping, no answer ever carrying a value, and the answer when no
// secret store is configured.
import { describe, expect, it, vi } from "vitest";
import { createMemorySecretProvider } from "@funky/adapters";
import type { SecretProvider } from "@funky/agent";
import { del, get, makeApp, put } from "./helpers";

const KEY = "sk_live_51HxYzQ8SECRET";

function withStore() {
  const secrets = createMemorySecretProvider();
  return { secrets, app: makeApp({ secrets }) };
}

describe("PUT /v1/secrets/:name", () => {
  it("stores the value and answers its name and timestamps, never the value", async () => {
    const { secrets, app } = withStore();
    const res = await put(app, "/v1/secrets/stripe-live?namespace=acme", { value: KEY });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      name: "stripe-live",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(text).not.toContain(KEY);
    expect(await secrets.resolve("acme", ["stripe-live"])).toEqual(new Map([["stripe-live", KEY]]));
  });

  it("replaces a stored value, keeping its createdAt", async () => {
    let now = Date.parse("2026-10-22T00:00:00.000Z");
    const secrets = createMemorySecretProvider({ now: () => new Date(now) });
    const app = makeApp({ secrets });
    const first = await (await put(app, "/v1/secrets/token", { value: "one" })).json();
    now += 60_000;
    const res = await put(app, "/v1/secrets/token", { value: "two" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "token",
      createdAt: first.createdAt,
      updatedAt: "2026-10-22T00:01:00.000Z",
    });
    expect(await secrets.resolve("default", ["token"])).toEqual(new Map([["token", "two"]]));
  });

  it("stores under the default namespace when none is given", async () => {
    const { secrets, app } = withStore();
    expect((await put(app, "/v1/secrets/token", { value: KEY })).status).toBe(200);
    expect(await secrets.resolve("default", ["token"])).toEqual(new Map([["token", KEY]]));
  });

  it("takes a value of exactly 64 KiB, in bytes", async () => {
    const { secrets, app } = withStore();
    const ascii = "x".repeat(64 * 1024);
    const multibyte = "é".repeat(32 * 1024);
    expect((await put(app, "/v1/secrets/ascii", { value: ascii })).status).toBe(200);
    expect((await put(app, "/v1/secrets/multibyte", { value: multibyte })).status).toBe(200);
    expect(await secrets.resolve("default", ["ascii", "multibyte"])).toEqual(
      new Map([
        ["ascii", ascii],
        ["multibyte", multibyte],
      ]),
    );
  });

  it.each([["has.dot"], ["a".repeat(65)], ["with%20space"], ["a%2Fb"]])(
    "400s the name %s, storing nothing",
    async (name) => {
      const { secrets, app } = withStore();
      const res = await put(app, `/v1/secrets/${name}`, { value: KEY });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual({
        type: "invalid_request_error",
        message: "name: 1-64 characters: letters, digits, _ and -",
      });
      expect(await secrets.list("default")).toEqual([]);
    },
  );

  it.each([
    ["an empty value", "", "value: must not be empty"],
    ["a leading space", ` ${KEY}`, "value: has whitespace at an end"],
    ["a trailing newline", `${KEY}\n`, "value: has whitespace at an end"],
    ["a reference", `${KEY}\${OTHER}`, "value: contains ${"],
    ["64 KiB and a byte", "x".repeat(64 * 1024 + 1), "value: must be at most 64 KiB"],
    ["64 KiB and a byte, multibyte", `${"é".repeat(32 * 1024)}x`, "value: must be at most 64 KiB"],
  ])("400s %s without repeating it, storing nothing", async (_, value, message) => {
    const { secrets, app } = withStore();
    const res = await put(app, "/v1/secrets/token", { value });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ type: "invalid_request_error", message });
    expect(text).not.toContain(KEY);
    expect(await secrets.list("default")).toEqual([]);
  });

  it.each([[{}], [{ value: 42 }], [{ secret: KEY }]])("400s the body %j", async (body) => {
    const { app } = withStore();
    const res = await put(app, "/v1/secrets/token", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("400s a malformed namespace", async () => {
    const { app } = withStore();
    const res = await put(app, "/v1/secrets/token?namespace=a.b", { value: KEY });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/secrets", () => {
  it("lists the namespace's names, sorted, without their values", async () => {
    const { app } = withStore();
    await put(app, "/v1/secrets/zeta?namespace=acme", { value: "zeta-value" });
    await put(app, "/v1/secrets/alpha?namespace=acme", { value: "alpha-value" });
    await put(app, "/v1/secrets/beta?namespace=globex", { value: "beta-value" });
    const res = await get(app, "/v1/secrets?namespace=acme");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      data: [
        { name: "alpha", createdAt: expect.any(String), updatedAt: expect.any(String) },
        { name: "zeta", createdAt: expect.any(String), updatedAt: expect.any(String) },
      ],
    });
    expect(text).not.toContain("-value");
  });

  it("answers an empty list for a namespace with none", async () => {
    const { app } = withStore();
    const res = await get(app, "/v1/secrets?namespace=acme");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe("DELETE /v1/secrets/:name", () => {
  it("removes the secret: 204, then 404 once it's gone", async () => {
    const { secrets, app } = withStore();
    await put(app, "/v1/secrets/token?namespace=acme", { value: KEY });
    const res = await del(app, "/v1/secrets/token?namespace=acme");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await secrets.list("acme")).toEqual([]);

    const again = await del(app, "/v1/secrets/token?namespace=acme");
    expect(again.status).toBe(404);
    expect((await again.json()).error).toEqual({
      type: "not_found_error",
      message: "no secret token",
    });
  });

  it("never reaches another namespace's secret", async () => {
    const { secrets, app } = withStore();
    await put(app, "/v1/secrets/token?namespace=acme", { value: KEY });
    expect((await del(app, "/v1/secrets/token?namespace=globex")).status).toBe(404);
    expect((await secrets.list("acme")).map((s) => s.name)).toEqual(["token"]);
  });

  it("400s a malformed name", async () => {
    const { app } = withStore();
    expect((await del(app, "/v1/secrets/has.dot")).status).toBe(400);
  });
});

describe("without a secret store", () => {
  it("answers every route 404, saying none is configured", async () => {
    const app = makeApp();
    for (const res of [
      await get(app, "/v1/secrets"),
      await put(app, "/v1/secrets/token", { value: KEY }),
      await del(app, "/v1/secrets/token"),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error).toEqual({
        type: "not_found_error",
        message: expect.stringContaining("no secret store configured"),
      });
    }
  });
});

describe("a failing secret store", () => {
  it("is a 500 — never a 404, never the value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outage = async () => {
      throw new Error("Infisical answered 503 to GET /api/v4/secrets: unavailable");
    };
    const secrets: SecretProvider = { put: outage, delete: outage, list: outage, resolve: outage };
    const app = makeApp({ secrets });
    for (const res of [
      await put(app, "/v1/secrets/token", { value: KEY }),
      await get(app, "/v1/secrets"),
      await del(app, "/v1/secrets/token"),
    ]) {
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(KEY);
    }
    vi.restoreAllMocks();
  });
});

describe("auth", () => {
  it("401s without the bearer token", async () => {
    const secrets = createMemorySecretProvider();
    const app = makeApp({ authToken: "0123456789abcdef", secrets });
    expect((await get(app, "/v1/secrets")).status).toBe(401);
    expect((await put(app, "/v1/secrets/token", { value: KEY })).status).toBe(401);
    expect(await secrets.list("default")).toEqual([]);
  });
});
