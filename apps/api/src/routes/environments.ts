// apps/api/src/routes/environments.ts
// Thin: validate shapes → call service → status code. No Drizzle imports here, ever.
import { Hono } from "hono";
import { z } from "zod";
import type { AuthContext, EnvsService } from "@funky/configs";
import { listQuerySchema, metadataSchema, validate } from "./common";

type Env = { Variables: { auth: AuthContext; requestId: string } };

// ------------------------------------------------------------ zod schemas

// bare or wildcard-prefixed domain, no scheme, no path
const hostnameRegex =
  /^(\*\.)?[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*$/i;

const egressSchema = z
  .object({
    allow: z
      .array(z.string().max(255).regex(hostnameRegex, "must be a bare or wildcard-prefixed hostname"))
      .max(100),
  })
  .strict();

const createSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().min(1).max(256),
    description: z.string().max(2048).nullish(),
    metadata: metadataSchema.optional(),
    egress: egressSchema.optional(),
  })
  .strict();

const updateSchema = createSchema
  .omit({ id: true })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, "at least one field is required");

// ---------------------------------------------------------------- routes

export function envRoutes(envs: EnvsService) {
  const r = new Hono<Env>();

  // 1. create (client-supplied id → idempotent)
  r.post("/", validate("json", createSchema), async (c) => {
    const { environment, created } = await envs.create(c.get("auth"), c.req.valid("json"));
    return c.json(environment, created ? 201 : 200);
  });

  // 2. list
  r.get("/", validate("query", listQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const page = await envs.list(c.get("auth"), {
      limit: q.limit,
      afterId: q.after_id,
      includeArchived: q.include_archived,
    });
    return c.json(page);
  });

  // 3. retrieve
  r.get("/:id", async (c) => {
    return c.json(await envs.get(c.get("auth"), c.req.param("id")));
  });

  // 4. update (plain UPDATE — envs are not versioned)
  r.post("/:id", validate("json", updateSchema), async (c) => {
    return c.json(await envs.update(c.get("auth"), c.req.param("id"), c.req.valid("json")));
  });

  // 5. archive (idempotent, permanent)
  r.post("/:id/archive", async (c) => {
    return c.json(await envs.archive(c.get("auth"), c.req.param("id")));
  });

  // 6. hard delete (unlike agents — envs support both archive and delete)
  r.delete("/:id", async (c) => {
    await envs.delete(c.get("auth"), c.req.param("id"));
    return c.body(null, 204);
  });

  return r;
}
