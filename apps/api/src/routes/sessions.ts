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
import { streamSSE } from "hono/streaming";
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

/** SSE tail pacing — from config in production, shrunk by tests. */
export type StreamPacing = {
  /** delay between entries-cursor polls */
  pollMs: number;
  /** quiet time before a keep-alive comment (defeats idle proxy timeouts) */
  heartbeatMs: number;
};

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

export function sessionRoutes(store: SessionStore, pacing: StreamPacing) {
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
    const session = await owned(c);
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
        const entries = [...(await store.readEntries(session.id, cursor))].sort(
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
