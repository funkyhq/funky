// apps/api/src/middleware/auth.ts
// Static bearer auth + the namespace decision, in one middleware because
// the header source is only trustworthy AFTER authentication: the
// managed gateway holds this api's token privately and injects
// X-Funky-Namespace per authenticated user. An OSS deployment runs
// source "static" and every request is DEFAULT_NAMESPACE. Routes read
// the decision from c.get("namespace") and never from the request body.
import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { DEFAULT_NAMESPACE } from "@funky/core";
import type { NamespaceSource } from "../config";
import { errorResponse } from "../http";

const VALID_NAMESPACE = /^[A-Za-z0-9_-]{1,64}$/;

/** token === null means FUNKY_AUTH=disabled (dev only; config.ts already warned). */
export const auth = (token: string | null, namespaceSource: NamespaceSource) =>
  createMiddleware(async (c, next) => {
    if (token !== null) {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEq(presented, token)) {
        return errorResponse(c, 401, "authentication_error", "invalid or missing bearer token");
      }
    }

    if (namespaceSource === "static") {
      c.set("namespace", DEFAULT_NAMESPACE);
      await next();
      return;
    }

    const namespace = c.req.header("X-Funky-Namespace") ?? DEFAULT_NAMESPACE;
    if (!VALID_NAMESPACE.test(namespace)) {
      return errorResponse(c, 400, "invalid_request_error", "invalid X-Funky-Namespace");
    }
    c.set("namespace", namespace);
    await next();
  });

// Hash both sides to equalize length; timingSafeEqual requires equal-length buffers.
function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
