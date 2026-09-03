// apps/web/src/pages/CreateAgentConfig.tsx
// The Create Agent dialog: the POST /v1/agent-configs body as a form.
//
// The form is the request's REQUIRED shape and nothing else: provider,
// model, system prompt. The body's optional parts — maxTokens, temperature,
// metadata — are left out and therefore left absent, which is what the api
// reads as "the provider's own default" and "no metadata". They belong to a
// config being tuned, not to one being made; POST the body directly, or
// update the config afterwards, when that is what you want.
//
// The fields themselves are components/AgentFields.tsx and the state they
// hold is lib/agent.ts, shared with the quickstart — this file is the
// dialog around them: what the request is, and what to do when it fails.
// With no provider key configured there is nothing truthful to offer, and
// the dialog says that instead of taking a request the stack can't honour.
//
// Namespace is omitted for a different reason: the console addresses exactly
// one (see DEFAULT_NAMESPACE in lib/api.ts) and has no switcher, so offering
// the field would let a config land somewhere the list can't show it.
import { type FormEvent, type RefObject, useState } from "react";
import {
  type AgentConfig,
  createAgentConfig,
  type CreateAgentConfigInput,
  DEFAULT_NAMESPACE,
} from "../lib/api";
import { type AgentFields, initialFields, toInference } from "../lib/agent";
import { PROVIDERS } from "../lib/providers";
import { AgentFields as AgentFieldset } from "../components/AgentFields";
import { Modal } from "../components/Modal";
import { ProviderKeys } from "../components/ProviderKeys";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CreateAgentConfig({
  onCreated,
  onClose,
  returnFocus,
}: {
  /** The new config, at version 1 — the caller puts it on the list. */
  onCreated: (config: AgentConfig) => void;
  onClose: () => void;
  /** Focus lands here if creating the config removed whatever opened this
   *  (Modal's `returnFocus`) — the first row replaces the empty state. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // Both branches are dialogs, so which one opens is decided before either
  // mounts — and the hooks live in the branch that needs them.
  return PROVIDERS.length === 0 ? (
    <NoProvider onClose={onClose} returnFocus={returnFocus} />
  ) : (
    <Form onCreated={onCreated} onClose={onClose} returnFocus={returnFocus} />
  );
}

/** What there is to say when the stack has no key for any provider it can
 *  serve: the form would only be able to offer a lie. */
function NoProvider({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Modal
      title="No provider configured"
      description="A config names the provider that will run it, and the console offers only providers this stack has a key for."
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <div className="modal-body">
        <p className="prose">
          Add a key to the monorepo root <code>.env</code> — the same file{" "}
          <code>docker compose up</code> reads — then restart the dev server:
        </p>
        <ProviderKeys />
      </div>
      <footer className="modal-foot">
        <button className="btn" type="button" onClick={onClose} data-autofocus="">
          Close
        </button>
      </footer>
    </Modal>
  );
}

function Form({
  onCreated,
  onClose,
  returnFocus,
}: {
  onCreated: (config: AgentConfig) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // The first provider with a key, which CreateAgentConfig has already
  // established there is one of: this branch renders only when PROVIDERS
  // is non-empty.
  const [fields, setFields] = useState<AgentFields>(initialFields);
  const [busy, setBusy] = useState(false);
  // The api's refusal — a 400, or an api that isn't there. There is nothing
  // for the fields themselves to refuse: every one of them is either a
  // closed choice or free text the api takes as-is.
  const [failure, setFailure] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const input: CreateAgentConfigInput = {
      inference: toInference(fields),
      systemPrompt: fields.systemPrompt,
    };

    setFailure(undefined);
    setBusy(true);
    try {
      // No abort signal: a create in flight is a row that may well exist, so
      // the dialog refuses to close (dismissible below) rather than walk
      // away from an answer it would then have to guess at.
      onCreated(await createAgentConfig(input));
      // Created — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create agent config"
      description={
        <>
          The model and system prompt a session runs with. Lands as version 1 in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {/* Left enabled while the create is in flight, unlike the edit
              dialog's: this form closes on success and keeps its fields on
              a refusal, so there is nothing a late edit could be silently
              dropped from. */}
          <AgentFieldset fields={fields} onChange={setFields} />
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
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
