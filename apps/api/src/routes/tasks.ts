// apps/api/src/routes/tasks.ts
// The tasks resource — work handed to an agent config. Creating one is
// "create a session and send it a first message" committed together
// (Store.createTask), so a failure never leaves an empty session. The
// session it starts is an ordinary one: follow-ups, entries, usage, and
// archive all live under /v1/sessions/:sessionId.
//
// Cancel addresses the task, and today that means its session's run: a
// task starts the moment it is created, so it always has a session to
// forward the cancel to. (A task that waits before starting arrives with
// deferral, and so does cancelling one before it starts.)
//
// Namespace rides in the create body and as ?namespace= everywhere else,
// exactly as on sessions (common.ts NamespaceQuery).
import { Hono } from "hono";
import { CreateTaskRequest, type Task } from "@funky/core";
import { ArchivedError, type Store } from "@funky/agent";
import { errorResponse } from "../http";
import { NamespaceQuery, validate, WireContent } from "./common";

/** The slice of the harness Store this resource needs. */
export type TaskStore = Pick<Store, "createTask" | "getTask" | "requestCancel">;

type Env = { Variables: { requestId: string } };

// The core request, with the namespace defaulted and the content
// accepting a plain string, as a session message's does.
const CreateTaskBody = CreateTaskRequest.extend({
  ...NamespaceQuery.shape,
  content: WireContent,
});

/** Store row → wire resource: the ref's qualified id becomes `id`. */
const wire = ({ taskId, ...rest }: Task) => ({ id: taskId, ...rest });

export function taskRoutes(store: TaskStore) {
  const r = new Hono<Env>();

  r.post("/", validate("json", CreateTaskBody), async (c) => {
    let task: Task | undefined;
    try {
      const ref = await store.createTask(c.req.valid("json"));
      task = await store.getTask(ref);
      if (!task) throw new Error(`task ${ref.taskId} missing after create`);
    } catch (err) {
      // The same verdicts as creating a session: an archived config is a
      // conflict with its terminal state, and a dangling or foreign one
      // is the same "unknown".
      if (err instanceof ArchivedError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      if (err instanceof Error && err.message.startsWith("unknown ")) {
        return errorResponse(c, 400, "invalid_request_error", err.message);
      }
      throw err;
    }
    return c.json(wire(task), 201);
  });

  r.get("/:id", validate("query", NamespaceQuery), async (c) => {
    const task = await store.getTask({
      namespace: c.req.valid("query").namespace,
      taskId: c.req.param("id"),
    });
    if (!task) return notFound(c);
    return c.json(wire(task));
  });

  // Accepted, not completed: the cancel lands in the session's log, and
  // the worker answers it at its next step boundary.
  r.post("/:id/cancel", validate("query", NamespaceQuery), async (c) => {
    const { namespace } = c.req.valid("query");
    const task = await store.getTask({ namespace, taskId: c.req.param("id") });
    if (!task) return notFound(c);
    try {
      await store.requestCancel({ namespace, sessionId: task.sessionId });
      return c.body(null, 202);
    } catch (err) {
      if (err instanceof ArchivedError) {
        return errorResponse(c, 409, "conflict_error", err.message);
      }
      throw err;
    }
  });

  function notFound(c: Parameters<typeof errorResponse>[0]) {
    return errorResponse(c, 404, "not_found_error", "no such task");
  }

  return r;
}
