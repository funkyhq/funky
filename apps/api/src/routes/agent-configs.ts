// apps/api/src/routes/agent-configs.ts
// The agent-config resource — write-once behavior recipes (inference +
// system prompt), tenant-private like every config. Same shape as
// env-configs.ts: two verbs, core schemas as the wire format, the
// middleware's namespace stamped on create and checked on read.
import { Hono } from "hono";
import { CreateAgentConfigRequest } from "@funky/core";
import type { Store } from "@funky/agent";
import { errorResponse } from "../http";
import { validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type AgentConfigStore = Pick<Store, "createAgentConfig" | "getAgentConfig">;

type Env = { Variables: { requestId: string; namespace: string } };

const WireCreateAgentConfig = CreateAgentConfigRequest.omit({ namespace: true });

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

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const config = await store.getAgentConfig(id);
    if (!config || config.namespace !== c.get("namespace")) {
      return errorResponse(c, 404, "not_found_error", `no agent config ${id}`);
    }
    return c.json(config);
  });

  return r;
}
