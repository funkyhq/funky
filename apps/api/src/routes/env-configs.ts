// apps/api/src/routes/env-configs.ts
// The env-config resource — sandbox recipes updated in place. Thin: validate
// the core request shape → Store call → status code; the core schemas
// ARE the wire format, so there is no HTTP-side translation layer.
import { Hono } from "hono";
import { CreateEnvConfigRequest, UpdateEnvConfigRequest } from "@funky/core";
import type { Store } from "@funky/agent";
import { errorResponse } from "../http";
import { ListQuery, page, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type EnvConfigStore = Pick<
  Store,
  "createEnvConfig" | "getEnvConfig" | "updateEnvConfig" | "listEnvConfigs"
>;

type Env = { Variables: { requestId: string; namespace: string } };

export function envConfigRoutes(store: EnvConfigStore) {
  const r = new Hono<Env>();

  // create → 201 with the materialized row: defaults are resolved at
  // create (network → unrestricted, packages → {}), so the caller sees
  // the decision that was stored, not the request they sent.
  r.post("/", validate("json", CreateEnvConfigRequest), async (c) => {
    const ref = await store.createEnvConfig(c.req.valid("json"));
    const config = await store.getEnvConfig(ref);
    if (!config) throw new Error(`env config ${ref.id} missing after create`);
    return c.json(config, 201);
  });

  // list → one page of this namespace's rows, newest first. The store
  // is asked for limit + 1: the extra row is hasMore (see page()).
  r.get("/", validate("query", ListQuery), async (c) => {
    const { limit, after } = c.req.valid("query");
    try {
      const rows = await store.listEnvConfigs({
        namespace: c.get("namespace"),
        limit: limit + 1,
        after,
      });
      return c.json(page(rows, limit));
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

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const config = await store.getEnvConfig({ namespace: c.get("namespace"), id });
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(config);
  });

  r.post("/:id", validate("json", UpdateEnvConfigRequest), async (c) => {
    const id = c.req.param("id");
    const config = await store.updateEnvConfig(
      { namespace: c.get("namespace"), id },
      c.req.valid("json"),
    );
    if (!config) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(config);
  });

  return r;
}
