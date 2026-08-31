// apps/api/src/routes/common.ts
// The validate wrapper shared by every resource's route file: core zod
// schemas in, the error envelope out. Plus the collection reads' one
// pagination shape — the query the client sends and the envelope it
// gets back, written once so no two resources page differently.
import { zValidator } from "@hono/zod-validator";
import { type ZodType, z } from "zod";
import { DEFAULT_NAMESPACE } from "@funky/core";
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

/**
 * The namespace is part of the request (the caller holds the root token
 * and says which tenant it means): create bodies carry it in the body,
 * every id-addressed or list route as a query parameter. In both spots
 * absence resolves to DEFAULT_NAMESPACE — the single-tenant self-deploy
 * convenience the core comment blesses as "the api gateway's job"; the
 * store itself always receives it explicitly. This object is that one
 * spelling: routes validate it as a query, and create bodies extend the
 * core request with its shape so the same default applies.
 *
 * The format bound is load-bearing, not taste: namespace is a component
 * of every table's primary key, and an unbounded string overflows the
 * btree tuple limit — a 500 where a 400 belongs.
 */
export const NamespaceQuery = z.object({
  namespace: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "1-64 characters: letters, digits, _ and -")
    .default(DEFAULT_NAMESPACE),
});
export type NamespaceQuery = z.infer<typeof NamespaceQuery>;

/** Page size when the caller doesn't ask, and the ceiling when it does. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * A list route's query. `limit` is bounded here rather than clamped
 * silently: an over-large page is a client mistake worth a 400, not a
 * request we quietly answer with something else. `after` is the id of
 * the previous page's last row — the cursor `page()` hands back.
 */
export const ListQuery = NamespaceQuery.extend({
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
