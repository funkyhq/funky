// The /v1/sessions routes: shape validation at the edge, correct delegation to the
// service (auth context + camelCased options), and status-code mapping. The SSE stream and
// the actual transactional behavior are covered against a real Postgres in
// sessions.integration.test.ts and sse.test.ts.
import { describe, it, expect, vi } from "vitest";
import { ConflictError, NotFoundError } from "@funky/configs";
import {
  AGENT_ID,
  CTX,
  SESSION_ID,
  createSessionBody,
  eventFixture,
  get,
  makeApp,
  post,
  sessionFixture,
} from "./helpers";

describe("POST /v1/sessions (create)", () => {
  it("creates a new session and returns 201", async () => {
    const session = sessionFixture();
    const { app, fakeSessions } = makeApp({
      sessions: { create: vi.fn().mockResolvedValue({ session, created: true }) },
    });

    const res = await post(app, "/v1/sessions", createSessionBody());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(session);
    expect(fakeSessions.create).toHaveBeenCalledWith(CTX, createSessionBody());
  });

  it("returns 200 for an idempotent (already-exists) create", async () => {
    const session = sessionFixture();
    const { app } = makeApp({
      sessions: { create: vi.fn().mockResolvedValue({ session, created: false }) },
    });

    const res = await post(app, "/v1/sessions", createSessionBody({ id: SESSION_ID }));
    expect(res.status).toBe(200);
  });

  it("accepts an explicit { id, version } agent reference", async () => {
    const session = sessionFixture({ agent: { id: AGENT_ID, version: 3 } });
    const { app, fakeSessions } = makeApp({
      sessions: { create: vi.fn().mockResolvedValue({ session, created: true }) },
    });

    const body = createSessionBody({ agent: { id: AGENT_ID, version: 3 } });
    const res = await post(app, "/v1/sessions", body);

    expect(res.status).toBe(201);
    expect(fakeSessions.create).toHaveBeenCalledWith(CTX, body);
  });

  it("maps a NotFoundError (unknown agent/env) to 404", async () => {
    const { app } = makeApp({
      sessions: { create: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });
    const res = await post(app, "/v1/sessions", createSessionBody());
    expect(res.status).toBe(404);
  });

  it("maps a ConflictError (archived agent/env) to 409", async () => {
    const { app } = makeApp({
      sessions: {
        create: vi.fn().mockRejectedValue(new ConflictError("agent is archived")),
      },
    });
    const res = await post(app, "/v1/sessions", createSessionBody());
    expect(res.status).toBe(409);
  });

  it.each([
    ["missing agent", createSessionBody({ agent: undefined })],
    ["non-uuid agent", createSessionBody({ agent: "not-a-uuid" })],
    ["agent version < 1", createSessionBody({ agent: { id: AGENT_ID, version: 0 } })],
    [
      "agent object with extra field",
      createSessionBody({ agent: { id: AGENT_ID, version: 1, x: 1 } }),
    ],
    ["missing environment_id", createSessionBody({ environment_id: undefined })],
    ["non-uuid environment_id", createSessionBody({ environment_id: "nope" })],
    ["title too long", createSessionBody({ title: "x".repeat(257) })],
    ["non-uuid id", createSessionBody({ id: "not-a-uuid" })],
    ["unknown top-level field (strict)", createSessionBody({ nope: true })],
    [
      "too many metadata pairs",
      createSessionBody({
        metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])),
      }),
    ],
  ])("rejects %s with 400 and does not call the service", async (_label, body) => {
    const { app, fakeSessions } = makeApp();
    const res = await post(app, "/v1/sessions", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("invalid_request_error");
    expect(fakeSessions.create).not.toHaveBeenCalled();
  });
});

describe("GET /v1/sessions (list)", () => {
  it("uses defaults when no query params are given", async () => {
    const page = { data: [sessionFixture()], has_more: false, last_id: SESSION_ID };
    const { app, fakeSessions } = makeApp({ sessions: { list: vi.fn().mockResolvedValue(page) } });

    const res = await get(app, "/v1/sessions");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(fakeSessions.list).toHaveBeenCalledWith(CTX, {
      limit: 20,
      afterId: undefined,
      includeArchived: false,
    });
  });

  it("maps query params to service options", async () => {
    const { app, fakeSessions } = makeApp({
      sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    });

    await get(app, `/v1/sessions?limit=5&after_id=${SESSION_ID}&include_archived=true`);

    expect(fakeSessions.list).toHaveBeenCalledWith(CTX, {
      limit: 5,
      afterId: SESSION_ID,
      includeArchived: true,
    });
  });
});

describe("GET /v1/sessions/:id (retrieve)", () => {
  it("returns the session from the service", async () => {
    const session = sessionFixture();
    const { app, fakeSessions } = makeApp({
      sessions: { get: vi.fn().mockResolvedValue(session) },
    });

    const res = await get(app, `/v1/sessions/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(session);
    expect(fakeSessions.get).toHaveBeenCalledWith(CTX, SESSION_ID);
  });

  it("returns 404 when the service reports not found", async () => {
    const { app } = makeApp({
      sessions: { get: vi.fn().mockRejectedValue(new NotFoundError("session not found")) },
    });
    const res = await get(app, `/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/sessions/:id/archive", () => {
  it("archives and returns the session", async () => {
    const archived = sessionFixture({
      status: "archived",
      archived_at: "2026-01-02T00:00:00.000Z",
    });
    const { app, fakeSessions } = makeApp({
      sessions: { archive: vi.fn().mockResolvedValue(archived) },
    });

    const res = await post(app, `/v1/sessions/${SESSION_ID}/archive`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(archived);
    expect(fakeSessions.archive).toHaveBeenCalledWith(CTX, SESSION_ID);
  });

  it("returns 404 when the session does not exist", async () => {
    const { app } = makeApp({
      sessions: { archive: vi.fn().mockRejectedValue(new NotFoundError("session not found")) },
    });
    const res = await post(app, `/v1/sessions/${SESSION_ID}/archive`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/sessions/:id/messages", () => {
  it("accepts a message and returns 202 with the turn + seq", async () => {
    const { app, fakeSessions } = makeApp({
      sessions: { sendMessage: vi.fn().mockResolvedValue({ turn: "queued", seq: 5 }) },
    });

    const res = await post(app, `/v1/sessions/${SESSION_ID}/messages`, { content: "say hello" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ turn: "queued", seq: 5 });
    expect(fakeSessions.sendMessage).toHaveBeenCalledWith(CTX, SESSION_ID, "say hello");
  });

  it("maps an active-turn/archived ConflictError to 409", async () => {
    const { app } = makeApp({
      sessions: {
        sendMessage: vi
          .fn()
          .mockRejectedValue(new ConflictError("a turn is already in progress for this session")),
      },
    });

    const res = await post(app, `/v1/sessions/${SESSION_ID}/messages`, { content: "hi" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      message: "a turn is already in progress for this session",
    });
  });

  it("returns 404 for a message to a missing session", async () => {
    const { app } = makeApp({
      sessions: { sendMessage: vi.fn().mockRejectedValue(new NotFoundError("session not found")) },
    });
    const res = await post(app, `/v1/sessions/${SESSION_ID}/messages`, { content: "hi" });
    expect(res.status).toBe(404);
  });

  it.each([
    ["missing content", {}],
    ["empty content", { content: "" }],
    ["content too long", { content: "x".repeat(100_001) }],
    ["non-string content", { content: 42 }],
    ["unknown field (strict)", { content: "hi", extra: true }],
  ])("rejects %s with 400 without calling the service", async (_label, body) => {
    const { app, fakeSessions } = makeApp();
    const res = await post(app, `/v1/sessions/${SESSION_ID}/messages`, body);
    expect(res.status).toBe(400);
    expect(fakeSessions.sendMessage).not.toHaveBeenCalled();
  });
});

describe("GET /v1/sessions/:id/events", () => {
  it("uses defaults and maps to service options", async () => {
    const listing = { data: [eventFixture()], has_more: false, last_seq: 1 };
    const { app, fakeSessions } = makeApp({
      sessions: { getEvents: vi.fn().mockResolvedValue(listing) },
    });

    const res = await get(app, `/v1/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(listing);
    expect(fakeSessions.getEvents).toHaveBeenCalledWith(CTX, SESSION_ID, {
      afterSeq: 0,
      limit: 100,
    });
  });

  it("maps after_seq and limit to service options", async () => {
    const { app, fakeSessions } = makeApp({
      sessions: {
        getEvents: vi.fn().mockResolvedValue({ data: [], has_more: false, last_seq: 9 }),
      },
    });

    await get(app, `/v1/sessions/${SESSION_ID}/events?after_seq=3&limit=50`);

    expect(fakeSessions.getEvents).toHaveBeenCalledWith(CTX, SESSION_ID, {
      afterSeq: 3,
      limit: 50,
    });
  });

  it.each([
    ["after_seq negative", `/v1/sessions/${SESSION_ID}/events?after_seq=-1`],
    ["limit=0", `/v1/sessions/${SESSION_ID}/events?limit=0`],
    ["limit=501", `/v1/sessions/${SESSION_ID}/events?limit=501`],
    ["limit non-numeric", `/v1/sessions/${SESSION_ID}/events?limit=abc`],
  ])("rejects %s with 400", async (_label, path) => {
    const { app, fakeSessions } = makeApp();
    const res = await get(app, path);
    expect(res.status).toBe(400);
    expect(fakeSessions.getEvents).not.toHaveBeenCalled();
  });

  it("returns 404 for events of a missing session", async () => {
    const { app } = makeApp({
      sessions: { getEvents: vi.fn().mockRejectedValue(new NotFoundError("session not found")) },
    });
    const res = await get(app, `/v1/sessions/${SESSION_ID}/events`);
    expect(res.status).toBe(404);
  });
});
