// apps/api/src/http.ts
// Error envelope + the single place errors become HTTP. Routes handle
// their own 404s (an absent row is domain data, not an exception);
// anything that reaches onError is a logged 500.
import type { Context } from "hono";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "not_found_error"
  | "conflict_error"
  | "api_error";

export function errorResponse(
  c: Context,
  status: 400 | 401 | 404 | 409 | 500,
  type: ErrorType,
  message: string,
) {
  return c.json(
    {
      type: "error" as const,
      error: { type, message },
      request_id: c.get("requestId") ?? "unknown",
    },
    status,
  );
}

/** app.onError — everything here is unexpected; log it, return a 500. */
export function errorHandler(err: Error, c: Context) {
  console.error(`[${c.get("requestId")}] unhandled:`, err);
  return errorResponse(c, 500, "api_error", "internal server error");
}
