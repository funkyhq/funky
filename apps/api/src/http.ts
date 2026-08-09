// apps/api/src/http.ts
// Error envelope + the single place domain errors become HTTP.
import type { Context } from "hono";
import { ConflictError, NotFoundError } from "@funky/configs";

export type ErrorType =
  "invalid_request_error" | "authentication_error" | "not_found_error" | "api_error";

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

/** app.onError — maps domain errors; everything else is a logged 500. */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof NotFoundError) {
    return errorResponse(c, 404, "not_found_error", err.message);
  }
  if (err instanceof ConflictError) {
    // 409 carries invalid_request_error, matching the Anthropic envelope convention
    return errorResponse(c, 409, "invalid_request_error", err.message);
  }
  console.error(`[${c.get("requestId")}] unhandled:`, err);
  return errorResponse(c, 500, "api_error", "internal server error");
}
