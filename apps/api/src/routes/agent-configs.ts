// apps/api/src/routes/agent-configs.ts
// The agent-config resource — versioned behavior recipes (inference +
// system prompt), tenant-private like every config. Updates follow
// UpdateAgent semantics: partial replacement and an optional version
// precondition for optimistic concurrency. Archive follows ArchiveAgent
// semantics: the terminal state, with no route back.
import { Hono } from "hono";
import { CreateAgentConfigRequest, UpdateAgentConfigRequest } from "@funky/core";
import { ArchivedError, type Store, VersionConflictError } from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type AgentConfigStore = Pick<
  Store,
  | "createAgentConfig"
  | "getAgentConfig"
  | "listAgentConfigs"
  | "updateAgentConfig"
  | "archiveAgentConfig"
>;

type Env = { Variables: { requestId: string; namespace: string } };

const WireCreateAgentConfig = CreateAgentConfigRequest.omit({ namespace: true });
const WireUpdateAgentConfig = UpdateAgentConfigRequest;

export function agentConfigRoutes(store: AgentConfigStore) {
  const r = new Hono<Env>();

  r.post("/", validate("json", WireCreateAgentConfig), async (c) => {
    const ref = await store.createAgentConfig({
      ...c.req.valid("json"),
      namespace: c.get("namespace"),
    });
    const config = await store.getAgentConfig(ref);
    if (!config) throw new Error(`agent config ${ref.id} missing after create`);
    return c.json(config, 201);
  });

  // list → one page of this namespace's rows, newest first. The store
  // is asked for limit + 1: the extra row is hasMore (see page()).
  r.get("/", validate("query", ListQuery), async (c) => {
    const { limit, after } = c.req.valid("query");
    try {
      const rows = await store.listAgentConfigs({
        namespace: c.get("namespace"),
        limit: limit + 1,
        after,
      });
      return c.json(page(rows, limit));
    } catch (err) {
      // A cursor the store can't resolve — foreign or made-up, the same
      // "unknown" either way — is the client's mistake, so 400 not 500.
      if (err instanceof Error && err.message.startsWith("unknown cursor")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const config = await store.getAgentConfig({ namespace: c.get("namespace"), id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(config);
  });

  r.post("/:id", validate("json", WireUpdateAgentConfig), async (c) => {
    const id = c.req.param("id");
    try {
      const config = await store.updateAgentConfig(
        { namespace: c.get("namespace"), id },
        c.req.valid("json"),
      );
      if (config === undefined) {
        return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
      }
      return c.json(config);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      // An archived config is read-only: the request conflicts with a
      // state it cannot leave, so 409 — the same shape as a stale
      // version, but nothing the client can retry into success.
      if (err instanceof ArchivedError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      throw err;
    }
  });

  // archive → the terminal state. No body (there is nothing to say but
  // "retire this"), and no unarchive route, here or ever. Idempotent by
  // consequence: a second archive answers 200 with the first one's
  // archivedAt, because the state it asks for is already the state.
  r.post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const config = await store.archiveAgentConfig({ namespace: c.get("namespace"), id });
    if (config === undefined) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(config);
  });

  return r;
}
