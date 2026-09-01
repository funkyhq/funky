// apps/web/src/pages/EditAgentConfig.tsx
// The Edit Agent dialog, at `#/agent/<id>`: the same three fields the create
// dialog writes, over POST /v1/agent-configs/:id.
//
// Two things the api's update semantics dictate, both load-bearing:
//
//  - It is a PARTIAL update. An absent field is left as it was, so what this
//    form doesn't show — metadata — survives an edit untouched. But a field
//    that IS sent bumps the version even when its value is identical, so
//    this sends only what actually changed, and saves nothing at all when
//    nothing did. Opening a dialog is not an edit.
//  - `version` is an optimistic-concurrency precondition. The row was read
//    at some version; sending it back means a config someone else has since
//    updated answers 409 instead of quietly overwriting their work.
//
// An archived config is read-only — the store matches no mutation against
// it — so the dialog shows it and says so rather than offering a Save the
// api would refuse.
import { type FormEvent, type RefObject, useEffect, useState } from "react";
import {
  type AgentConfig,
  getAgentConfig,
  type UpdateAgentConfigInput,
  updateAgentConfig,
} from "../lib/api";
import { PROVIDERS } from "../lib/providers";
import { Field, type FieldOption } from "../components/Field";
import { Modal } from "../components/Modal";
import { absoluteTime } from "../lib/format";
import "./EditAgentConfig.css";

type Fields = { provider: string; model: string; systemPrompt: string };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const fieldsOf = (config: AgentConfig): Fields => ({
  provider: config.inference.provider,
  model: config.inference.model,
  systemPrompt: config.systemPrompt,
});

/**
 * The options a select offers, always including what the config already
 * holds. A config can name a provider this console no longer offers (its key
 * left .env) or a model that has since dropped off the list, and a select
 * that silently omitted the current value would rewrite it on the first
 * save — an edit nobody asked for.
 */
function withCurrent(options: FieldOption[], current: string): FieldOption[] {
  return options.some((option) => option.id === current)
    ? options
    : [...options, { id: current, label: `${current} (not offered)` }];
}

export function EditAgentConfig({
  id,
  config,
  onSaved,
  onClose,
  returnFocus,
}: {
  id: string;
  /** The row, when the list already has it. Absent on a deep link into a
   *  page the walk hasn't reached, which is what the fetch below is for. */
  config?: AgentConfig;
  onSaved: (config: AgentConfig) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [fetched, setFetched] = useState<AgentConfig>();
  const [loadError, setLoadError] = useState<string>();
  // The list's copy wins when it has one — it is the fresher of the two, and
  // preferring it here is also what keeps a list that finishes loading AFTER
  // this opened from stranding the dialog: the effect below aborts its fetch
  // when `config` arrives, so the answer has to be able to come from either.
  const loaded = config ?? fetched;

  useEffect(() => {
    if (config !== undefined) return;
    const abort = new AbortController();
    getAgentConfig(id, { signal: abort.signal }).then(setFetched, (err: unknown) => {
      if (abort.signal.aborted) return;
      setLoadError(messageOf(err));
    });
    return () => abort.abort();
  }, [id, config]);

  if (loaded === undefined) {
    return (
      <Modal
        title={loadError ? "Couldn't load that config" : "Loading…"}
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
      onSaved={onSaved}
      onClose={onClose}
      returnFocus={returnFocus}
      // A save replaces the config the form was built from, so the form
      // starts again from what came back rather than from what was typed.
      key={`${loaded.id}@${loaded.version}`}
    />
  );
}

function EditForm({
  config,
  onSaved,
  onClose,
  returnFocus,
}: {
  config: AgentConfig;
  onSaved: (config: AgentConfig) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [fields, setFields] = useState<Fields>(() => fieldsOf(config));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const archived = config.archivedAt !== undefined;
  const saved = fieldsOf(config);
  const inferenceChanged = fields.provider !== saved.provider || fields.model !== saved.model;
  const promptChanged = fields.systemPrompt !== saved.systemPrompt;
  const changed = inferenceChanged || promptChanged;

  // The offered provider, when it is one; otherwise the config's own, whose
  // models this console can't enumerate — so the model it already has is
  // the only one it can honestly offer.
  const provider = PROVIDERS.find((entry) => entry.id === fields.provider);
  const models = withCurrent(provider?.models ?? [], fields.model);

  // The model belongs to the provider, so changing one changes the other —
  // the create dialog makes that pair unrepresentable and an edit must not
  // reintroduce it. Returning to the config's OWN provider restores the
  // model it was saved with; any other starts at that provider's first,
  // since nothing it serves is what was selected a moment ago.
  function selectProvider(id: string) {
    const next = PROVIDERS.find((entry) => entry.id === id);
    setFields((prev) => ({
      ...prev,
      provider: id,
      model:
        id === config.inference.provider
          ? config.inference.model
          : (next?.models[0]?.id ?? prev.model),
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || archived) return;
    // Nothing to send is nothing to version. Closing IS the save.
    if (!changed) {
      onClose();
      return;
    }

    // Only what differs: everything absent here keeps the value it has,
    // metadata included, and everything present costs a version.
    const input: UpdateAgentConfigInput = {
      inference: inferenceChanged
        ? { ...config.inference, provider: fields.provider, model: fields.model }
        : undefined,
      systemPrompt: promptChanged ? fields.systemPrompt : undefined,
      version: config.version,
    };

    setFailure(undefined);
    setBusy(true);
    try {
      onSaved(await updateAgentConfig(config.id, input));
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit agent config"
      description={
        <>
          <code className="mono-id">{config.id}</code>
          <span className="meta">
            version {config.version} · updated {absoluteTime(config.updatedAt)}
          </span>
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {archived ? (
            <p className="prose archived-note">
              This config is archived: it stays readable, and the sessions that pinned it keep
              running, but it takes no further updates and no new session can use it.
            </p>
          ) : null}

          <div className="field-row">
            <Field
              label="Provider"
              name="provider"
              value={fields.provider}
              onChange={selectProvider}
              options={withCurrent(
                PROVIDERS.map((entry) => ({ id: entry.id, label: entry.label })),
                fields.provider,
              )}
              disabled={archived}
              autoFocus
              required
            />
            <Field
              label="Model"
              name="model"
              value={fields.model}
              onChange={(model) => setFields((prev) => ({ ...prev, model }))}
              options={models}
              disabled={archived}
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
            disabled={archived}
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
            {archived || !changed ? "Close" : "Cancel"}
          </button>
          {archived ? null : (
            <button className="btn btn-primary" type="submit" disabled={busy || !changed}>
              {busy ? "Saving…" : `Save as version ${config.version + 1}`}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
