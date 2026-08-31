// apps/api/src/routes/env-configs.ts
// The env-config resource — sandbox recipes updated in place until archive,
// their terminal state. Thin:
// validate the request shape → Store call → wire row, where the wire
// mapping only renames the ref's qualified id to the resource's `id`.
// Namespace is part of the request: the create body carries it — the
// core request schema IS the wire shape — and the other routes take
// ?namespace= (see agent-configs.ts and common.ts NamespaceQuery).
import { Hono } from "hono";
import { CreateEnvConfigRequest, type EnvConfig, UpdateEnvConfigRequest } from "@funky/core";
import { ArchivedError, type Store } from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, NamespaceQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type EnvConfigStore = Pick<
  Store,
  "createEnvConfig" | "getEnvConfig" | "updateEnvConfig" | "archiveEnvConfig" | "listEnvConfigs"
>;

type Env = { Variables: { requestId: string } };

// The core request, with the body's namespace defaulted the same way
// the query's is (common.ts NamespaceQuery).
const CreateEnvConfigBody = CreateEnvConfigRequest.extend(NamespaceQuery.shape);

/** Store row → wire resource — see the header. */
const wire = ({ envConfigId, ...rest }: EnvConfig) => ({ id: envConfigId, ...rest });

export function envConfigRoutes(store: EnvConfigStore) {
  const r = new Hono<Env>();

  // create → 201 with the materialized row: defaults are resolved at
  // create (network → unrestricted, packages → {}), so the caller sees
  // the decision that was stored, not the request they sent.
  r.post("/", validate("json", CreateEnvConfigBody), async (c) => {
    const ref = await store.createEnvConfig(c.req.valid("json"));
    const config = await store.getEnvConfig(ref);
    if (!config) throw new Error(`env config ${ref.envConfigId} missing after create`);
    return c.json(wire(config), 201);
  });

  // list → one page of this namespace's rows, newest first. The store
  // is asked for limit + 1: the extra row is hasMore (see page()).
  r.get("/", validate("query", ListQuery), async (c) => {
    const { namespace, limit, after } = c.req.valid("query");
    try {
      const rows = await store.listEnvConfigs({ namespace, limit: limit + 1, after });
      return c.json(page(rows.map(wire), limit));
    } catch (err) {
      // The store resolves the cursor inside the namespace; a foreign
      // one is "unknown" exactly like a made-up one. Either way the
      // client sent it, so it is a 400, not a 500.
      if (err instanceof Error && err.message.startsWith("unknown cursor")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
  });

  r.get("/:id", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.getEnvConfig({ namespace, envConfigId: id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(wire(config));
  });

  r.post(
    "/:id",
    validate("query", NamespaceQuery),
    validate("json", UpdateEnvConfigRequest),
    async (c) => {
      const id = c.req.param("id");
      const { namespace } = c.req.valid("query");
      try {
        const config = await store.updateEnvConfig(
          { namespace, envConfigId: id },
          c.req.valid("json"),
        );
        if (!config) {
          return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
        }
        return c.json(wire(config));
      } catch (err) {
        if (err instanceof ArchivedError) {
          return errorResponse(c, 409, "conflict_error", err.message);
        }
        throw err;
      }
    },
  );

  // Archive retires the recipe without deleting it. With no unarchive,
  // repeating the transition is a 200 carrying the original archivedAt.
  r.post("/:id/archive", validate("query", NamespaceQuery), async (c) => {
    const id = c.req.param("id");
    const { namespace } = c.req.valid("query");
    const config = await store.archiveEnvConfig({ namespace, envConfigId: id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(wire(config));
  });

  return r;
}
