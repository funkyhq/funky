// apps/api/src/app.ts
// The whole application, network-free. Tests: buildApp(deps) + app.request().
import { Hono } from "hono";
import type { AgentsService, AuthContext, EnvsService } from "@funky/configs";
import type { EventStore, SessionsService } from "@funky/sessions";
import { errorHandler, errorResponse } from "./http";
import { auth } from "./middleware/auth";
import { requestId } from "./middleware/request-id";
import { agentRoutes } from "./routes/agents";
import { envRoutes } from "./routes/environments";
import { sessionRoutes } from "./routes/sessions";
import type { EventBus } from "./sse";

export type AppDeps = {
  agents: AgentsService;
  envs: EnvsService;
  sessions: SessionsService;
  /** the append-only event log — the SSE stream re-reads from it on every wake */
  store: EventStore;
  /** the in-process LISTEN fan-out that wakes open SSE streams */
  bus: EventBus;
  /** null = auth disabled (dev only) */
  authToken: string | null;
  /** liveness of the DB, e.g. () => pool.query("SELECT 1") */
  ping: () => Promise<unknown>;
};

type Env = { Variables: { auth: AuthContext; requestId: string } };

export function buildApp(deps: AppDeps) {
  const app = new Hono<Env>();

  app.use(requestId());

  // Unauthenticated by design (probes and load balancers). `/healthz` remains as a
  // compatibility alias for existing deployments while `/health` avoids platforms that
  // reserve or intercept the conventional probe path.
  const health = async () => {
    await deps.ping();
    return { status: "ok" as const };
  };
  app.get("/health", async (c) => c.json(await health()));
  app.get("/healthz", async (c) => c.json(await health()));

  app.use("/v1/*", auth(deps.authToken));
  app.route("/v1/agents", agentRoutes(deps.agents));
  app.route("/v1/environments", envRoutes(deps.envs));
  app.route(
    "/v1/sessions",
    sessionRoutes({ sessions: deps.sessions, store: deps.store, bus: deps.bus }),
  );

  app.notFound((c) => errorResponse(c, 404, "not_found_error", "unknown route"));
  app.onError(errorHandler);

  return app;
}
