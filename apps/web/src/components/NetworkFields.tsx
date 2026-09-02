// apps/web/src/components/NetworkFields.tsx
// The network policy as two controls: the policy itself, and — for the one
// policy that carries anything beyond its own name — the domains on it.
// Shared by the create and edit dialogs so the field a recipe is written
// with is the same field it is edited through.
import { Field } from "./Field";
import { type NetworkFields as Fields, POLICIES } from "../lib/network";

export function NetworkFields({
  fields,
  onChange,
  /** An archived recipe takes no update, so its policy is shown rather
   *  than offered. */
  disabled,
}: {
  fields: Fields;
  onChange: (fields: Fields) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Field
        label="Network"
        name="network"
        value={fields.type}
        onChange={(type) => onChange({ ...fields, type: type as Fields["type"] })}
        options={POLICIES}
        disabled={disabled}
        autoFocus
        required
      />

      {/* Mounted only for the allowlist: a recipe that isn't one has no
          domains to show, and an empty box would suggest it did. */}
      {fields.type === "allowlist" ? (
        <Field
          label="Domains"
          name="domains"
          value={fields.domains}
          onChange={(domains) => onChange({ ...fields, domains })}
          placeholder={"pypi.org\nfiles.pythonhosted.org"}
          rows={4}
          disabled={disabled}
          multiline
          required
        />
      ) : null}
    </>
  );
}
