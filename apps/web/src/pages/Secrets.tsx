// apps/web/src/pages/Secrets.tsx
// The Secret section: the keys the namespace stores, by name.
//
// Write-only, as the api is: a row is a name and when its value last
// changed, and no route answers with the value itself — so nothing here
// can show one. Agent configs' credentials refer to these names.
//
// Not a useList section. The api answers with the whole list, sorted by
// name, rather than newest-first pages, so there is no walk to continue,
// and a stored key goes in where its name sorts rather than on the front.
//
// `#/secret/<name>` is the edit dialog being open, as `#/agent/<id>` is
// for a config.
import { useEffect, useRef, useState } from "react";
import { ApiError, listSecrets, type SecretInfo } from "../lib/api";
import { RELATIVE_TICK_MS, absoluteTime, relativeTime } from "../lib/format";
import { SKELETON } from "../lib/useList";
import { useNow } from "../lib/useNow";
import { KeyIcon, PlusIcon, RefreshIcon } from "../components/Icons";
import type { PageProps } from "../nav";
import { AddSecret } from "./AddSecret";
import { EditSecret } from "./EditSecret";
import "./list.css";
import "./Secrets.css";

/** This section's own route. Rows link into it by name, and closing the
 *  editor goes back to it. */
const SECTION = "#/secret";

const README_SECRETS = "https://github.com/funkyhq/funky#secrets";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  // The collection answered 404: this stack has no secret store, and no
  // retry will change that until one is configured.
  | { status: "unconfigured" }
  | { status: "ready"; items: SecretInfo[] };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The list with this key in its place — replaced where its name already is,
 * otherwise inserted where the store's own order puts it: names compared as
 * plain strings, the way the adapters sort them. An answer older than the
 * copy already held loses, since two writes to one key can come back out of
 * the order the store took them in.
 */
function upsert(items: SecretInfo[], secret: SecretInfo): SecretInfo[] {
  const held = items.find((item) => item.name === secret.name);
  if (held !== undefined && held.updatedAt > secret.updatedAt) return items;
  const rest = items.filter((item) => item.name !== secret.name);
  const at = rest.findIndex((item) => item.name > secret.name);
  return at === -1 ? [...rest, secret] : [...rest.slice(0, at), secret, ...rest.slice(at)];
}

export function Secrets({ route }: PageProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  // Bumped to re-run the load, so refresh and retry are one code path.
  const [reloads, setReloads] = useState(0);
  const now = useNow(RELATIVE_TICK_MS);
  const [adding, setAdding] = useState(false);
  // The header's Add button, which every state of this page renders: where
  // focus goes back to when the button that opened a dialog is gone.
  const addButton = useRef<HTMLButtonElement>(null);

  // Closing the editor undoes the push that opened it, or rewrites the entry
  // when the page was opened straight at it — the Agent section's logic, for
  // the same reasons (see AgentConfigs.tsx).
  const pushed = useRef(false);
  const previousRoute = useRef(route);
  useEffect(() => {
    pushed.current = previousRoute.current === "" && route !== "";
    previousRoute.current = route;
  }, [route]);

  useEffect(() => {
    const abort = new AbortController();
    listSecrets({ signal: abort.signal }).then(
      (items) => setState({ status: "ready", items }),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState(
          err instanceof ApiError && err.status === 404
            ? { status: "unconfigured" }
            : { status: "error", message: messageOf(err) },
        );
      },
    );
    return () => abort.abort();
  }, [reloads]);

  function reload() {
    setState({ status: "loading" });
    setReloads((n) => n + 1);
  }

  function closeEditor() {
    if (pushed.current) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", SECTION);
    // replaceState fires no hashchange, and the route is read from one.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  function added(secret: SecretInfo) {
    setAdding(false);
    stored(secret);
  }

  // Off the ready path there is no list to change, and the load in flight
  // may have been issued before the write, so it is re-read instead.
  function stored(secret: SecretInfo) {
    if (state.status !== "ready") {
      reload();
      return;
    }
    setState((prev) =>
      prev.status === "ready" ? { status: "ready", items: upsert(prev.items, secret) } : prev,
    );
  }

  function deleted(name: string) {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", items: prev.items.filter((item) => item.name !== name) }
        : prev,
    );
  }

  return (
    <section className="list secrets">
      <header className="list-head">
        <h1 className="list-title">Secrets</h1>
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
            ref={addButton}
            onClick={() => setAdding(true)}
            // Only over a loaded list: it is what tells the dialog whether a
            // name is already stored, and with no store there is nowhere to
            // add to.
            disabled={state.status !== "ready"}
          >
            <PlusIcon />
            Add
          </button>
        </div>
      </header>

      {state.status === "unconfigured" ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <KeyIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No secret store configured</p>
          <p className="notice-body">
            Secrets are kept in Infisical, not Postgres. Set the <code>INFISICAL_*</code> variables
            in <code>.env</code> and restart the stack; the{" "}
            <a href={README_SECRETS} target="_blank" rel="noreferrer">
              README
            </a>{" "}
            walks through it.
          </p>
        </div>
      ) : state.status === "error" ? (
        <div className="notice">
          <p className="notice-title">Couldn&rsquo;t load secrets</p>
          <p className="notice-body">{state.message}</p>
          <button className="btn" type="button" onClick={reload}>
            <RefreshIcon />
            Try again
          </button>
        </div>
      ) : state.status === "ready" && state.items.length === 0 ? (
        <div className="notice">
          <span className="notice-icon" aria-hidden="true">
            <KeyIcon width={22} height={22} strokeWidth={1.6} />
          </span>
          <p className="notice-title">No secrets yet</p>
          <p className="notice-body">
            A secret is an API key your agent&rsquo;s tools use, stored once by name. An agent
            config&rsquo;s credentials hand it to the sandbox without the agent seeing it.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add secret
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="col-when">Updated</th>
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
                        <span className="bar bar-when" />
                      </td>
                    </tr>
                  ))
                : state.items.map((secret) => (
                    <tr key={secret.name}>
                      <td>
                        {/* The row's one link, stretched over it by list.css. */}
                        <a className="id row-link" href={`${SECTION}/${secret.name}`}>
                          {secret.name}
                        </a>
                      </td>
                      <td>
                        <time dateTime={secret.updatedAt} title={absoluteTime(secret.updatedAt)}>
                          {relativeTime(secret.updatedAt, now)}
                        </time>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && state.status === "ready" ? (
        <AddSecret
          stored={new Set(state.items.map((item) => item.name))}
          onStored={added}
          onClose={() => setAdding(false)}
          returnFocus={addButton}
        />
      ) : null}

      {/* Only once the list is in: it is what says whether the name is
          stored, and what the dialog's dates come from. */}
      {route !== "" && state.status === "ready" ? (
        <EditSecret
          key={route}
          name={route}
          secret={state.items.find((item) => item.name === route)}
          onStored={stored}
          onDeleted={deleted}
          onClose={closeEditor}
          returnFocus={addButton}
        />
      ) : null}
    </section>
  );
}
