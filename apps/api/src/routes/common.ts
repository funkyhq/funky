// apps/api/src/routes/common.ts
// The validate wrapper shared by every resource's route file: core zod
// schemas in, the error envelope out. Plus the collection reads' one
// pagination shape — the query the client sends and the envelope it
// gets back, written once so no two resources page differently.
import { zValidator } from "@hono/zod-validator";
import { type ZodType, z } from "zod";
import { errorResponse } from "../http";

export const validate = <T extends ZodType>(target: "json" | "query", schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
        .join("; ");
      return errorResponse(c, 400, "invalid_request_error", msg);
    }
  });

/** Page size when the caller doesn't ask, and the ceiling when it does. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * A list route's query. `limit` is bounded here rather than clamped
 * silently: an over-large page is a client mistake worth a 400, not a
 * request we quietly answer with something else. `after` is the id of
 * the previous page's last row — the cursor `page()` hands back.
 */
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  after: z.string().min(1).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * The list envelope. Routes over-fetch by one row — `rows` is a page of
 * `limit + 1` — and that extra row IS `hasMore`: no count query, no
 * second round trip, and the client never has to guess from a short
 * page. `lastId` is what to send as the next `after`; it is absent on an
 * empty page, because absence has one spelling (core/store.ts).
 */
export function page<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return {
    data,
    hasMore: rows.length > limit,
    ...(last === undefined ? {} : { lastId: last.id }),
  };
}
