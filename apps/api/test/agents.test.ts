// The /v1/agents routes: shape validation at the edge, correct delegation to the
// service (auth context + camelCased options), and status-code mapping.
import { describe, it, expect, vi } from "vitest";
import { NotFoundError } from "@funky/configs";
import {
  AGENT_ID,
  CTX,
  agentFixture,
  createBody,
  get,
  makeApp,
  post,
  versionFixture,
} from "./helpers";

describe("POST /v1/agents (create)", () => {
  it("creates a new agent and returns 201", async () => {
    const agent = agentFixture();
    const { app, fake } = makeApp({
      agents: { create: vi.fn().mockResolvedValue({ agent, created: true }) },
    });

    const res = await post(app, "/v1/agents", createBody());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(agent);
    expect(fake.create).toHaveBeenCalledWith(CTX, createBody());
  });

  it("accepts runtime claude-code with an anthropic model and passes it through", async () => {
    const agent = agentFixture();
    const { app, fake } = makeApp({
      agents: { create: vi.fn().mockResolvedValue({ agent, created: true }) },
    });

    const body = createBody({ runtime: { type: "claude-code" } });
    const res = await post(app, "/v1/agents", body);

    expect(res.status).toBe(201);
    expect(fake.create).toHaveBeenCalledWith(CTX, body);
  });

  it("returns 200 for an idempotent (already-exists) create", async () => {
    const agent = agentFixture();
    const { app } = makeApp({
      agents: { create: vi.fn().mockResolvedValue({ agent, created: false }) },
    });

    const res = await post(app, "/v1/agents", createBody({ id: AGENT_ID }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["missing name", createBody({ name: undefined })],
    ["empty name", createBody({ name: "" })],
    ["name too long", createBody({ name: "x".repeat(257) })],
    ["missing system_prompt", createBody({ system_prompt: undefined })],
    ["empty system_prompt", createBody({ system_prompt: "" })],
    ["missing model", createBody({ model: undefined })],
    ["bad model provider", createBody({ model: { provider: "acme", model: "x" } })],
    ["empty model name", createBody({ model: { provider: "anthropic", model: "" } })],
    ["temperature out of range", createBody({ model: { provider: "anthropic", model: "m", temperature: 5 } })],
    ["unknown top-level field (strict)", createBody({ nope: true })],
    ["non-uuid id", createBody({ id: "not-a-uuid" })],
    ["too many metadata pairs", createBody({ metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) })],
    ["unknown runtime type", createBody({ runtime: { type: "langchain" } })],
    ["runtime claude-code with a non-anthropic model", createBody({ runtime: { type: "claude-code" }, model: { provider: "openai", model: "gpt-x" } })],
  ])("rejects %s with 400 and does not call the service", async (_label, body) => {
    const { app, fake } = makeApp();

    const res = await post(app, "/v1/agents", body);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.type).toBe("invalid_request_error");
    expect(fake.create).not.toHaveBeenCalled();
  });
});

describe("GET /v1/agents (list)", () => {
  it("uses defaults when no query params are given", async () => {
    const page = { data: [agentFixture()], has_more: false, last_id: AGENT_ID };
    const { app, fake } = makeApp({ agents: { list: vi.fn().mockResolvedValue(page) } });

    const res = await get(app, "/v1/agents");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(fake.list).toHaveBeenCalledWith(CTX, {
      limit: 20,
      afterId: undefined,
      includeArchived: false,
    });
  });

  it("maps query params to service options", async () => {
    const { app, fake } = makeApp({
      agents: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    });

    await get(app, `/v1/agents?limit=5&after_id=${AGENT_ID}&include_archived=true`);

    expect(fake.list).toHaveBeenCalledWith(CTX, {
      limit: 5,
      afterId: AGENT_ID,
      includeArchived: true,
    });
  });

  it.each([
    ["limit=0", "/v1/agents?limit=0"],
    ["limit=101", "/v1/agents?limit=101"],
    ["limit=abc", "/v1/agents?limit=abc"],
    ["non-uuid after_id", "/v1/agents?after_id=nope"],
    ["invalid include_archived", "/v1/agents?include_archived=maybe"],
  ])("rejects %s with 400", async (_label, path) => {
    const { app, fake } = makeApp();
    const res = await get(app, path);
    expect(res.status).toBe(400);
    expect(fake.list).not.toHaveBeenCalled();
  });
});

describe("GET /v1/agents/:id (retrieve)", () => {
  it("returns the agent from the service", async () => {
    const agent = agentFixture();
    const { app, fake } = makeApp({ agents: { get: vi.fn().mockResolvedValue(agent) } });

    const res = await get(app, `/v1/agents/${AGENT_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(agent);
    expect(fake.get).toHaveBeenCalledWith(CTX, AGENT_ID);
  });

  it("returns 404 when the service reports not found", async () => {
    const { app } = makeApp({
      agents: { get: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });
    const res = await get(app, `/v1/agents/${AGENT_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/agents/:id (update)", () => {
  it("applies a partial update and returns the agent", async () => {
    const agent = agentFixture({ name: "renamed" });
    const { app, fake } = makeApp({ agents: { update: vi.fn().mockResolvedValue(agent) } });

    const res = await post(app, `/v1/agents/${AGENT_ID}`, { name: "renamed" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(agent);
    expect(fake.update).toHaveBeenCalledWith(CTX, AGENT_ID, { name: "renamed" });
  });

  it("rejects an empty patch with 400", async () => {
    const { app, fake } = makeApp();
    const res = await post(app, `/v1/agents/${AGENT_ID}`, {});
    expect(res.status).toBe(400);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("rejects an attempt to change the id with 400 (strict)", async () => {
    const { app, fake } = makeApp();
    const res = await post(app, `/v1/agents/${AGENT_ID}`, { id: AGENT_ID, name: "x" });
    expect(res.status).toBe(400);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid field value with 400", async () => {
    const { app } = makeApp();
    const res = await post(app, `/v1/agents/${AGENT_ID}`, { system_prompt: "" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/agents/:id/archive", () => {
  it("archives and returns the agent", async () => {
    const archived = agentFixture({ archived_at: "2026-01-02T00:00:00.000Z" });
    const { app, fake } = makeApp({ agents: { archive: vi.fn().mockResolvedValue(archived) } });

    const res = await post(app, `/v1/agents/${AGENT_ID}/archive`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(archived);
    expect(fake.archive).toHaveBeenCalledWith(CTX, AGENT_ID);
  });

  it("returns 404 when the agent does not exist", async () => {
    const { app } = makeApp({
      agents: { archive: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });
    const res = await post(app, `/v1/agents/${AGENT_ID}/archive`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/agents/:id/versions (list versions)", () => {
  it("uses defaults when no query params are given", async () => {
    const listing = { data: [versionFixture()], has_more: false };
    const { app, fake } = makeApp({
      agents: { listVersions: vi.fn().mockResolvedValue(listing) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}/versions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(listing);
    expect(fake.listVersions).toHaveBeenCalledWith(CTX, AGENT_ID, {
      limit: 20,
      afterVersion: undefined,
    });
  });

  it("maps limit and after_version to service options", async () => {
    const { app, fake } = makeApp({
      agents: { listVersions: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    });

    await get(app, `/v1/agents/${AGENT_ID}/versions?limit=3&after_version=5`);

    expect(fake.listVersions).toHaveBeenCalledWith(CTX, AGENT_ID, {
      limit: 3,
      afterVersion: 5,
    });
  });

  it("rejects after_version=0 with 400", async () => {
    const { app, fake } = makeApp();
    const res = await get(app, `/v1/agents/${AGENT_ID}/versions?after_version=0`);
    expect(res.status).toBe(400);
    expect(fake.listVersions).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist", async () => {
    const { app } = makeApp({
      agents: { listVersions: vi.fn().mockRejectedValue(new NotFoundError("agent not found")) },
    });
    const res = await get(app, `/v1/agents/${AGENT_ID}/versions`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/agents/:id/versions/:version (retrieve version)", () => {
  it("parses the version and returns it", async () => {
    const version = versionFixture({ version: 2 });
    const { app, fake } = makeApp({
      agents: { getVersion: vi.fn().mockResolvedValue(version) },
    });

    const res = await get(app, `/v1/agents/${AGENT_ID}/versions/2`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(version);
    expect(fake.getVersion).toHaveBeenCalledWith(CTX, AGENT_ID, 2);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["non-integer", "1.5"],
    ["non-numeric", "abc"],
  ])("rejects version %s with 400 without calling the service", async (_label, version) => {
    const { app, fake } = makeApp();
    const res = await get(app, `/v1/agents/${AGENT_ID}/versions/${version}`);
    expect(res.status).toBe(400);
    expect(fake.getVersion).not.toHaveBeenCalled();
  });

  it("returns 404 when the version does not exist", async () => {
    const { app } = makeApp({
      agents: { getVersion: vi.fn().mockRejectedValue(new NotFoundError("agent version not found")) },
    });
    const res = await get(app, `/v1/agents/${AGENT_ID}/versions/9`);
    expect(res.status).toBe(404);
  });
});
