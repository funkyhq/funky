// apps/web/src/pages/EnvConfigs.tsx
// The Environment section: the namespace's env configs, newest first.
//
// An env config is the sandbox recipe — the network policy and the packages
// a session's commands run inside. Unlike an agent config it is updated IN
// PLACE, so there is no version to show: every row IS the current recipe,
// and a session that already started carries its own copy of the one it
// provisioned from.
//
// Three columns, and every row a link into the editor. Create and edit both
// write the network policy only; packages are the recipe's other half and
// come later (see CreateEnvConfig and EditEnvConfig).
import { useEffect, useRef, useState } from "react";
import { type EnvConfig, listEnvConfigs } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { keepsArchive, SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { EnvironmentIcon, PlusIcon, RefreshIcon } from "../components/Icons";
import { Status } from "../components/Status";
import type { PageProps } from "../nav";
import { CreateEnvConfig } from "./CreateEnvConfig";
import { EditEnvConfig } from "./EditEnvConfig";
import "./list.css";
import "./EnvConfigs.css";

/** This section's own route. Rows link into it by id, and closing the editor
 *  goes back to it — one place that spells the section's hash. */
const SECTION = "#/environment";

/**
 * `route` is the recipe id below this section, so `#/environment/<id>` IS the
 * editor being open: the dialog is a state of this page rather than a page of
 * its own, and stays linkable, back-navigable and reloadable.
 */
export function EnvConfigs({ route }: PageProps) {
  const { state, more, reload, loadMore, prepend, replace } = useList<EnvConfig>(listEnvConfigs);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(RELATIVE_TICK_MS);
  const [creating, setCreating] = useState(false);
  // The header's Create button, which every state of this page renders. It
  // is where the dialog puts focus back when what opened it was the empty
  // state's button — the row it creates is what replaces that button.
  const createButton = useRef<HTMLButtonElement>(null);

  // Whether the editor's history entry is one a row click pushed, rather
  // than where the page was opened. Closing has to UNDO a push — otherwise
  // Back returns to the dialog the user just closed — but must not walk out
  // of the app when there is no entry of ours behind it.
  const pushed = useRef(false);
  const previousRoute = useRef(route);
  useEffect(() => {
    pushed.current = previousRoute.current === "" && route !== "";
    previousRoute.current = route;
  }, [route]);

  // The row the editor is open on, when this page already has it. A deep
  // link can name one from a page the walk hasn't reached; the dialog
  // fetches that itself rather than making the list chase it.
  const editing = state.status === "ready" ? state.items.find((c) => c.id === route) : undefined;

  /** Leaves `#/environment/<id>` for `#/environment` without leaving a dialog
   *  behind the Back button. */
  function closeEditor() {
    if (pushed.current) {
      window.history.back();
      return;
    }
    // Opened straight at this route — a deep link or a reload — so there is
    // nothing of ours to go back to and the entry is rewritten instead.
    window.history.replaceState(null, "", SECTION);
    // replaceState fires no hashchange, and the route is read from one.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  function added(config: EnvConfig) {
    setCreating(false);
    prepend(config);
  }

  // An edit rewrites the recipe in place — same id, same creation time, and
  // this list is ordered by creation — so the row is replaced where it is.
  //
  // Only the row: closing is the dialog's own to do. A save is not aborted
  // when its editor goes away, and the route it was sent from does not
  // identify that editor — reopening the same recipe gives the same route a
  // different dialog. Only the dialog knows whether it is still the one
  // open, so it is the one that decides whether to close (see EditEnvConfig).
  function changed(config: EnvConfig) {
    // Never older than what is already held: two writes to one recipe can be
    // in flight at once — a save outliving the dialog that sent it, then a
    // second from the editor that replaced it — and their answers need not
    // come back in the order the api committed them. A recipe has no version
    // to arbitrate with, so updatedAt is the token, and a tie in it is
    // settled by keepsArchive().
    replace(config, (incoming, held) =>
      incoming.updatedAt === held.updatedAt
        ? keepsArchive(incoming, held)
        : incoming.updatedAt > held.updatedAt,
    );
  }

  return (
    <section className="list envs">
      <header className="list-head">
        <h1 className="list-title">Env configs</h1>
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
            ref={createButton}
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            Create
          </button>
        </div>
      </header>

      {state.status === "error" ? (
        <div className="notice">
          <p className="notice-title">Couldn&rsquo;t load env configs</p>
          <p className="notice-body">{state.message}</p>
          <button className="btn" type="button" onClick={reload}>
            <RefreshIcon />
            Try again
          </button>
        </div>
      ) : state.status === "ready" && state.items.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <EnvironmentIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No env configs yet</p>
          <p className="notice-body">
            A recipe is the sandbox a session&rsquo;s commands run inside — its network policy and
            its packages. Create the first one, or post it yourself to <code>/v1/env-configs</code>.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <PlusIcon />
            Create env config
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
                : state.items.map((config) => (
                    <tr key={config.id}>
                      <td>
                        {/* One real anchor, stretched over the row by CSS:
                            the whole row is clickable, and it is still a
                            link — focusable, middle-clickable, copyable. */}
                        <a className="id row-link" href={`${SECTION}/${config.id}`}>
                          {config.id}
                        </a>
                      </td>
                      <td>
                        <Status archivedAt={config.archivedAt} />
                      </td>
                      <td>
                        <time dateTime={config.createdAt} title={absoluteTime(config.createdAt)}>
                          {relativeTime(config.createdAt, now)}
                        </time>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateEnvConfig
          onCreated={added}
          onClose={() => setCreating(false)}
          returnFocus={createButton}
        />
      ) : null}

      {route === "" ? null : (
        <EditEnvConfig
          key={route}
          id={route}
          config={editing}
          onChanged={changed}
          onClose={closeEditor}
          returnFocus={createButton}
        />
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
