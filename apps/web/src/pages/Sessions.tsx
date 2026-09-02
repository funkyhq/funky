// apps/web/src/pages/Sessions.tsx
// The Session section: the namespace's sessions, newest first, and the
// conversation behind any one of them.
//
// `#/session/<id>` is a PAGE rather than a dialog over the list, which is
// where this section parts company with the two config ones. A config is a
// form you open, change and close; a session is a place you stay, watching
// a log grow, so it takes the pane (see SessionDetail).
//
// "Status" here is the LIFECYCLE — active or archived — not liveness. There
// is no running/idle column because the api has no such field: funky
// derives whether a session is working from its work items and its log
// rather than storing it on the row (see lib/api.ts Session).
import { useRef, useState } from "react";
import { type Session, listSessions } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { type FetchPage, SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { PlusIcon, RefreshIcon, SessionIcon } from "../components/Icons";
import { Status } from "../components/Status";
import { SESSION_STATUS } from "../lib/status";
import type { PageProps } from "../nav";
import { CreateSession } from "./CreateSession";
import { SessionDetail } from "./SessionDetail";
import "./list.css";
import "./Sessions.css";

/** This section's own route. Rows link into it by id. */
const SECTION = "#/session";

/**
 * The api hides archived sessions unless asked; this list asks. Archive is
 * a state this table has a whole column for, and a status column whose
 * every row reads "Active" is a column that says nothing. The unbounded
 * growth that default guards against is a page-size problem, and this list
 * is a keyset walk — it shows twenty rows either way.
 *
 * Module-level so it is stable: useList holds it as an effect dependency,
 * and a function rebuilt each render would re-fetch on every one.
 */
const listAll: FetchPage<Session> = (opts) => listSessions({ ...opts, includeArchived: true });

/**
 * `route` is the session id below this section. Keyed on it, so moving
 * between two conversations starts the second one clean rather than
 * showing it the first one's draft.
 */
export function Sessions({ route }: PageProps) {
  return route === "" ? <SessionList /> : <SessionDetail id={route} key={route} />;
}

function SessionList() {
  const { state, more, reload, loadMore } = useList<Session>(listAll);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(RELATIVE_TICK_MS);
  const [creating, setCreating] = useState(false);
  // The header's Start button, which every state of this page renders — and
  // where focus goes back to if what opened the dialog was the empty
  // state's button, since the row it creates replaces that button.
  const startButton = useRef<HTMLButtonElement>(null);

  /** A session just made, with its first message already sent. Creating one
   *  is how you get to the conversation, so this goes there rather than
   *  putting a row on a list the reader is about to leave. */
  function opened(session: Session) {
    setCreating(false);
    // An assignment, so Back returns to this list — the same history the
    // rows' own links write.
    window.location.hash = `${SECTION}/${session.id}`;
  }

  return (
    <section className="list sessions">
      <header className="list-head">
        <h1 className="list-title">Sessions</h1>
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
            ref={startButton}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            Start
          </button>
        </div>
      </header>

      {state.status === "error" ? (
        <div className="notice">
          <p className="notice-title">Couldn&rsquo;t load sessions</p>
          <p className="notice-body">{state.message}</p>
          <button className="btn" type="button" onClick={reload}>
            <RefreshIcon />
            Try again
          </button>
        </div>
      ) : state.status === "ready" && state.items.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <SessionIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No sessions yet</p>
          <p className="notice-body">
            A session pairs an agent config with an env config and runs them against an append-only
            log. Start one here, or post both ids to <code>/v1/sessions</code>.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <PlusIcon />
            Start session
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="col-id">Id</th>
                <th className="col-status">Status</th>
                <th className="col-when">Created</th>
              </tr>
            </thead>
            <tbody>
              {state.status === "loading"
                ? SKELETON.map((row) => (
                    <tr key={row}>
                      <td>
                        <span className="bar bar-id" />
                      </td>
                      <td>
                        <span className="bar bar-status" />
                      </td>
                      <td>
                        <span className="bar bar-when" />
                      </td>
                    </tr>
                  ))
                : state.items.map((session) => (
                    <tr key={session.id}>
                      <td>
                        {/* One real anchor, stretched over the row by CSS:
                            the whole row opens the conversation, and it is
                            still a link — focusable, middle-clickable,
                            copyable. */}
                        <a className="id row-link" href={`${SECTION}/${session.id}`}>
                          {session.id}
                        </a>
                      </td>
                      <td>
                        <Status archivedAt={session.archivedAt} meaning={SESSION_STATUS} />
                      </td>
                      <td>
                        <time dateTime={session.createdAt} title={absoluteTime(session.createdAt)}>
                          {relativeTime(session.createdAt, now)}
                        </time>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateSession
          onCreated={opened}
          onClose={() => setCreating(false)}
          returnFocus={startButton}
        />
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
