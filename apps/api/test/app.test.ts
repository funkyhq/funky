// The app shell: health, the error envelope, request ids, and auth.
import { describe, expect, it } from "vitest";
import { get, makeApp, post, UUID_V7 } from "./helpers";

describe("GET /health", () => {
  it("is ok and unauthenticated", async () => {
    const app = makeApp({ authToken: "0123456789abcdef" });
    const res = await get(app, "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("the error envelope", () => {
  it("404s unknown routes with a request id", async () => {
    const app = makeApp();
    const res = await get(app, "/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("request-id")).toMatch(UUID_V7);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found_error");
    expect(body.request_id).toMatch(UUID_V7);
  });
});

describe("auth", () => {
  const TOKEN = "0123456789abcdef";

  it("401s /v1 requests without the bearer token", async () => {
    const app = makeApp({ authToken: TOKEN });
    const res = await post(app, "/v1/env-configs", {});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("401s a wrong token", async () => {
    const app = makeApp({ authToken: TOKEN });
    const res = await get(app, "/v1/env-configs/x", { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("admits the right token", async () => {
    const app = makeApp({ authToken: TOKEN });
    // The inert store makes a passing request throw — reaching the 500
    // handler proves auth admitted it (401 would short-circuit first).
    const res = await get(app, "/v1/env-configs/x", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(500);
  });
});
