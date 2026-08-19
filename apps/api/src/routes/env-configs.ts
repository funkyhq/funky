// apps/api/src/routes/env-configs.ts
// The env-config resource — write-once sandbox recipes. Thin: validate
// the core request shape → Store call → status code; the core schemas
// ARE the wire format, so there is no HTTP-side translation layer.
//
// Write-once is structural, not policy: the Store port exposes no
// update, archive, delete, or list for config rows, so the resource has
// exactly two verbs. Sessions reference config ids; a row that could
// change under a running session would reinterpret its history.
//
// Namespace discipline: the wire schema OMITS namespace — a client can
// never choose one. The auth middleware decided it (c.get("namespace"));
// create stamps it, and get answers 404 for a foreign row, so a foreign
// id is indistinguishable from a nonexistent one.
import { Hono } from "hono";
import { CreateEnvConfigRequest } from "@funky/core";
import type { Store } from "@funky/agent";
import { errorResponse } from "../http";
import { validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type EnvConfigStore = Pick<Store, "createEnvConfig" | "getEnvConfig">;

type Env = { Variables: { requestId: string; namespace: string } };

const WireCreateEnvConfig = CreateEnvConfigRequest.omit({ namespace: true });

export function envConfigRoutes(store: EnvConfigStore) {
  const r = new Hono<Env>();

  // create → 201 with the materialized row: defaults are resolved at
  // create (network → unrestricted, packages → {}), so the caller sees
  // the decision that was stored, not the request they sent.
  r.post("/", validate("json", WireCreateEnvConfig), async (c) => {
    const id = await store.createEnvConfig({
      ...c.req.valid("json"),
      namespace: c.get("namespace"),
    });
    const config = await store.getEnvConfig(id);
    if (!config) throw new Error(`env config ${id} missing after create`);
    return c.json(config, 201);
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const config = await store.getEnvConfig(id);
    if (!config || config.namespace !== c.get("namespace")) {
      return errorResponse(c, 404, "not_found_error", `no env config ${id}`);
    }
    return c.json(config);
  });

  return r;
}
