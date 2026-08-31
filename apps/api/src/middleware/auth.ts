// apps/api/src/middleware/auth.ts
// Static bearer auth, nothing else. The token is a root credential: its
// holder — the managed gateway, or a self-deploy operator — can address
// every namespace, and says which one each request means IN the request
// (create bodies carry it; id-addressed routes take ?namespace=).
// Tenant authorization is the managed layer's job, above this api.
import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { errorResponse } from "../http";

/** token === null means FUNKY_AUTH=disabled (dev only; config.ts already warned). */
export const auth = (token: string | null) =>
  createMiddleware(async (c, next) => {
    if (token !== null) {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEq(presented, token)) {
        return errorResponse(c, 401, "authentication_error", "invalid or missing bearer token");
      }
    }
    await next();
  });

// Hash both sides to equalize length; timingSafeEqual requires equal-length buffers.
function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
