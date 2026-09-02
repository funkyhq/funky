// apps/web/src/pages/AgentConfigs.tsx
// The Agent section: the namespace's agent configs, newest first.
//
// A config is mutable and versioned — an update lands as a new version
// rather than a rewrite — and this list shows each config ONCE, at its
// latest version (the version the api's list route resolves, and the one a
// new session would pin). Older versions stay readable by id + version and
// stay pinned by the sessions that started on them; listing them all would
// make this a changelog rather than an inventory.
import { useEffect, useRef, useState } from "react";
import { type AgentConfig, listAgentConfigs } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { AgentIcon, PlusIcon, RefreshIcon } from "../components/Icons";
import { Status } from "../components/Status";
import type { PageProps } from "../nav";
import { CreateAgentConfig } from "./CreateAgentConfig";
import { EditAgentConfig } from "./EditAgentConfig";
import "./list.css";
import "./AgentConfigs.css";

/** This section's own route. Rows link into it by id, and closing the editor
 *  goes back to it — one place that spells the section's hash. */
const SECTION = "#/agent";

/**
 * `route` is the config id below this section, so `#/agent/<id>` IS the
 * editor being open: the dialog is a state of this page rather than a page
 * of its own, and stays linkable, back-navigable and reloadable.
 */
export function AgentConfigs({ route }: PageProps) {
  const { state, more, reload, loadMore, prepend, replace } =
    useList<AgentConfig>(listAgentConfigs);
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

  /** Leaves `#/agent/<id>` for `#/agent` without leaving a dialog behind
   *  the Back button. */
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

  // An update lands as a new version of the same config and an archive
  // marks that same config terminal, so either way the row is replaced
  // where it is.
  function changed(config: AgentConfig) {
    replace(config);
    closeEditor();
  }

  function added(config: AgentConfig) {
    setCreating(false);
    prepend(config);
  }

  return (
    <section className="list agents">
      <header className="list-head">
        <h1 className="list-title">Agent configs</h1>
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
          <p className="notice-title">Couldn&rsquo;t load agent configs</p>
          <p className="notice-body">{state.message}</p>
          <button className="btn" type="button" onClick={reload}>
            <RefreshIcon />
            Try again
          </button>
        </div>
      ) : state.status === "ready" && state.items.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <AgentIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No agent configs yet</p>
          <p className="notice-body">
            A config is the model and system prompt a session runs with. Create the first one, or
            post it yourself to <code>/v1/agent-configs</code>.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <PlusIcon />
            Create agent config
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="col-id">Id</th>
                <th className="col-model">Model</th>
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
                        <span className="bar bar-model" />
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
                        <span className="model">{config.inference.model}</span>
                        <span className="provider">{config.inference.provider}</span>
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
        <CreateAgentConfig
          onCreated={added}
          onClose={() => setCreating(false)}
          returnFocus={createButton}
        />
      ) : null}

      {route === "" ? null : (
        <EditAgentConfig
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
