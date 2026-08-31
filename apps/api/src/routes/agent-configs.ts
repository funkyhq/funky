// apps/api/src/routes/agent-configs.ts
// The agent-config resource — versioned behavior recipes (inference +
// system prompt). Updates follow UpdateAgent semantics: partial
// replacement and an optional version precondition for optimistic
// concurrency. Archive follows ArchiveAgent semantics: the terminal
// state, with no route back.
//
// Namespace is part of the request (this api's caller holds the root
// token; the managed layer above does tenant authorization): the create
// body carries it — the core request schema IS the wire shape — and
// every other route takes ?namespace=, defaulting for single-tenant
// self-deploys (see common.ts NamespaceQuery).
import { Hono } from "hono";
import { type AgentConfig, CreateAgentConfigRequest, UpdateAgentConfigRequest } from "@funky/core";
import { ArchivedError, type Store, VersionConflictError } from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, NamespaceQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type AgentConfigStore = Pick<
  Store,
  | "createAgentConfig"
  | "getAgentConfig"
  | "listAgentConfigs"
  | "updateAgentConfig"
  | "archiveAgentConfig"
>;

type Env = { Variables: { requestId: string } };

// The core request, with the body's namespace defaulted the same way
// the query's is (common.ts NamespaceQuery).
const CreateAgentConfigBody = CreateAgentConfigRequest.extend(NamespaceQuery.shape);

/** Store row → wire resource: the ref's qualified id becomes the
 *  resource's `id`; everything else — namespace included — rides
 *  through to the trusted caller. */
const wire = ({ agentConfigId, ...rest }: AgentConfig) => ({ id: agentConfigId, ...rest });

export function agentConfigRoutes(store: AgentConfigStore) {
  const r = new Hono<Env>();

  r.post("/", validate("json", CreateAgentConfigBody), async (c) => {
    const ref = await store.createAgentConfig(c.req.valid("json"));
    const config = await store.getAgentConfig(ref);
    if (!config) throw new Error(`agent config ${ref.agentConfigId} missing after create`);
    return c.json(wire(config), 201);
  });

  // list → one page of this namespace's rows, newest first. The store
  // is asked for limit + 1: the extra row is hasMore (see page()).
  r.get("/", validate("query", ListQuery), async (c) => {
    const { namespace, limit, after } = c.req.valid("query");
    try {
      const rows = await store.listAgentConfigs({ namespace, limit: limit + 1, after });
      return c.json(page(rows.map(wire), limit));
    } catch (err) {
      // A cursor the store can't resolve — foreign or made-up, the same
      // "unknown" either way — is the client's mistake, so 400 not 500.
      if (err instanceof Error && err.message.startsWith("unknown cursor")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
  });

  r.get("/:id", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.getAgentConfig({ namespace, agentConfigId: id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(wire(config));
  });

  r.post(
    "/:id",
    validate("query", NamespaceQuery),
    validate("json", UpdateAgentConfigRequest),
    async (c) => {
      const id = c.req.param("id");
      const { namespace } = c.req.valid("query");
      try {
        const config = await store.updateAgentConfig(
          { namespace, agentConfigId: id },
          c.req.valid("json"),
        );
        if (config === undefined) {
          return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
        }
        return c.json(wire(config));
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
    },
  );

  // archive → the terminal state. No body (there is nothing to say but
  // "retire this"), and no unarchive route, here or ever. Idempotent by
  // consequence: a second archive answers 200 with the first one's
  // archivedAt, because the state it asks for is already the state.
  r.post("/:id/archive", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.archiveAgentConfig({ namespace, agentConfigId: id });
    if (config === undefined) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(wire(config));
  });

  return r;
}
