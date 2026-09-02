// apps/web/src/pages/Sessions.tsx
// The Session section: the namespace's sessions, newest first.
//
// A session is one agent config version, one copy of an env recipe, and the
// durable entry log the two run against. This is an inventory read — three
// columns, no row link, nothing to open — because what makes a session
// worth clicking into is its log and its message box, and those come later.
// Nothing here creates one either: that takes an agent config AND an env
// config, which is the Quick Start flow rather than a button on a list.
//
// "Status" here is the LIFECYCLE — active or archived — not liveness. There
// is no running/idle column because the api has no such field: funky
// derives whether a session is working from its work items and its log
// rather than storing it on the row (see lib/api.ts Session).
import { type Session, listSessions } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { type FetchPage, SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { RefreshIcon, SessionIcon } from "../components/Icons";
import { Status, type StatusMeaning } from "../components/Status";
import "./list.css";
import "./Sessions.css";

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

/** What the pill means on a session, which is not what it means on a config
 *  (components/Status.tsx): archiving one closes client writes rather than
 *  edits, and the log it leaves behind stays readable. */
const MEANING: StatusMeaning = {
  active: "Accepts messages, and a worker can pick its work up",
  archived: "read-only: it takes no new message, and its log stays readable",
};

export function Sessions() {
  const { state, more, reload, loadMore } = useList<Session>(listAll);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(RELATIVE_TICK_MS);

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
            log. Start one by posting both ids to <code>/v1/sessions</code>.
          </p>
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
                      {/* Plain text, not a link: there is nowhere to go yet,
                          and list.css only highlights a row that opens
                          something. */}
                      <td>
                        <span className="id">{session.id}</span>
                      </td>
                      <td>
                        <Status archivedAt={session.archivedAt} meaning={MEANING} />
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
