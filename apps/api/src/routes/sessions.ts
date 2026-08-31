// apps/api/src/routes/sessions.ts
// The sessions resource — the intake half of the Store port, plus the
// inspection reads. Every route under /:id resolves ownership once at
// the top with a namespace-scoped get: the store answers a foreign
// session exactly like a nonexistent one, so no route compares
// namespaces by hand. The row the get returns is its own SessionRef, so
// it addresses every later call.
//
// Namespace is part of the request (the caller holds the root token;
// tenant authorization lives in the managed layer above): the create
// body carries it — the core request schema IS the wire shape — and
// every id-addressed route takes ?namespace=, defaulting for
// single-tenant self-deploys (common.ts NamespaceQuery).
//
// The api writes nothing itself: intake and requestCancel are the only
// mutations, both Store transactions. Whether a message starts a run or
// queues as a pending input is intake's in-transaction branch — the
// IntakeResult (started | queued) is returned verbatim, and both answer
// 202: the work itself happens in a worker, asynchronously.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CreateSessionRequest, type Session, UserMessage, type WorkItem } from "@funky/core";
import { ArchivedError, type Store } from "@funky/agent";
import { errorResponse } from "../http";
import { NamespaceQuery, validate } from "./common";

/** The slice of the harness Store this resource needs. */
export type SessionStore = Pick<
  Store,
  "createSession" | "getSession" | "intake" | "requestCancel" | "readEntries" | "listItems"
>;

/** SSE tail pacing — from config in production, shrunk by tests. */
export type StreamPacing = {
  /** delay between entries-cursor polls */
  pollMs: number;
  /** quiet time before a keep-alive comment (defeats idle proxy timeouts) */
  heartbeatMs: number;
};

type Env = { Variables: { requestId: string } };

// The core request, with the body's namespace defaulted the same way
// the query's is (common.ts NamespaceQuery).
const CreateSessionBody = CreateSessionRequest.extend(NamespaceQuery.shape);

/** Store row → wire resource: the ref's qualified id becomes the
 *  resource's `id`; everything else — namespace included — rides
 *  through to the trusted caller. */
const wire = ({ sessionId, ...rest }: Session) => ({ id: sessionId, ...rest });

/** Same rule for items: the row, with its own qualified id as `id`. */
const wireItem = ({ itemId, ...rest }: WorkItem) => ({ id: itemId, ...rest });

// "Always an array; plain strings are normalized at intake"
// (core/messages.ts) — this is the intake boundary, so the wire accepts
// both spellings and the role is stamped, never sent.
const WireMessage = z.object({
  content: z.union([z.string(), UserMessage.shape.content]),
});

const EntriesQuery = NamespaceQuery.extend({
  after: z.coerce.number().int().nonnegative().optional(),
});

export function sessionRoutes(store: SessionStore, pacing: StreamPacing) {
  const r = new Hono<Env>();

  r.post("/", validate("json", CreateSessionBody), async (c) => {
    let session: Session | undefined;
    try {
      const ref = await store.createSession(c.req.valid("json"));
      session = await store.getSession(ref);
      if (!session) throw new Error(`session ${ref.sessionId} missing after create`);
    } catch (err) {
      // An archived config exists and is readable — it just cannot be
      // referenced by anything new. That is a conflict with its terminal
      // state (409), not a malformed request (400).
      if (err instanceof ArchivedError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      // The store's namespace-scoped existence check: a dangling config
      // ref and a foreign-namespace one throw the same "unknown".
      if (err instanceof Error && err.message.startsWith("unknown ")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
    return c.json(wire(session), 201);
  });

  r.get("/:id", validate("query", NamespaceQuery), async (c) => {
    const session = await owned(c, c.req.valid("query").namespace);
    if (!session) return notFound(c);
    return c.json(wire(session));
  });

  r.post(
    "/:id/messages",
    validate("query", NamespaceQuery),
    validate("json", WireMessage),
    async (c) => {
      const session = await owned(c, c.req.valid("query").namespace);
      if (!session) return notFound(c);
      const { content } = c.req.valid("json");
      const message: UserMessage = {
        role: "user",
        content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      };
      return c.json(await store.intake(session, message), 202);
    },
  );

  r.post("/:id/cancel", validate("query", NamespaceQuery), async (c) => {
    const session = await owned(c, c.req.valid("query").namespace);
    if (!session) return notFound(c);
    // Appends a control entry; the worker answers it at a step boundary,
    // so cancellation is accepted here, not completed.
    await store.requestCancel(session);
    return c.body(null, 202);
  });

  r.get("/:id/entries", validate("query", EntriesQuery), async (c) => {
    const session = await owned(c, c.req.valid("query").namespace);
    if (!session) return notFound(c);
    return c.json(await store.readEntries(session, c.req.valid("query").after));
  });

  r.get("/:id/items", validate("query", NamespaceQuery), async (c) => {
    const session = await owned(c, c.req.valid("query").namespace);
    if (!session) return notFound(c);
    return c.json((await store.listItems(session)).map(wireItem));
  });

  // The entries read, delivered incrementally: replay past the cursor,
  // then tail by re-polling it. Each event is `id: <seq>` + `data:
  // <entry JSON>` — the same objects GET /entries returns, unnamed so a
  // plain EventSource onmessage sees everything and `data.type`
  // discriminates. `id: seq` makes resume SSE-native: an auto-reconnect
  // sends Last-Event-ID, honored over ?after=. This is the truth lane
  // only — committed entries, message granularity; the lossy delta fast
  // lane (DeltaSink) is a later, additive event type on this same
  // stream. Polling, not LISTEN/NOTIFY, by ratified decision: a
  // Notifier would change latency inside this loop, never the wire.
  //
  // The stream has no server-side end — sessions don't terminate. The
  // client hangs up; `aborted` stops the loop.
  r.get("/:id/stream", validate("query", EntriesQuery), async (c) => {
    const session = await owned(c, c.req.valid("query").namespace);
    if (!session) return notFound(c);
    let after = c.req.valid("query").after;
    const lastEventId = c.req.header("Last-Event-ID");
    if (lastEventId !== undefined) {
      const resumed = EntriesQuery.shape.after.safeParse(lastEventId);
      if (!resumed.success) {
        return errorResponse(c, 400, "invalid_request_error", "malformed Last-Event-ID");
      }
      after = resumed.data;
    }
    return streamSSE(c, async (stream) => {
      let cursor = after;
      let quietSince = Date.now();
      while (!stream.aborted) {
        const entries = [...(await store.readEntries(session, cursor))].sort(
          (a, b) => a.seq - b.seq,
        );
        for (const entry of entries) {
          await stream.writeSSE({ id: String(entry.seq), data: JSON.stringify(entry) });
          cursor = entry.seq;
          quietSince = Date.now();
        }
        // Checked once per poll, so the heartbeat can run late by up to one
        // poll interval — config forbids a poll slower than the heartbeat,
        // which keeps that slack shorter than the schedule it pads.
        if (Date.now() - quietSince >= pacing.heartbeatMs) {
          await stream.write(": ping\n\n");
          quietSince = Date.now();
        }
        await stream.sleep(pacing.pollMs);
      }
    });
  });

  /** The one ownership check — a scoped get: the store answers undefined
   *  for unknown AND foreign rows, so nothing is compared by hand here. */
  async function owned(c: { req: { param(k: "id"): string } }, namespace: string) {
    return store.getSession({ namespace, sessionId: c.req.param("id") });
  }

  function notFound(c: Parameters<typeof errorResponse>[0]) {
    return errorResponse(c, 404, "not_found_error", "no such session");
  }

  return r;
}
