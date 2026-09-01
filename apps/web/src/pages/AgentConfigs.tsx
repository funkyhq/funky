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
import { absoluteTime, relativeTime } from "../lib/format";
import { useNow } from "../lib/useNow";
import { AgentIcon, RefreshIcon } from "../components/Icons";
import "./AgentConfigs.css";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; configs: AgentConfig[]; hasMore: boolean; cursor?: string };

/** Placeholder rows while the first page is in flight — same shape, so
 *  arriving data replaces them without the layout jumping. */
const SKELETON = [0, 1, 2];

/** How often the Created column re-reads the clock. Fine enough that the
 *  coarsest thing it prints — "1 minute ago" — is never a minute stale. */
const TICK_MS = 30_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AgentConfigs() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [more, setMore] = useState<{ busy: boolean; error?: string }>({ busy: false });
  // Bumped to re-run the effect — refresh and retry both go through
  // reload(), so a reload is one code path.
  const [reloads, setReloads] = useState(0);
  // Relative timestamps are only true at the moment they render, so the
  // clock they read has to keep moving.
  const now = useNow(TICK_MS);
  // The in-flight next-page request, if any. Held so a reload can cancel
  // it: its rows belong to the walk being replaced, not to the new one.
  const pagination = useRef<AbortController | null>(null);

  // The reset lives here rather than in the effect: the click is what makes
  // this loading again, and the effect's job is only to fetch.
  function reload() {
    setState({ status: "loading" });
    setMore({ busy: false });
    setReloads((n) => n + 1);
  }

  useEffect(() => {
    const abort = new AbortController();
    listAgentConfigs({ signal: abort.signal }).then(
      (page) =>
        setState({
          status: "ready",
          configs: page.data,
          hasMore: page.hasMore,
          cursor: page.lastId,
        }),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState({ status: "error", message: messageOf(err) });
      },
    );
    return () => {
      abort.abort();
      // Same generation, same fate: a page still arriving would otherwise
      // append itself to — and move the cursor of — a list it is no longer
      // part of, dropping or duplicating rows on the next Load more.
      pagination.current?.abort();
    };
  }, [reloads]);

  // The next page, appended. `cursor` is the previous page's last id — the
  // keyset the api hands back, not an offset, so rows created meanwhile
  // never shift the walk.
  async function loadMore() {
    if (state.status !== "ready" || state.cursor === undefined || more.busy) return;
    const abort = new AbortController();
    pagination.current = abort;
    setMore({ busy: true });
    try {
      const page = await listAgentConfigs({ after: state.cursor, signal: abort.signal });
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              configs: [...prev.configs, ...page.data],
              hasMore: page.hasMore,
              cursor: page.lastId,
            }
          : prev,
      );
      setMore({ busy: false });
    } catch (err) {
      // Superseded by a reload, which has already reset this — nothing to
      // report, and nothing of this walk left to report it against.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // The rows already on screen are still good: only the page that
      // failed is news, so it reports beside the button, not over the list.
      setMore({ busy: false, error: messageOf(err) });
    }
  }

  return (
    <section className="agents">
      <header className="agents-head">
        <h1 className="agents-title">Agent configs</h1>
        <button
          className="btn"
          type="button"
          onClick={reload}
          disabled={state.status === "loading"}
        >
          <RefreshIcon />
          Refresh
        </button>
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
      ) : state.status === "ready" && state.configs.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <AgentIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No agent configs yet</p>
          <p className="notice-body">
            A config is the model and system prompt a session runs with. Create one with{" "}
            <code>POST /v1/agent-configs</code>.
          </p>
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
                : state.configs.map((config) => (
                    <tr key={config.id}>
                      <td>
                        <span className="id">{config.id}</span>
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

      {state.status === "ready" && state.hasMore ? (
        <div className="agents-more">
          <button className="btn" type="button" onClick={loadMore} disabled={more.busy}>
            {more.busy ? "Loading…" : "Load more"}
          </button>
          {more.error ? <span className="agents-more-error">{more.error}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Archive is the one terminal transition, so this is a state, not a toggle. */
function Status({ archivedAt }: { archivedAt?: string }) {
  return (
    <span
      className={archivedAt ? "pill pill-archived" : "pill pill-active"}
      title={
        archivedAt
          ? `Archived ${absoluteTime(archivedAt)} — read-only, and no new session can use it`
          : "Accepts updates and new sessions"
      }
    >
      <span className="pill-dot" aria-hidden="true" />
      {archivedAt ? "Archived" : "Active"}
    </span>
  );
}
