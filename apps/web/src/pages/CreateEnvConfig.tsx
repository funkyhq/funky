// apps/web/src/pages/CreateEnvConfig.tsx
// The Create Env dialog: the POST /v1/env-configs body as a form.
//
// The form writes the network policy and nothing else. Packages are the
// recipe's other half and this dialog doesn't offer them yet — left out of
// the body they are left absent, which the api resolves to {} at create, so
// what lands is a recipe that installs nothing rather than a half-written
// one. Metadata is omitted the way the agent dialog omits its optional
// parts: it belongs to a recipe being tuned, not to one being made. Post the
// body directly, or update the recipe afterwards, when either is what you
// want.
//
// Namespace is omitted for the same reason as everywhere else: the console
// addresses exactly one (see DEFAULT_NAMESPACE in lib/api.ts) and has no
// switcher, so offering the field would let a recipe land somewhere the
// list can't show it.
import { type FormEvent, type RefObject, useState } from "react";
import {
  type CreateEnvConfigInput,
  createEnvConfig,
  DEFAULT_NAMESPACE,
  type EnvConfig,
} from "../lib/api";
import { type NetworkFields, toPolicy } from "../lib/network";
import { NetworkFields as NetworkFieldset } from "../components/NetworkFields";
import { Modal } from "../components/Modal";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CreateEnvConfig({
  onCreated,
  onClose,
  returnFocus,
}: {
  /** The new recipe, materialized — the caller puts it on the list. */
  onCreated: (config: EnvConfig) => void;
  onClose: () => void;
  /** Focus lands here if creating the recipe removed whatever opened this
   *  (Modal's `returnFocus`) — the first row replaces the empty state. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // The api's own default is where the form starts: an unrestricted recipe
  // is what posting an empty body would have made.
  const [fields, setFields] = useState<NetworkFields>({ type: "unrestricted", domains: "" });
  const [busy, setBusy] = useState(false);
  // The api's refusal — a 400, or an api that isn't there.
  const [failure, setFailure] = useState<string>();

  // Absent while the allowlist has no domain on it — the one state of this
  // form that isn't a policy yet (see toPolicy).
  const network = toPolicy(fields);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || network === undefined) return;

    const input: CreateEnvConfigInput = { network };

    setFailure(undefined);
    setBusy(true);
    try {
      // No abort signal: a create in flight is a row that may well exist, so
      // the dialog refuses to close (dismissible below) rather than walk
      // away from an answer it would then have to guess at.
      onCreated(await createEnvConfig(input));
      // Created — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create env config"
      description={
        <>
          The network a session&rsquo;s commands can reach. Lands in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace with no packages — those aren&rsquo;t set here
          yet.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {/* The body went to the api when the click did, so a form still
              taking edits would be collecting what the close discards. */}
          <NetworkFieldset fields={fields} onChange={setFields} disabled={busy} />
        </div>

        <footer className="modal-foot">
          {failure ? (
            <p className="form-failure" role="alert">
              {failure}
            </p>
          ) : null}
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || network === undefined}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
