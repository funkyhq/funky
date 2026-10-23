// apps/web/src/pages/AddSecret.tsx
// The Add Secret dialog: PUT /v1/secrets/:name as a form — a name, and the
// value to store under it.
//
// The route creates or replaces and its answer doesn't say which, so the
// dialog says it before the click instead: a name already stored turns Add
// into Replace. The value is a password field, so the key shows as dots,
// and after the save this console never has it again.
import { type FormEvent, type RefObject, useState } from "react";
import { DEFAULT_NAMESPACE, putSecret, type SecretInfo } from "../lib/api";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AddSecret({
  stored,
  onStored,
  onClose,
  returnFocus,
}: {
  /** The names already stored, so the dialog can say a save replaces one. */
  stored: ReadonlySet<string>;
  /** The key as stored — the caller puts it on the list. */
  onStored: (secret: SecretInfo) => void;
  onClose: () => void;
  /** Focus lands here if adding the key removed what opened this — the
   *  first row replaces the empty state's button (Modal's `returnFocus`). */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // The api's refusal: a name or value it doesn't take, or no api at all.
  const [failure, setFailure] = useState<string>();
  const replaces = stored.has(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || name === "" || value === "") return;
    setFailure(undefined);
    setBusy(true);
    try {
      // No abort signal, as for a config's create: a put in flight may well
      // land, so the dialog stays until it knows.
      onStored(await putSecret(name, value));
      // Stored — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add secret"
      description={
        <>
          Stored in the <code>{DEFAULT_NAMESPACE}</code> namespace, for agent configs&rsquo;
          credentials to name. The value is never shown again.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={setName}
            placeholder="stripe-live"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
          />
          <Field
            label="Value"
            name="value"
            type="password"
            value={value}
            onChange={setValue}
            autoComplete="off"
            spellCheck={false}
            required
          />
          {replaces ? (
            <p className="prose note">
              <code>{name}</code> is already stored: saving replaces its value.
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
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || name === "" || value === ""}
          >
            {busy ? "Saving…" : replaces ? "Replace" : "Add"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
