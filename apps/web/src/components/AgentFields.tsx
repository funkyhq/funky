// apps/web/src/components/AgentFields.tsx
// The three controls an agent config is written with: the provider, the
// model that provider serves, and the system prompt. Shared by the create
// dialog and the quickstart, so a config is written the same way wherever
// it is written — the arrangement NetworkFields already has beside it.
//
// Provider and model are both closed choices, and the model list is the
// SELECTED provider's (see lib/providers.ts): a config's provider names
// what will actually serve it, so the two cannot be set to disagree here.
import { Field } from "./Field";
import { type AgentFields as Fields, byId, onProvider } from "../lib/agent";
import { PROVIDERS } from "../lib/providers";

export function AgentFields({
  fields,
  onChange,
  disabled,
}: {
  fields: Fields;
  onChange: (fields: Fields) => void;
  /** Shown rather than offered — a config already created by a submit that
   *  stopped part way is not one this form may still edit. */
  disabled?: boolean;
}) {
  // The models to offer. A provider the list doesn't hold can only come
  // from an empty PROVIDERS, which is a state the CALLER has to answer for
  // — neither surface renders these controls in it.
  const provider = byId(fields.provider);

  return (
    <>
      <div className="field-row">
        <Field
          label="Provider"
          name="provider"
          value={fields.provider}
          // Changing the provider changes the model with it: a Claude id
          // under some other provider is the mismatch these two closed
          // lists exist to make unrepresentable.
          onChange={(id) => {
            const next = byId(id);
            if (next !== undefined) onChange(onProvider(next, fields.systemPrompt));
          }}
          options={PROVIDERS.map((entry) => ({ id: entry.id, label: entry.label }))}
          disabled={disabled}
          autoFocus
          required
        />
        <Field
          label="Model"
          name="model"
          value={fields.model}
          onChange={(model) => onChange({ ...fields, model })}
          options={provider?.models ?? []}
          disabled={disabled}
          required
        />
      </div>

      <Field
        label="System prompt"
        name="systemPrompt"
        value={fields.systemPrompt}
        onChange={(systemPrompt) => onChange({ ...fields, systemPrompt })}
        placeholder="You are a data analyst."
        rows={6}
        disabled={disabled}
        multiline
      />
    </>
  );
}
