// packages/configs/src/service.test.ts
// Integration tests for AgentsService against in-process Postgres (PGlite)
// with the real migrations applied. No mocks: the service is mostly SQL, so
// mocking Drizzle would test nothing.
//
// One PGlite instance serves the whole file; each test isolates itself with a
// fresh namespace — the same mechanism that isolates tenants in production.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@funky/db";
import { ConflictError, NotFoundError } from "./errors";
import { AgentsService } from "./service";
import type { AuthContext, CreateAgentInput } from "./types";

const migrationsDir = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let client: PGlite;
let service: AgentsService;

beforeAll(async () => {
  client = new PGlite();
  for (const dir of readdirSync(migrationsDir).sort()) {
    await client.exec(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
  }
  // The PGlite drizzle instance is runtime-compatible with the node-postgres Db.
  service = new AgentsService(drizzle({ client }) as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

let nsSeq = 0;
function freshCtx(principal = "user:tester"): AuthContext {
  return { namespace: `test-ns-${++nsSeq}`, principal };
}

function baseInput(overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
  return {
    name: "support-bot",
    system_prompt: "You are a helpful support agent.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ create

describe("create", () => {
  it("creates an agent at version 1 with defaults applied", async () => {
    const ctx = freshCtx();
    const { agent, created } = await service.create(ctx, baseInput());

    expect(created).toBe(true);
    expect(agent).toMatchObject({
      type: "agent",
      name: "support-bot",
      description: null,
      metadata: {},
      version: 1,
      system_prompt: "You are a helpful support agent.",
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      tool_policy: {},
      archived_at: null,
    });
    expect(agent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(new Date(agent.created_at).getTime()).not.toBeNaN();
    expect(new Date(agent.updated_at).getTime()).not.toBeNaN();
  });

  it("honors a client-supplied id and records the creating principal on v1", async () => {
    const ctx = freshCtx("key:fk_live_a1b2");
    const id = uuidv7();
    const { agent } = await service.create(ctx, baseInput({ id }));

    expect(agent.id).toBe(id);
    const v1 = await service.getVersion(ctx, id, 1);
    expect(v1).toMatchObject({
      type: "agent_version",
      agent_id: id,
      version: 1,
      system_prompt: "You are a helpful support agent.",
      created_by: "key:fk_live_a1b2",
    });
  });

  it("is idempotent: replaying the same create returns created=false and mints no version", async () => {
    const ctx = freshCtx();
    const id = uuidv7();
    const input = baseInput({
      id,
      description: "handles refunds",
      metadata: { team: "support" },
      tool_policy: { allowed_tools: ["search"] },
    });

    const first = await service.create(ctx, input);
    const replay = await service.create(ctx, input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.agent).toEqual(first.agent);
    const versions = await service.listVersions(ctx, id, { limit: 10 });
    expect(versions.data).toHaveLength(1);
  });

  it("idempotency ignores json key order and treats omitted optionals as defaults", async () => {
    const ctx = freshCtx();
    const id = uuidv7();
    await service.create(
      ctx,
      baseInput({
        id,
        metadata: {},
        tool_policy: {},
        model: { provider: "anthropic", model: "claude-sonnet-5", maxTokens: 1024 },
      }),
    );

    const replay = await service.create(
      ctx,
      baseInput({
        id,
        // metadata / tool_policy omitted → same as the explicit {} above
        model: { maxTokens: 1024, model: "claude-sonnet-5", provider: "anthropic" },
      }),
    );
    expect(replay.created).toBe(false);
  });

  it("rejects a same-id create with a different configuration", async () => {
    const ctx = freshCtx();
    const id = uuidv7();
    await service.create(ctx, baseInput({ id }));

    await expect(
      service.create(ctx, baseInput({ id, system_prompt: "Different prompt." })),
    ).rejects.toBeInstanceOf(ConflictError);

    // the original is untouched
    const agent = await service.get(ctx, id);
    expect(agent.system_prompt).toBe("You are a helpful support agent.");
    expect(agent.version).toBe(1);
  });

  it("does not leak or adopt an id owned by another namespace", async () => {
    const ctxA = freshCtx();
    const ctxB = freshCtx();
    const id = uuidv7();
    await service.create(ctxA, baseInput({ id }));

    // the id PK is global, so tenant B's create must fail — never resolve idempotently
    await expect(service.create(ctxB, baseInput({ id }))).rejects.toThrow();
    await expect(service.get(ctxB, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.get(ctxA, id)).name).toBe("support-bot");
  });
});

// --------------------------------------------------------------------- get

describe("get", () => {
  it("throws NotFoundError for an unknown id", async () => {
    await expect(service.get(freshCtx(), uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for an agent that belongs to another namespace", async () => {
    const ctxA = freshCtx();
    const { agent } = await service.create(ctxA, baseInput());
    await expect(service.get(freshCtx(), agent.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// -------------------------------------------------------------------- list

describe("list", () => {
  it("returns agents newest-first and paginates with after_id", async () => {
    const ctx = freshCtx();
    const a = (await service.create(ctx, baseInput({ name: "a" }))).agent;
    const b = (await service.create(ctx, baseInput({ name: "b" }))).agent;
    const c = (await service.create(ctx, baseInput({ name: "c" }))).agent;

    const page1 = await service.list(ctx, { limit: 2, includeArchived: false });
    expect(page1.data.map((x) => x.id)).toEqual([c.id, b.id]);
    expect(page1.has_more).toBe(true);
    expect(page1.last_id).toBe(b.id);

    const page2 = await service.list(ctx, {
      limit: 2,
      afterId: page1.last_id,
      includeArchived: false,
    });
    expect(page2.data.map((x) => x.id)).toEqual([a.id]);
    expect(page2.has_more).toBe(false);
    expect(page2.last_id).toBe(a.id);
  });

  it("returns an empty page for an empty namespace", async () => {
    const page = await service.list(freshCtx(), { limit: 20, includeArchived: false });
    expect(page).toEqual({ data: [], has_more: false, last_id: undefined });
  });

  it("hides archived agents unless includeArchived is set", async () => {
    const ctx = freshCtx();
    const keep = (await service.create(ctx, baseInput({ name: "keep" }))).agent;
    const gone = (await service.create(ctx, baseInput({ name: "gone" }))).agent;
    await service.archive(ctx, gone.id);

    const visible = await service.list(ctx, { limit: 20, includeArchived: false });
    expect(visible.data.map((x) => x.id)).toEqual([keep.id]);

    const all = await service.list(ctx, { limit: 20, includeArchived: true });
    expect(all.data.map((x) => x.id).sort()).toEqual([keep.id, gone.id].sort());
  });

  it("never returns another namespace's agents", async () => {
    const ctxA = freshCtx();
    const ctxB = freshCtx();
    await service.create(ctxA, baseInput());
    const mine = (await service.create(ctxB, baseInput({ name: "mine" }))).agent;

    const page = await service.list(ctxB, { limit: 20, includeArchived: false });
    expect(page.data.map((x) => x.id)).toEqual([mine.id]);
  });
});

// ------------------------------------------------------------------ update

describe("update", () => {
  it("updates labels without minting a new version", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());

    const updated = await service.update(ctx, agent.id, {
      name: "renamed",
      description: "now with a description",
    });

    expect(updated.name).toBe("renamed");
    expect(updated.description).toBe("now with a description");
    expect(updated.version).toBe(1);
    const versions = await service.listVersions(ctx, agent.id, { limit: 10 });
    expect(versions.data).toHaveLength(1);
  });

  it("replaces metadata wholesale rather than merging", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(
      ctx,
      baseInput({ metadata: { team: "support", tier: "1" } }),
    );

    const updated = await service.update(ctx, agent.id, { metadata: { env: "prod" } });
    expect(updated.metadata).toEqual({ env: "prod" });
  });

  it("mints a new version on behavior change, carrying forward omitted behavior fields", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(
      ctx,
      baseInput({
        model: { provider: "anthropic", model: "claude-sonnet-5", temperature: 0.2 },
        tool_policy: { allowed_tools: ["search"] },
      }),
    );

    const updated = await service.update(ctx, agent.id, { system_prompt: "Be terse." });

    expect(updated.version).toBe(2);
    expect(updated.system_prompt).toBe("Be terse.");
    // untouched behavior fields carried forward from v1
    expect(updated.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      temperature: 0.2,
    });
    expect(updated.tool_policy).toEqual({ allowed_tools: ["search"] });

    // v1 is immutable history
    const v1 = await service.getVersion(ctx, agent.id, 1);
    expect(v1.system_prompt).toBe("You are a helpful support agent.");
  });

  it("applies label and behavior changes together with a single version bump", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());

    const updated = await service.update(ctx, agent.id, {
      name: "both",
      model: { provider: "openai", model: "gpt-5" },
    });

    expect(updated.name).toBe("both");
    expect(updated.version).toBe(2);
    expect(updated.model).toEqual({ provider: "openai", model: "gpt-5" });
    expect(updated.system_prompt).toBe("You are a helpful support agent.");
  });

  it("records the updating principal on the minted version", async () => {
    const alice = freshCtx("user:alice");
    const bob: AuthContext = { namespace: alice.namespace, principal: "user:bob" };
    const { agent } = await service.create(alice, baseInput());
    await service.update(bob, agent.id, { system_prompt: "v2 prompt" });

    expect((await service.getVersion(alice, agent.id, 1)).created_by).toBe("user:alice");
    expect((await service.getVersion(alice, agent.id, 2)).created_by).toBe("user:bob");
  });

  it("treats an empty patch as a no-op", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());
    await sleep(10);

    const updated = await service.update(ctx, agent.id, {});
    expect(updated.version).toBe(1);
    expect(updated.updated_at).toBe(agent.updated_at);
  });

  it("bumps updated_at on a real update", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());
    await sleep(10);

    const updated = await service.update(ctx, agent.id, { name: "later" });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
      new Date(agent.updated_at).getTime(),
    );
    expect(updated.created_at).toBe(agent.created_at);
  });

  it("throws NotFoundError for unknown ids and other namespaces", async () => {
    const ctxA = freshCtx();
    const { agent } = await service.create(ctxA, baseInput());

    await expect(service.update(ctxA, uuidv7(), { name: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.update(freshCtx(), agent.id, { name: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects updates to an archived agent", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());
    await service.archive(ctx, agent.id);

    await expect(service.update(ctx, agent.id, { name: "nope" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(service.update(ctx, agent.id, { system_prompt: "nope" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

// ----------------------------------------------------------------- archive

describe("archive", () => {
  it("archives an agent; it stays readable with archived_at set", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());

    const archived = await service.archive(ctx, agent.id);
    expect(archived.archived_at).not.toBeNull();
    expect(new Date(archived.archived_at!).getTime()).not.toBeNaN();

    // still retrievable directly, and its versions remain readable
    expect((await service.get(ctx, agent.id)).archived_at).toBe(archived.archived_at);
    expect((await service.getVersion(ctx, agent.id, 1)).version).toBe(1);
  });

  it("is idempotent: a second archive keeps the original timestamp", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());

    const first = await service.archive(ctx, agent.id);
    await sleep(10);
    const second = await service.archive(ctx, agent.id);
    expect(second.archived_at).toBe(first.archived_at);
  });

  it("throws NotFoundError for unknown ids and cannot archive across namespaces", async () => {
    const ctxA = freshCtx();
    const { agent } = await service.create(ctxA, baseInput());

    await expect(service.archive(ctxA, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.archive(freshCtx(), agent.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.get(ctxA, agent.id)).archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------- versions

describe("listVersions", () => {
  async function agentWithThreeVersions(ctx: AuthContext) {
    const { agent } = await service.create(ctx, baseInput({ system_prompt: "v1" }));
    await service.update(ctx, agent.id, { system_prompt: "v2" });
    await service.update(ctx, agent.id, { system_prompt: "v3" });
    return agent;
  }

  it("returns versions newest-first and paginates with after_version", async () => {
    const ctx = freshCtx();
    const agent = await agentWithThreeVersions(ctx);

    const page1 = await service.listVersions(ctx, agent.id, { limit: 2 });
    expect(page1.data.map((v) => v.version)).toEqual([3, 2]);
    expect(page1.data.map((v) => v.system_prompt)).toEqual(["v3", "v2"]);
    expect(page1.has_more).toBe(true);

    const page2 = await service.listVersions(ctx, agent.id, { limit: 2, afterVersion: 2 });
    expect(page2.data.map((v) => v.version)).toEqual([1]);
    expect(page2.has_more).toBe(false);
  });

  it("throws NotFoundError for unknown agents and other namespaces", async () => {
    const ctxA = freshCtx();
    const agent = await agentWithThreeVersions(ctxA);

    await expect(service.listVersions(ctxA, uuidv7(), { limit: 10 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.listVersions(freshCtx(), agent.id, { limit: 10 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("getVersion", () => {
  it("throws NotFoundError for a version that does not exist", async () => {
    const ctx = freshCtx();
    const { agent } = await service.create(ctx, baseInput());
    await expect(service.getVersion(ctx, agent.id, 99)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError across namespaces", async () => {
    const ctxA = freshCtx();
    const { agent } = await service.create(ctxA, baseInput());
    await expect(service.getVersion(freshCtx(), agent.id, 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});
