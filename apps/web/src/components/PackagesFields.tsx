// apps/web/src/components/PackagesFields.tsx
// The packages as one textarea, a package per line — and, under it, the
// first line that isn't one. Shared by the agent config dialogs and the
// quickstart, so packages are written the same way wherever they are written.
import { Field } from "./Field";
import { MANAGERS } from "../lib/packages";

export function PackagesFields({
  text,
  onChange,
  error,
  disabled,
}: {
  text: string;
  onChange: (text: string) => void;
  /** What readPackages refused, if anything. The caller reads the text, so
   *  it holds the same verdict it gates its submit on. */
  error?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <Field
        label="Packages"
        name="packages"
        value={text}
        onChange={onChange}
        placeholder={"pip pandas==2.2.0\nnpm express@4.18.0\napt graphviz"}
        rows={3}
        disabled={disabled}
        multiline
      />
      {error ? (
        <p className="field-error" aria-live="polite">
          {error}
        </p>
      ) : (
        <p className="field-hint">One per line: {MANAGERS.join(", ")}, then the package.</p>
      )}
    </div>
  );
}
