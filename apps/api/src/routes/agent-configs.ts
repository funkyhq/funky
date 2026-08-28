// apps/api/src/routes/agent-configs.ts
// The agent-config resource — versioned behavior recipes (inference +
// system prompt), tenant-private like every config. Updates follow
// UpdateAgent semantics: partial replacement and an optional version
// precondition for optimistic concurrency.
import { Hono } from "hono";
import { CreateAgentConfigRequest, UpdateAgentConfigRequest } from "@funky/core";
import { type Store, VersionConflictError } from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type AgentConfigStore = Pick<
  Store,
  "createAgentConfig" | "getAgentConfig" | "listAgentConfigs" | "updateAgentConfig"
>;

type Env = { Variables: { requestId: string; namespace: string } };

const WireCreateAgentConfig = CreateAgentConfigRequest.omit({ namespace: true });
const WireUpdateAgentConfig = UpdateAgentConfigRequest.omit({ namespace: true });

export function agentConfigRoutes(store: AgentConfigStore) {
  const r = new Hono<Env>();

  r.post("/", validate("json", WireCreateAgentConfig), async (c) => {
    const id = await store.createAgentConfig({
      ...c.req.valid("json"),
      namespace: c.get("namespace"),
    });
    const config = await store.getAgentConfig(id);
    if (!config) throw new Error(`agent config ${id} missing after create`);
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
    const config = await store.getAgentConfig(id);
    if (!config || config.namespace !== c.get("namespace")) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(config);
  });

  r.post("/:id", validate("json", WireUpdateAgentConfig), async (c) => {
    const id = c.req.param("id");
    try {
      const config = await store.updateAgentConfig(id, {
        ...c.req.valid("json"),
        namespace: c.get("namespace"),
      });
      if (config === undefined) {
        return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
      }
      return c.json(config);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      throw err;
    }
  });

  return r;
}
