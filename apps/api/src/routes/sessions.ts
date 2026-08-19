// apps/api/src/routes/sessions.ts
// The sessions resource — the intake half of the Store port, plus the
// inspection reads. Every route under /:id does the ownership check
// once at the top: a foreign session 404s exactly like a nonexistent
// one, so nothing leaks across namespaces.
//
// The api writes nothing itself: intake and requestCancel are the only
// mutations, both Store transactions. Whether a message starts a run or
// queues as a pending input is intake's in-transaction branch — the
// IntakeResult (started | queued) is returned verbatim, and both answer
// 202: the work itself happens in a worker, asynchronously.
import { Hono } from "hono";
import { z } from "zod";
import { CreateSessionRequest, UserMessage } from "@funky/core";
import type { Store } from "@funky/agent";
import { errorResponse } from "../http";
import { validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type SessionStore = Pick<
  Store,
  "createSession" | "getSession" | "intake" | "requestCancel" | "readEntries" | "listItems"
>;

type Env = { Variables: { requestId: string; namespace: string } };

const WireCreateSession = CreateSessionRequest.omit({ namespace: true });

// "Always an array; plain strings are normalized at intake"
// (core/messages.ts) — this is the intake boundary, so the wire accepts
// both spellings and the role is stamped, never sent.
const WireMessage = z.object({
  content: z.union([z.string(), UserMessage.shape.content]),
});

const EntriesQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});

export function sessionRoutes(store: SessionStore) {
  const r = new Hono<Env>();

  r.post("/", validate("json", WireCreateSession), async (c) => {
    let id: string;
    try {
      id = await store.createSession({ ...c.req.valid("json"), namespace: c.get("namespace") });
    } catch (err) {
      // The store's namespace-scoped existence check: a dangling config
      // ref and a foreign-namespace one throw the same "unknown".
      if (err instanceof Error && err.message.startsWith("unknown ")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
    const session = await store.getSession(id);
    if (!session) throw new Error(`session ${id} missing after create`);
    return c.json(session, 201);
  });

  r.get("/:id", async (c) => {
    const session = await owned(c);
    if (!session) return notFound(c);
    return c.json(session);
  });

  r.post("/:id/messages", validate("json", WireMessage), async (c) => {
    const session = await owned(c);
    if (!session) return notFound(c);
    const { content } = c.req.valid("json");
    const message: UserMessage = {
      role: "user",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    };
    return c.json(await store.intake(session.id, message), 202);
  });

  r.post("/:id/cancel", async (c) => {
    const session = await owned(c);
    if (!session) return notFound(c);
    // Appends a control entry; the worker answers it at a step boundary,
    // so cancellation is accepted here, not completed.
    await store.requestCancel(session.id);
    return c.body(null, 202);
  });

  r.get("/:id/entries", validate("query", EntriesQuery), async (c) => {
    const session = await owned(c);
    if (!session) return notFound(c);
    return c.json(await store.readEntries(session.id, c.req.valid("query").after));
  });

  r.get("/:id/items", async (c) => {
    const session = await owned(c);
    if (!session) return notFound(c);
    return c.json(await store.listItems(session.id));
  });

  /** The one ownership check: undefined for unknown AND foreign rows. */
  async function owned(c: { req: { param(k: "id"): string }; get(k: "namespace"): string }) {
    const session = await store.getSession(c.req.param("id"));
    if (!session || session.namespace !== c.get("namespace")) return undefined;
    return session;
  }

  function notFound(c: Parameters<typeof errorResponse>[0]) {
    return errorResponse(c, 404, "not_found_error", "no such session");
  }

  return r;
}
