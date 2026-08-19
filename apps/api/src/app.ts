// apps/api/src/app.ts
// The whole application, network-free. Tests: buildApp(deps) + app.request().
import { Hono } from "hono";
import type { Store } from "@funky/agent";
import type { NamespaceSource } from "./config";
import { errorHandler, errorResponse } from "./http";
import { auth } from "./middleware/auth";
import { requestId } from "./middleware/request-id";
import { envConfigRoutes } from "./routes/env-configs";

export type AppDeps = {
  /** the harness Store — each route narrows it to the slice it needs */
  store: Store;
  /** null = auth explicitly disabled (dev only) */
  authToken: string | null;
  /** "static" (OSS) or "header" (behind the managed gateway) */
  namespaceSource: NamespaceSource;
  /** liveness of the DB, e.g. () => pool.query("SELECT 1") */
  ping: () => Promise<unknown>;
};

type Env = { Variables: { requestId: string; namespace: string } };

export function buildApp(deps: AppDeps) {
  const app = new Hono<Env>();

  app.use(requestId());

  // Unauthenticated by design (probes and load balancers).
  app.get("/health", async (c) => {
    await deps.ping();
    return c.json({ status: "ok" as const });
  });

  app.use("/v1/*", auth(deps.authToken, deps.namespaceSource));
  app.route("/v1/env-configs", envConfigRoutes(deps.store));

  app.notFound((c) => errorResponse(c, 404, "not_found_error", "unknown route"));
  app.onError(errorHandler);

  return app;
}
