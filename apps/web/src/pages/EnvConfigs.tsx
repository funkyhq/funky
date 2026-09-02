// apps/web/src/pages/EnvConfigs.tsx
// The Environment section: the namespace's env configs, newest first.
//
// An env config is the sandbox recipe — the network policy and the packages
// a session's commands run inside. Unlike an agent config it is updated IN
// PLACE, so there is no version to show: every row IS the current recipe,
// and a session that already started carries its own copy of the one it
// provisioned from.
//
// Three columns, and no row link: there is nothing to open yet. Create
// writes the network policy only; packages are the recipe's other half and
// come later (see CreateEnvConfig).
import { useRef, useState } from "react";
import { type EnvConfig, listEnvConfigs } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { SKELETON, useList } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { EnvironmentIcon, PlusIcon, RefreshIcon } from "../components/Icons";
import { Status } from "../components/Status";
import { CreateEnvConfig } from "./CreateEnvConfig";
import "./list.css";
import "./EnvConfigs.css";

/** Takes no route: this section is one view, so `#/environment` addresses
 *  all of it. */
export function EnvConfigs() {
  const { state, more, reload, loadMore, prepend } = useList<EnvConfig>(listEnvConfigs);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(RELATIVE_TICK_MS);
  const [creating, setCreating] = useState(false);
  // The header's Create button, which every state of this page renders. It
  // is where the dialog puts focus back when what opened it was the empty
  // state's button — the row it creates is what replaces that button.
  const createButton = useRef<HTMLButtonElement>(null);

  function added(config: EnvConfig) {
    setCreating(false);
    prepend(config);
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
                        <span className="id">{config.id}</span>
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
