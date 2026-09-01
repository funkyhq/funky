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
// Provider and model are both closed choices, and the model list is the
// SELECTED provider's (see lib/providers.ts): a config's provider names what
// will actually serve it, so the two cannot be set to disagree here. With no
// provider key configured there is nothing truthful to offer, and the dialog
// says that instead of taking a request the stack can't honour.
//
// Namespace is omitted for a different reason: the console addresses exactly
// one (see DEFAULT_NAMESPACE in lib/api.ts) and has no switcher, so offering
// the field would let a config land somewhere the list can't show it.
import { type ChangeEvent, type FormEvent, type RefObject, useState } from "react";
import {
  type AgentConfig,
  createAgentConfig,
  type CreateAgentConfigInput,
  DEFAULT_NAMESPACE,
} from "../lib/api";
import { KNOWN_PROVIDERS, type Provider, PROVIDERS } from "../lib/providers";
import { ChevronDownIcon } from "../components/Icons";
import { Modal } from "../components/Modal";
import "./CreateAgentConfig.css";

type Fields = {
  provider: string;
  model: string;
  systemPrompt: string;
};

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
        <ul className="key-list">
          {KNOWN_PROVIDERS.map((provider) => (
            <li key={provider.id}>
              <code>{provider.envKey}</code>
              <span>{provider.label}</span>
            </li>
          ))}
        </ul>
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
  // Non-empty by construction: CreateAgentConfig renders this branch only
  // when there is a provider to start on.
  const [fields, setFields] = useState<Fields>(() => onProvider(PROVIDERS[0], ""));
  const [busy, setBusy] = useState(false);
  // The api's refusal — a 400, or an api that isn't there. There is nothing
  // for the fields themselves to refuse: every one of them is either a
  // closed choice or free text the api takes as-is.
  const [failure, setFailure] = useState<string>();

  const provider = PROVIDERS.find((entry) => entry.id === fields.provider) ?? PROVIDERS[0];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const input: CreateAgentConfigInput = {
      inference: { provider: fields.provider, model: fields.model },
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
          <div className="field-row">
            <Field
              label="Provider"
              name="provider"
              value={fields.provider}
              // Changing the provider changes the model with it: a Claude id
              // under some other provider is the mismatch these two closed
              // lists exist to make unrepresentable.
              onChange={(id) => setFields(onProvider(byId(id), fields.systemPrompt))}
              options={PROVIDERS.map((entry) => ({ id: entry.id, label: entry.label }))}
              autoFocus
              required
            />
            <Field
              label="Model"
              name="model"
              value={fields.model}
              onChange={(model) => setFields((prev) => ({ ...prev, model }))}
              options={provider.models}
              required
            />
          </div>

          <Field
            label="System prompt"
            name="systemPrompt"
            value={fields.systemPrompt}
            onChange={(systemPrompt) => setFields((prev) => ({ ...prev, systemPrompt }))}
            placeholder="You are a data analyst."
            rows={6}
            multiline
          />
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

/** A provider by id, falling back to the first — an id the select didn't
 *  render can't be chosen, so the fallback is for types, not for users. */
const byId = (id: string): Provider => PROVIDERS.find((entry) => entry.id === id) ?? PROVIDERS[0];

/** The fields as they are on a provider: its first model, since the one that
 *  was selected belonged to whichever provider is being left. */
const onProvider = (provider: Provider, systemPrompt: string): Fields => ({
  provider: provider.id,
  model: provider.models[0].id,
  systemPrompt,
});

/** One labelled control — a select when `options`, a textarea when
 *  `multiline`, an input otherwise. Nothing sits under it: the label says
 *  what the field is, and a form of three says the rest by being three. */
function Field({
  label,
  name,
  value,
  onChange,
  options,
  multiline,
  autoFocus,
  ...control
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** Turns the field into a closed choice; the id is the stored value. */
  options?: Array<{ id: string; label: string }>;
  multiline?: boolean;
  autoFocus?: boolean;
  rows?: number;
  placeholder?: string;
  required?: boolean;
}) {
  const props = {
    id: name,
    name,
    value,
    className: "control",
    // Modal focuses this on open rather than React on mount: the dialog
    // moves focus itself when it opens, and would move it right back off.
    "data-autofocus": autoFocus ? "" : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(event.target.value),
    ...control,
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={name}>
        {label}
        {control.required ? null : <span className="field-optional">optional</span>}
      </label>
      {options ? (
        // The arrow is ours: dropping the native appearance for the shared
        // control styling takes the platform's with it.
        <span className="select-wrap">
          <select {...props}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="select-arrow" />
        </span>
      ) : multiline ? (
        <textarea {...props} />
      ) : (
        <input {...props} />
      )}
    </div>
  );
}
