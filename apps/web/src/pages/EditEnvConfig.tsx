// apps/web/src/pages/EditEnvConfig.tsx
// The Edit Env dialog, at `#/environment/<id>`: the network policy the
// create dialog writes, over POST /v1/env-configs/:id.
//
// Two things the api's update semantics dictate, both load-bearing:
//
//  - It is a PARTIAL update applied IN PLACE. An absent field is left as it
//    was, so the packages and metadata this form doesn't show survive an
//    edit untouched — which is what lets a network-only dialog edit a recipe
//    that has more on it than a network. Nothing is sent when nothing
//    changed: opening a dialog is not an edit.
//  - There is no version, so there is no precondition to send with the
//    write. An agent config's update can answer 409 when someone else got
//    there first; this one cannot, and the later write simply wins. That is
//    the api's model, not an omission here.
//
// An archived recipe is read-only — the api answers 409 rather than reviving
// it — so the dialog shows it and says so rather than offering a Save that
// would be refused. Archiving is not offered here yet; it is its own action,
// the way it was for agent configs.
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import {
  type EnvConfig,
  getEnvConfig,
  type UpdateEnvConfigInput,
  updateEnvConfig,
} from "../lib/api";
import { fieldsOf, type NetworkFields, samePolicy, toPolicy } from "../lib/network";
import { NetworkFields as NetworkFieldset } from "../components/NetworkFields";
import { Modal } from "../components/Modal";
import { absoluteTime } from "../lib/format";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The recipe's packages as one line per manager, or nothing when it has
 *  none. Read-only: this dialog writes the network policy, and a recipe's
 *  packages are the half of it that isn't offered here yet. */
function packageLines(config: EnvConfig): Array<[string, string[]]> {
  return Object.entries(config.packages).filter(([, specs]) => specs.length > 0);
}

export function EditEnvConfig({
  id,
  config,
  onChanged,
  onClose,
  returnFocus,
}: {
  id: string;
  /** The row, when the list already has it. Absent on a deep link into a
   *  page the walk hasn't reached, which is what the fetch below is for. */
  config?: EnvConfig;
  /** The recipe as the api now holds it — the caller's row is stale once a
   *  save lands, and this is what replaces it. */
  onChanged: (config: EnvConfig) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [fetched, setFetched] = useState<EnvConfig>();
  const [loadError, setLoadError] = useState<string>();
  // The list's copy wins when it has one — it is the fresher of the two, and
  // preferring it here is also what keeps a list that finishes loading AFTER
  // this opened from stranding the dialog: the effect below aborts its fetch
  // when `config` arrives, so the answer has to be able to come from either.
  const loaded = config ?? fetched;

  useEffect(() => {
    if (config !== undefined) return;
    const abort = new AbortController();
    getEnvConfig(id, { signal: abort.signal }).then(setFetched, (err: unknown) => {
      if (abort.signal.aborted) return;
      setLoadError(messageOf(err));
    });
    return () => abort.abort();
  }, [id, config]);

  if (loaded === undefined) {
    return (
      <Modal
        title={loadError ? "Couldn't load that recipe" : "Loading…"}
        description={<code className="mono-id">{id}</code>}
        returnFocus={returnFocus}
        onClose={onClose}
      >
        <div className="modal-body">
          <p className="prose">{loadError ?? "Fetching it by id…"}</p>
        </div>
        <footer className="modal-foot">
          <button className="btn" type="button" onClick={onClose} data-autofocus="">
            Close
          </button>
        </footer>
      </Modal>
    );
  }

  return (
    <EditForm
      config={loaded}
      onChanged={onChanged}
      onClose={onClose}
      returnFocus={returnFocus}
      // Keyed on the recipe, and deliberately NOT on updatedAt: a dialog
      // that saves closes itself, so the only thing a fresher `loaded` can
      // mean here is that someone ELSE moved the row — a save from a
      // previous instance of this editor landing late, say. Remounting on
      // that would throw away whatever is typed in this one to show a
      // version of the recipe nobody in this dialog asked for.
      key={loaded.id}
    />
  );
}

function EditForm({
  config,
  onChanged,
  onClose,
  returnFocus,
}: {
  config: EnvConfig;
  onChanged: (config: EnvConfig) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [fields, setFields] = useState<NetworkFields>(() => fieldsOf(config.network));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  // Whether this editor is still the one on screen. Nothing aborts a write
  // when its dialog goes away — pressing Back, leaving the section, or
  // reopening the same recipe all unmount THIS instance while the request
  // is still out — and a completion arriving afterwards must not navigate:
  // the dialog it would close belongs to a later instance, quite possibly
  // with edits in it. The row it carries is still worth handing up, and
  // fresher for it; only the closing is conditional.
  const live = useRef(true);
  useEffect(() => {
    // Set on the way in as well as cleared on the way out: StrictMode mounts
    // twice, and an effect that only cleared would leave this false for the
    // whole life of the second mount — closing nothing, ever.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const archived = config.archivedAt !== undefined;
  // Absent while the allowlist has no domain on it — the one state of this
  // form that isn't a policy yet (see toPolicy).
  const network = toPolicy(fields);
  const changed = network !== undefined && !samePolicy(network, config.network);
  const packages = packageLines(config);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || archived || network === undefined) return;
    // Nothing to send is nothing to write. Closing IS the save.
    if (!changed) {
      onClose();
      return;
    }

    // Only the network: packages and metadata are absent from the body and
    // therefore left exactly as the recipe already holds them.
    const input: UpdateEnvConfigInput = { network };

    setFailure(undefined);
    setBusy(true);
    try {
      onChanged(await updateEnvConfig(config.id, input));
      if (live.current) onClose();
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit env config"
      description={
        <>
          <code className="mono-id">{config.id}</code>
          <span className="meta">updated {absoluteTime(config.updatedAt)}</span>
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {archived ? (
            <p className="prose note">
              This recipe is archived: it stays readable, and the sessions that copied it keep
              running, but it takes no further updates and no new session can use it.
            </p>
          ) : null}

          {/* Disabled while a save is in flight as well as when archived:
              the body went to the api when the click did, so anything typed
              after it would be silently dropped by the close that follows. */}
          <NetworkFieldset fields={fields} onChange={setFields} disabled={archived || busy} />

          {packages.length > 0 ? (
            <p className="prose note">
              Packages are left as they are — this dialog writes the network policy only.
              {packages.map(([manager, specs]) => (
                <span className="meta" key={manager}>
                  {manager}: {specs.join(", ")}
                </span>
              ))}
            </p>
          ) : null}
        </div>

        <footer className="modal-foot">
          {failure ? (
            <p className="form-failure" role="alert">
              {failure}
            </p>
          ) : null}
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            {archived || !changed ? "Close" : "Cancel"}
          </button>
          {archived ? null : (
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || network === undefined || !changed}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
