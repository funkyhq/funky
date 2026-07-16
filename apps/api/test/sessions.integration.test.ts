// End-to-end sessions behavior against a REAL Postgres (testcontainers), the worker NOT
// running. Drives the app via buildApp(deps) + app.request(), exactly as app.ts advertises.
// The two checks that a static-auth HTTP surface can't express — transactional atomicity
// (force a failure after the append) and cross-namespace isolation — call the service
// directly against the same database.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService, EnvsService, NotFoundError, type AuthContext } from "@funky/configs";
import { EventStore, JobQueue, SessionsService, makeEvent, textContent } from "@funky/sessions";
import { buildApp } from "../src/app";
import { EventBus } from "../src/sse";
import { startPg, type PgHarness } from "./pg";

const CTX: AuthContext = { namespace: "default", principal: "token:default" };
const OTHER: AuthContext = { namespace: "other", principal: "token:other" };

let pg: PgHarness;
let agents: AgentsService;
let envs: EnvsService;
let store: EventStore;
let queue: JobQueue;
let sessions: SessionsService;
let bus: EventBus;
let listenClient: Client;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  pg = await startPg();
  agents = new AgentsService(pg.db);
  envs = new EnvsService(pg.db);
  store = new EventStore(pg.db);
  queue = new JobQueue(pg.db);
  sessions = new SessionsService(pg.db, store, queue);

  listenClient = new Client({ connectionString: pg.uri });
  await listenClient.connect();
  bus = new EventBus(listenClient);
  await bus.start();

  app = buildApp({
    agents,
    envs,
    sessions,
    store,
    bus,
    authToken: null, // auth disabled → app.request needs no header
    ping: () => pg.pool.query("SELECT 1"),
  });
}, 120_000);

afterAll(async () => {
  await listenClient?.end();
  await pg?.stop();
});

beforeEach(() => pg.reset());

// --------------------------------------------------------------------- helpers

async function seedAgent(ctx: AuthContext = CTX): Promise<string> {
  const { agent } = await agents.create(ctx, {
    name: "cruncher",
    system_prompt: "You are a data analyst.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
  });
  return agent.id;
}

async function seedEnv(ctx: AuthContext = CTX): Promise<string> {
  const { environment } = await envs.create(ctx, { name: "env" });
  return environment.id;
}

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jobsFor(sessionId: string): Promise<{ kind: string; state: string }[]> {
  const { rows } = await pg.pool.query<{ kind: string; state: string }>(
    "select kind, state from turn_jobs where session_id = $1",
    [sessionId],
  );
  return rows;
}

// ==================================================================== create

describe("POST /v1/sessions", () => {
  it("creates a provisioning session and enqueues a provision job atomically", async () => {
    const [agentId, envId] = await Promise.all([seedAgent(), seedEnv()]);

    const res = await postJson("/v1/sessions", { agent: agentId, environment_id: envId });
    expect(res.status).toBe(201);
    const session = await res.json();

    expect(session).toMatchObject({
      type: "session",
      status: "provisioning",
      agent: { id: agentId, version: 1 },
      environment_id: envId,
      title: null,
      metadata: {},
      archived_at: null,
    });
    // internal columns are NEVER exposed
    expect(session).not.toHaveProperty("resolved_env");
    expect(session).not.toHaveProperty("sandbox_handle");

    const jobs = await jobsFor(session.id);
    expect(jobs).toEqual([{ kind: "provision", state: "queued" }]);
  });

  it("pins the concrete latest version when the agent is a bare id", async () => {
    const agentId = await seedAgent();
    // bump the agent to version 3 (each behavior change mints a version)
    await agents.update(CTX, agentId, { system_prompt: "v2" });
    await agents.update(CTX, agentId, { system_prompt: "v3" });
    const envId = await seedEnv();

    const res = await postJson("/v1/sessions", { agent: agentId, environment_id: envId });
    const session = await res.json();
    expect(session.agent).toEqual({ id: agentId, version: 3 });

    // the row stores the concrete number — not a "latest" pointer
    const { rows } = await pg.pool.query<{ agent_version: number }>(
      "select agent_version from sessions where id = $1",
      [session.id],
    );
    expect(rows[0]!.agent_version).toBe(3);
  });

  it("honors an explicit agent version", async () => {
    const agentId = await seedAgent();
    await agents.update(CTX, agentId, { system_prompt: "v2" });
    const envId = await seedEnv();

    const res = await postJson("/v1/sessions", {
      agent: { id: agentId, version: 1 },
      environment_id: envId,
    });
    expect((await res.json()).agent).toEqual({ id: agentId, version: 1 });
  });

  it("404s an unknown agent and 404s an unknown version", async () => {
    const envId = await seedEnv();
    const unknown = await postJson("/v1/sessions", { agent: randomUUID(), environment_id: envId });
    expect(unknown.status).toBe(404);

    const agentId = await seedAgent();
    const badVersion = await postJson("/v1/sessions", {
      agent: { id: agentId, version: 99 },
      environment_id: envId,
    });
    expect(badVersion.status).toBe(404);
  });

  it("409s an archived agent and an archived environment", async () => {
    const agentId = await seedAgent();
    const envId = await seedEnv();
    await agents.archive(CTX, agentId);
    const archivedAgent = await postJson("/v1/sessions", { agent: agentId, environment_id: envId });
    expect(archivedAgent.status).toBe(409);

    const agent2 = await seedAgent();
    const env2 = await seedEnv();
    await envs.archive(CTX, env2);
    const archivedEnv = await postJson("/v1/sessions", { agent: agent2, environment_id: env2 });
    expect(archivedEnv.status).toBe(409);
  });

  it("404s an agent that lives in another namespace", async () => {
    const foreignAgent = await seedAgent(OTHER); // exists, but not in "default"
    const envId = await seedEnv();
    const res = await postJson("/v1/sessions", { agent: foreignAgent, environment_id: envId });
    expect(res.status).toBe(404);
  });

  it("is idempotent for a repeated create with the same id and body", async () => {
    const [agentId, envId] = await Promise.all([seedAgent(), seedEnv()]);
    const id = randomUUID();
    const body = { id, agent: agentId, environment_id: envId };

    const first = await postJson("/v1/sessions", body);
    expect(first.status).toBe(201);
    const second = await postJson("/v1/sessions", body);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(id);

    // only ONE provision job — the replay did not enqueue a second
    expect(await jobsFor(id)).toEqual([{ kind: "provision", state: "queued" }]);

    // a different body on the same id → 409
    const conflict = await postJson("/v1/sessions", { ...body, title: "changed" });
    expect(conflict.status).toBe(409);
  });
});

// =================================================================== messages

describe("POST /v1/sessions/:id/messages", () => {
  async function createSession(): Promise<string> {
    const [agentId, envId] = await Promise.all([seedAgent(), seedEnv()]);
    const res = await postJson("/v1/sessions", { agent: agentId, environment_id: envId });
    return (await res.json()).id;
  }

  it("accepts a message while provisioning: 202, one user_message at seq 1, one turn job", async () => {
    const sid = await createSession();

    const res = await postJson(`/v1/sessions/${sid}/messages`, { content: "say hello" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ turn: "queued", seq: 1 });

    const events = await store.readEvents("default", sid);
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "user_message"]]);
    expect(events[0]!.payload).toEqual({ content: [{ type: "text", text: "say hello" }] });

    const kinds = (await jobsFor(sid)).map((j) => j.kind).sort();
    expect(kinds).toEqual(["provision", "turn"]);
  });

  it("409s a second message while a turn is already queued (one in-flight turn)", async () => {
    const sid = await createSession();
    expect((await postJson(`/v1/sessions/${sid}/messages`, { content: "first" })).status).toBe(202);

    const second = await postJson(`/v1/sessions/${sid}/messages`, { content: "second" });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatchObject({
      type: "invalid_request_error",
      message: "a turn is already in progress for this session",
    });

    // the rejected message left no trace
    const events = await store.readEvents("default", sid);
    expect(events).toHaveLength(1);
  });

  it("409s a message to an archived session", async () => {
    const sid = await createSession();
    await postJson(`/v1/sessions/${sid}/archive`, {});
    const res = await postJson(`/v1/sessions/${sid}/messages`, { content: "hi" });
    expect(res.status).toBe(409);
  });

  it("rolls back BOTH the event and the job if the enqueue fails (one transaction)", async () => {
    const sid = await createSession();
    // A service whose enqueue throws AFTER the append. If they weren't in one transaction,
    // the user_message would survive as a stuck message with no job.
    const poison = new SessionsService(pg.db, store, {
      hasActiveTurn: (ns: string, s: string, tx?: unknown) =>
        (queue.hasActiveTurn as (...a: unknown[]) => Promise<boolean>)(ns, s, tx),
      enqueue: async () => {
        throw new Error("boom after append");
      },
    } as unknown as JobQueue);

    await expect(poison.sendMessage(CTX, sid, "doomed")).rejects.toThrow("boom after append");

    expect(await store.readEvents("default", sid)).toEqual([]); // append rolled back
    expect((await jobsFor(sid)).some((j) => j.kind === "turn")).toBe(false); // no orphan job
  });
});

// ===================================================================== events

describe("GET /v1/sessions/:id/events", () => {
  async function sessionWithEvents(n: number): Promise<string> {
    const [agentId, envId] = await Promise.all([seedAgent(), seedEnv()]);
    const created = await (await postJson("/v1/sessions", { agent: agentId, environment_id: envId })).json();
    const sid = created.id;
    // Append events directly, as the worker would (bypassing the one-turn guard).
    for (let seq = 1; seq <= n; seq++) {
      const evt = makeEvent({ sessionId: sid, namespace: "default", seq }, "user_message", {
        content: textContent(`m${seq}`),
      });
      await store.appendEvent("default", sid, seq, evt);
    }
    return sid;
  }

  it("paginates with after_seq/limit and reports has_more + last_seq", async () => {
    const sid = await sessionWithEvents(5);

    const page1 = await (await app.request(`/v1/sessions/${sid}/events?limit=2`)).json();
    expect(page1.data.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(page1.has_more).toBe(true);
    expect(page1.last_seq).toBe(5);
    expect(page1.data[0]).toMatchObject({
      type: "user_message",
      seq: 1,
      session_id: sid,
      payload: { content: [{ type: "text", text: "m1" }] },
    });

    const page2 = await (await app.request(`/v1/sessions/${sid}/events?after_seq=2&limit=2`)).json();
    expect(page2.data.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);
    expect(page2.has_more).toBe(true);

    const page3 = await (await app.request(`/v1/sessions/${sid}/events?after_seq=4&limit=2`)).json();
    expect(page3.data.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect(page3.has_more).toBe(false);
    expect(page3.last_seq).toBe(5);
  });

  it("404s events for a session that does not exist", async () => {
    const res = await app.request(`/v1/sessions/${randomUUID()}/events`);
    expect(res.status).toBe(404);
  });
});

// ============================================================ namespace isolation

describe("namespace isolation", () => {
  it("a cross-namespace read is a 404, identical to a nonexistent session", async () => {
    const [agentId, envId] = await Promise.all([seedAgent(), seedEnv()]);
    const created = await (await postJson("/v1/sessions", { agent: agentId, environment_id: envId })).json();

    // same id, wrong namespace → not found
    await expect(sessions.get(OTHER, created.id)).rejects.toBeInstanceOf(NotFoundError);
    // a truly nonexistent id in the owning namespace → also not found (indistinguishable)
    await expect(sessions.get(CTX, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    // sanity: the owner can read it
    expect((await sessions.get(CTX, created.id)).id).toBe(created.id);
  });
});
