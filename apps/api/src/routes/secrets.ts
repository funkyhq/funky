// apps/api/src/routes/secrets.ts
// The secrets resource — keys a namespace stores once, by name, for its
// agents to use without the key riding in a config. Write-only from the
// outside: put stores a value, list names what is stored, delete removes
// one, and no route ever answers with a value (the worker reads them,
// through the same SecretProvider, when it provisions a sandbox). The
// values live in the secret manager main.ts wires, never in the Store.
//
// Namespace is part of the request: every route takes ?namespace=,
// defaulting for single-tenant self-deploys (common.ts NamespaceQuery).
import { Hono } from "hono";
import { z } from "zod";
import { type SecretProvider, secretValueProblem } from "@funky/agent";
import { SecretName } from "@funky/core";
import { errorResponse } from "../http";
import { NamespaceQuery, validate } from "./common";

type Env = { Variables: { requestId: string } };

/** The name credentials refer to the key by (core SecretName). */
const SecretParam = z.object({ name: SecretName });

/** GCP Secret Manager's payload cap, so a later adapter can hold
 *  whatever this route accepts. Infisical holds it. */
const MAX_VALUE_BYTES = 64 * 1024;

// A value breaking the port's value rules is refused, not repaired: a
// stray space in a paste is the user's to see, not ours to trim
// silently. No message repeats the value.
const PutSecretBody = z.object({
  value: z
    .string()
    .min(1, "must not be empty")
    .refine((value) => Buffer.byteLength(value) <= MAX_VALUE_BYTES, {
      message: "must be at most 64 KiB",
    })
    .superRefine((value, ctx) => {
      const problem = secretValueProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
});

const NOT_CONFIGURED =
  'no secret store configured: set the INFISICAL_* variables (see the README, "Secrets")';

export function secretRoutes(secrets: SecretProvider | null) {
  const r = new Hono<Env>();

  // Without a secret store every route says so, rather than the
  // unknown-route 404 a missing resource would get.
  if (secrets === null) {
    r.all("*", (c) => errorResponse(c, 404, "not_found_error", NOT_CONFIGURED));
    return r;
  }

  // put → create or replace, last write wins. 200 either way: the port
  // doesn't say which it was, and the answer is the same resource.
  r.put(
    "/:name",
    validate("param", SecretParam),
    validate("query", NamespaceQuery),
    validate("json", PutSecretBody),
    async (c) => {
      const { name } = c.req.valid("param");
      const { namespace } = c.req.valid("query");
      return c.json(await secrets.put({ namespace, name }, c.req.valid("json").value));
    },
  );

  // list → every name in the namespace, sorted, without values. One
  // page: a namespace holds tens of keys, not thousands.
  r.get("/", validate("query", NamespaceQuery), async (c) => {
    const { namespace } = c.req.valid("query");
    return c.json({ data: await secrets.list(namespace) });
  });

  r.delete(
    "/:name",
    validate("param", SecretParam),
    validate("query", NamespaceQuery),
    async (c) => {
      const { name } = c.req.valid("param");
      const { namespace } = c.req.valid("query");
      if (!(await secrets.delete({ namespace, name }))) {
        return errorResponse(c, 404, "not_found_error", `no secret ${name}`);
      }
      return c.body(null, 204);
    },
  );

  return r;
}
