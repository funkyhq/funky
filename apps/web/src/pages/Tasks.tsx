// apps/web/src/pages/Tasks.tsx
// The Task section: the namespace's tasks, newest first, and the
// conversation behind any one of them.
//
// A task starts its session the moment it is created, so opening one IS
// opening that session: `#/task/<id>` reads the task to learn its session,
// then shows the session page (SessionDetail), where the log grows and
// follow-ups go. The console starts work only as tasks; a session created
// straight through the api runs fine but isn't listed here.
//
// No status column: a task has no state of its own. Whether its work is
// running is derived from its session's items and log, not stored on a row
// (see lib/api.ts Session).
import { useEffect, useRef, useState } from "react";
import { type Task, getTask, listTasks } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { ArrowLeftIcon, PlusIcon, RefreshIcon, TaskIcon } from "../components/Icons";
import type { PageProps } from "../nav";
import { CreateTask } from "./CreateTask";
import { SessionDetail } from "./SessionDetail";
import "./list.css";
import "./Tasks.css";

/** This section's own route. Rows link into it by id. */
const SECTION = "#/task";

/** The task as one line: its text, whitespace collapsed. A task given
 *  only images has no text to show, so it says what it has instead. */
function summary(task: Task): string {
  const text = task.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? "(image)" : text;
}

/**
 * `route` is the task id below this section. Keyed on it, so moving
 * between two tasks starts the second one clean rather than showing it the
 * first one's draft.
 */
export function Tasks({ route }: PageProps) {
  return route === "" ? <TaskList /> : <TaskDetail id={route} key={route} />;
}

/** One task's page: its session's, once the task says which that is. */
function TaskDetail({ id }: { id: string }) {
  const [sessionId, setSessionId] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    getTask(id, { signal: abort.signal }).then(
      (task) => setSessionId(task.sessionId),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setFailure(err instanceof Error ? err.message : String(err));
      },
    );
    return () => abort.abort();
  }, [id]);

  if (sessionId !== undefined) return <SessionDetail id={sessionId} taskId={id} />;
  return (
    <section className="chat">
      <header className="chat-head">
        <a className="btn chat-back" href={SECTION}>
          <ArrowLeftIcon />
          Tasks
        </a>
      </header>
      {failure === undefined ? null : (
        <div className="notice">
          <p className="notice-title">Couldn&rsquo;t load this task</p>
          <p className="notice-body">{failure}</p>
        </div>
      )}
    </section>
  );
}

function TaskList() {
  const { state, more, reload, loadMore } = useList<Task>(listTasks);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(RELATIVE_TICK_MS);
  const [creating, setCreating] = useState(false);
  // The header's New button, which every state of this page renders — and
  // where focus goes back to if what opened the dialog was the empty
  // state's button, since the row it creates replaces that button.
  const newButton = useRef<HTMLButtonElement>(null);

  /** A task just made, its session already running it. Creating one is how
   *  you get to the conversation, so this goes there rather than putting a
   *  row on a list the reader is about to leave. */
  function opened(task: Task) {
    setCreating(false);
    // An assignment, so Back returns to this list — the same history the
    // rows' own links write.
    window.location.hash = `${SECTION}/${task.id}`;
  }

  return (
    <section className="list tasks">
      <header className="list-head">
        <h1 className="list-title">Tasks</h1>
        <div className="list-actions">
          <button
            className="btn"
            type="button"
            onClick={reload}
            disabled={state.status === "loading"}
          >
            <RefreshIcon />
            Refresh
          </button>
          <button
            className="btn btn-primary"
            type="button"
            ref={newButton}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            New task
          </button>
        </div>
      </header>

      {state.status === "error" ? (
        <div className="notice">
          <p className="notice-title">Couldn&rsquo;t load tasks</p>
          <p className="notice-body">{state.message}</p>
          <button className="btn" type="button" onClick={reload}>
            <RefreshIcon />
            Try again
          </button>
        </div>
      ) : state.status === "ready" && state.items.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <TaskIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No tasks yet</p>
          <p className="notice-body">
            A task hands work to an agent config and starts a session running it. Create one here,
            or post the config&rsquo;s id and the task to <code>/v1/tasks</code>.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <PlusIcon />
            New task
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="col-task">Task</th>
                <th className="col-id">Id</th>
                <th className="col-when">Created</th>
              </tr>
            </thead>
            <tbody>
              {state.status === "loading"
                ? SKELETON.map((row) => (
                    <tr key={row}>
                      <td>
                        <span className="bar bar-task" />
                      </td>
                      <td>
                        <span className="bar bar-id" />
                      </td>
                      <td>
                        <span className="bar bar-when" />
                      </td>
                    </tr>
                  ))
                : state.items.map((task) => (
                    <tr key={task.id}>
                      <td>
                        {/* One real anchor, stretched over the row by CSS:
                            the whole row opens the conversation, and it is
                            still a link — focusable, middle-clickable,
                            copyable. */}
                        <a className="task-text row-link" href={`${SECTION}/${task.id}`}>
                          {summary(task)}
                        </a>
                      </td>
                      <td>
                        <span className="id">{task.id}</span>
                      </td>
                      <td>
                        <time dateTime={task.createdAt} title={absoluteTime(task.createdAt)}>
                          {relativeTime(task.createdAt, now)}
                        </time>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateTask onCreated={opened} onClose={() => setCreating(false)} returnFocus={newButton} />
      ) : null}

      {state.status === "ready" && state.hasMore ? (
        <div className="list-more">
          <button className="btn" type="button" onClick={loadMore} disabled={more.busy}>
            {more.busy ? "Loading…" : "Load more"}
          </button>
          {more.error ? <span className="list-more-error">{more.error}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
