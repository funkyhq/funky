// apps/api/src/app.ts
// The whole application, network-free. Tests: buildApp(deps) + app.request().
import { Hono } from "hono";
import type { Store } from "@funky/agent";
import { errorHandler, errorResponse } from "./http";
import { auth } from "./middleware/auth";
import { requestId } from "./middleware/request-id";
import { agentConfigRoutes } from "./routes/agent-configs";
import { envConfigRoutes } from "./routes/env-configs";
import { sessionRoutes, type StreamPacing } from "./routes/sessions";

export type AppDeps = {
  /** the harness Store — each route narrows it to the slice it needs */
  store: Store;
  /** null = auth explicitly disabled (dev only) */
  authToken: string | null;
  /** liveness of the DB, e.g. () => pool.query("SELECT 1") */
  ping: () => Promise<unknown>;
  /** SSE tail pacing for /sessions/:id/stream */
  stream: StreamPacing;
};

type Env = { Variables: { requestId: string } };

export function buildApp(deps: AppDeps) {
  const app = new Hono<Env>();

  app.use(requestId());

  // Unauthenticated by design (probes and load balancers).
  app.get("/health", async (c) => {
    await deps.ping();
    return c.json({ status: "ok" as const });
  });

  app.use("/v1/*", auth(deps.authToken));
  app.route("/v1/agent-configs", agentConfigRoutes(deps.store));
  app.route("/v1/env-configs", envConfigRoutes(deps.store));
  app.route("/v1/sessions", sessionRoutes(deps.store, deps.stream));

  app.notFound((c) => errorResponse(c, 404, "not_found_error", "unknown route"));
  app.onError(errorHandler);

  return app;
}
