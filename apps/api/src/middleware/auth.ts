// apps/api/src/middleware/auth.ts
// Static-token authenticator (the OSS implementation of the auth port).
// A trusted managed gateway can select the namespace after authenticating with this token.
import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AuthContext } from "@funky/configs";
import type { NamespaceSource } from "../config";
import { errorResponse } from "../http";

const STATIC_CONTEXT: AuthContext = { namespace: "default", principal: "token:default" };
const VALID_NAMESPACE = /^[A-Za-z0-9_-]{1,64}$/;

/** token === null means FUNKY_AUTH=disabled (dev only; config.ts already warned). */
export const auth = (token: string | null, namespaceSource: NamespaceSource) =>
  createMiddleware(async (c, next) => {
    if (token !== null) {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEq(presented, token)) {
        return errorResponse(c, 401, "authentication_error", "invalid or missing API token");
      }
    }

    if (namespaceSource === "static") {
      c.set("auth", STATIC_CONTEXT);
      await next();
      return;
    }

    const namespaceHeader = c.req.header("X-Funky-Namespace");
    const namespace = namespaceHeader ?? "default";
    if (!VALID_NAMESPACE.test(namespace)) {
      return errorResponse(c, 400, "invalid_request_error", "invalid X-Funky-Namespace");
    }

    c.set("auth", { namespace, principal: `token:${namespace}` });
    await next();
  });

// Hash both sides to equalize length; timingSafeEqual requires equal-length buffers.
function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
