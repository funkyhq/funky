// apps/web/src/components/ResourcesFields.tsx
// The sandbox's size: vCPUs and memory, abreast. Shared by the agent config
// dialogs, so a size is edited through the field it was written with. Each
// is optional: blank is the default, 2 vCPUs and 1024 MiB, which the
// placeholders show so a blank field says what it means.
import { Field } from "./Field";
import type { ResourceFields } from "../lib/resources";

export function ResourcesFields({
  fields,
  onChange,
  disabled,
}: {
  fields: ResourceFields;
  onChange: (fields: ResourceFields) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field-row">
      <Field
        label="vCPUs"
        name="resources-cpu-count"
        value={fields.cpuCount}
        onChange={(cpuCount) => onChange({ ...fields, cpuCount })}
        placeholder="2 (default)"
        inputMode="numeric"
        disabled={disabled}
      />
      <Field
        label="Memory (MiB)"
        name="resources-memory-mb"
        value={fields.memoryMB}
        onChange={(memoryMB) => onChange({ ...fields, memoryMB })}
        placeholder="1024 (default)"
        inputMode="numeric"
        disabled={disabled}
      />
    </div>
  );
}
