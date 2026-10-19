// apps/web/src/components/Field.tsx
// One labelled control, shared by the dialogs that write an agent config —
// a select when `options`, a textarea when `multiline`, an input otherwise.
//
// Nothing sits under the control: the label says what the field is, and
// these forms are short enough to say the rest by being short. What a field
// can't do is be wrong — every one is either a closed choice or free text
// the api takes as-is — so there is no error slot here either.
import type { ChangeEvent } from "react";
import { ChevronDownIcon } from "./Icons";
import "./Field.css";

export type FieldOption = { id: string; label: string };

export function Field({
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
  /** Also the control's id, so the label points at it. */
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** Turns the field into a closed choice; the id is the stored value. */
  options?: FieldOption[];
  multiline?: boolean;
  autoFocus?: boolean;
  rows?: number;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
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
