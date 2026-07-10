// Cross-cutting behavior wired up in app.ts: health probe, auth gate,
// request-id middleware, the error envelope, and the not-found fallback.
import { describe, it, expect, vi } from "vitest";
import { ConflictError, NotFoundError } from "@funky/configs";
import { AGENT_ID, UUID_V7, agentFixture, get, makeApp, post } from "./helpers";

describe("GET /healthz", () => {
  it("returns ok and pings the database", async () => {
    const ping = vi.fn(async () => ({ rows: [] }));
    const { app } = makeApp({ ping });

    const res = await get(app, "/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(ping).toHaveBeenCalledOnce();
  });

  it("is reachable without auth even when a token is configured", async () => {
    const { app } = makeApp({ authToken: "super-secret-token-1234" });
    const res = await get(app, "/healthz"); // no Authorization header
    expect(res.status).toBe(200);
  });

  it("returns 500 when the database ping fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ ping: async () => Promise.reject(new Error("db down")) });

    const res = await get(app, "/healthz");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.type).toBe("api_error");
    expect(res.headers.get("request-id")).toMatch(UUID_V7);
    expect(errSpy).toHaveBeenCalled(); // the failure is logged, not swallowed
    errSpy.mockRestore();
  });
});

describe("auth middleware", () => {
  const token = "super-secret-token-1234";

  it("rejects requests with no Authorization header", async () => {
    const { app, fake } = makeApp({ authToken: token });

    const res = await get(app, `/v1/agents/${AGENT_ID}`);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toMatchObject({
      type: "error",
      error: { type: "authentication_error", message: "invalid or missing API token" },
    });
    expect(body.request_id).toMatch(UUID_V7);
    expect(fake.get).not.toHaveBeenCalled();
  });

  it("rejects an incorrect bearer token", async () => {
    const { app, fake } = makeApp({ authToken: token });
    const res = await get(app, `/v1/agents/${AGENT_ID}`, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    expect(fake.get).not.toHaveBeenCalled();
  });

  it("rejects a non-bearer scheme", async () => {
    const { app } = makeApp({ authToken: token });
    const res = await get(app, `/v1/agents/${AGENT_ID}`, { authorization: `Basic ${token}` });
    expect(res.status).toBe(401);
  });

  it("accepts the correct bearer token", async () => {
    const { app, fake } = makeApp({
      authToken: token,
      agents: { get: vi.fn().mockResolvedValue(agentFixture()) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}`, { authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(fake.get).toHaveBeenCalledOnce();
  });

  it("allows all requests when auth is disabled (token = null)", async () => {
    const { app, fake } = makeApp({
      authToken: null,
      agents: { get: vi.fn().mockResolvedValue(agentFixture()) },
    });
    const res = await get(app, `/v1/agents/${AGENT_ID}`); // no header
    expect(res.status).toBe(200);
    expect(fake.get).toHaveBeenCalledOnce();
  });
});

describe("request-id middleware", () => {
  it("sets a uuid v7 request-id header on every response", async () => {
    const { app } = makeApp();
    const res = await get(app, "/healthz");
    expect(res.headers.get("request-id")).toMatch(UUID_V7);
  });

  it("echoes the same id in the error envelope as in the header", async () => {
    const { app } = makeApp({
      agents: { get: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}`);
    const body = await res.json();

    expect(body.request_id).toBe(res.headers.get("request-id"));
    expect(body.request_id).toMatch(UUID_V7);
  });

  it("issues a distinct id per request", async () => {
    const { app } = makeApp();
    const [a, b] = await Promise.all([get(app, "/healthz"), get(app, "/healthz")]);
    expect(a.headers.get("request-id")).not.toBe(b.headers.get("request-id"));
  });
});

describe("error mapping (onError)", () => {
  it("maps NotFoundError to 404 not_found_error", async () => {
    const { app } = makeApp({
      agents: { get: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error", message: "agent not found" },
    });
  });

  it("maps ConflictError to 409 invalid_request_error", async () => {
    const { app } = makeApp({
      agents: {
        update: vi.fn().mockRejectedValue(new ConflictError("agent is archived and read-only")),
      },
    });

    const res = await post(app, `/v1/agents/${AGENT_ID}`, { name: "new name" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: "agent is archived and read-only" },
    });
  });

  it("maps an unexpected error to a logged 500 api_error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      agents: { get: vi.fn().mockRejectedValue(new Error("kaboom")) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}`);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "api_error", message: "internal server error" },
    });
    expect(errSpy).toHaveBeenCalled(); // the raw error is logged, not leaked
    errSpy.mockRestore();
  });
});

describe("not-found fallback", () => {
  it("returns 404 not_found_error for an unknown route", async () => {
    const { app } = makeApp();
    const res = await get(app, "/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error", message: "unknown route" },
    });
  });

  it("runs auth before the not-found fallback under /v1", async () => {
    const { app } = makeApp({ authToken: "super-secret-token-1234" });
    // Unknown /v1 route with no token: auth answers first with 401, not 404.
    const res = await get(app, "/v1/nope");
    expect(res.status).toBe(401);
  });
});
