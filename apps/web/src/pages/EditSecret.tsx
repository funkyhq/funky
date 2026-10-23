// apps/web/src/pages/EditSecret.tsx
// The dialog at `#/secret/<name>`: a stored key's dates, a field to replace
// its value, and Delete.
//
// There is no value to show — the api never answers with one — so replacing
// is typing a new one: the same PUT that stored the key, landing as its
// latest value. A session reads keys when it creates its sandbox, so a
// replaced or deleted key reaches the sessions that create one after this,
// not one that already has its sandbox.
//
// Delete happens on the click, as Archive does on a config: the red label
// is the whole of the warning. A config that still names the key fails its
// next new sandbox with "secret not found".
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { DEFAULT_NAMESPACE, deleteSecret, putSecret, type SecretInfo } from "../lib/api";
import { absoluteTime } from "../lib/format";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function EditSecret({
  name,
  secret,
  onStored,
  onDeleted,
  onClose,
  returnFocus,
}: {
  /** The name the route addresses. */
  name: string;
  /** The row, when the list holds one by that name. */
  secret?: SecretInfo;
  /** The key as stored after a replace — the caller's row is stale. */
  onStored: (secret: SecretInfo) => void;
  onDeleted: (name: string) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // The row as it was when the dialog opened. A delete takes it off the list
  // before the route has left it, and the dialog must not turn into "no such
  // secret" in the moment between.
  const [opened] = useState(secret);
  const shown = secret ?? opened;

  if (shown === undefined) {
    return (
      <Modal
        title="No such secret"
        description={<code className="mono-id">{name}</code>}
        returnFocus={returnFocus}
        onClose={onClose}
      >
        <div className="modal-body">
          <p className="prose">
            Nothing is stored under this name in the <code>{DEFAULT_NAMESPACE}</code> namespace.
          </p>
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
      secret={shown}
      onStored={onStored}
      onDeleted={onDeleted}
      onClose={onClose}
      returnFocus={returnFocus}
    />
  );
}

function EditForm({
  secret,
  onStored,
  onDeleted,
  onClose,
  returnFocus,
}: {
  secret: SecretInfo;
  onStored: (secret: SecretInfo) => void;
  onDeleted: (name: string) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState<string>();
  // WHICH write is in flight: the two are exclusive, and each button names
  // its own.
  const [pending, setPending] = useState<"saving" | "deleting">();
  const busy = pending !== undefined;

  // Whether this dialog is still the one on screen. A write isn't aborted
  // when its dialog goes away, and an answer arriving after that must not
  // close a later one — the same guard as the config editor's.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || value === "") return;
    setFailure(undefined);
    setPending("saving");
    try {
      onStored(await putSecret(secret.name, value));
      if (live.current) onClose();
    } catch (err) {
      setFailure(messageOf(err));
      setPending(undefined);
    }
  }

  async function remove() {
    if (busy) return;
    setFailure(undefined);
    setPending("deleting");
    try {
      await deleteSecret(secret.name);
      onDeleted(secret.name);
      if (live.current) onClose();
    } catch (err) {
      setFailure(messageOf(err));
      setPending(undefined);
    }
  }

  return (
    <Modal
      title="Edit secret"
      description={
        <>
          <code className="mono-id">{secret.name}</code>
          <span className="meta">
            updated {absoluteTime(secret.updatedAt)} · created {absoluteTime(secret.createdAt)}
          </span>
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          <p className="prose">
            The stored value can&rsquo;t be shown. A new one replaces it for sessions that create a
            sandbox after the save.
          </p>
          {/* Disabled while a write is in flight: the click already sent
              the body, so anything typed after it would be dropped. */}
          <Field
            label="New value"
            name="value"
            type="password"
            value={value}
            onChange={setValue}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
            required
          />
        </div>

        {/* Delete takes the footer's left, where Archive sits in a config's
            editor, and borrows its red label (.btn-archive, index.css): the
            same kind of click, one with nothing on the other side of it. */}
        <footer className="modal-foot">
          <button className="btn btn-archive" type="button" onClick={remove} disabled={busy}>
            {pending === "deleting" ? "Deleting…" : "Delete"}
          </button>
          {failure ? (
            <p className="form-failure" role="alert">
              {failure}
            </p>
          ) : null}
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            {value === "" ? "Close" : "Cancel"}
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || value === ""}>
            {pending === "saving" ? "Saving…" : "Replace value"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
