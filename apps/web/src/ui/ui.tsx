// The Funky design-system primitives, reconstructed from the handoff spec (tokens + the
// prototype's inline styles). Every screen composes these; none reaches for raw brand hex.
import type { ReactNode } from "react";
import { useEffect } from "react";
import { X } from "lucide-react";
import "./ui.css";

type ButtonVariant = "accent" | "primary" | "secondary";
type ButtonSize = "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  type = "button",
  disabled,
  onClick,
  children,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`btn btn--${variant} btn--${size}${fullWidth ? " btn--full" : ""}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label ? <span className="field__label">{label}</span> : null}
      {children}
    </label>
  );
}

export function Input({
  label,
  placeholder,
  value,
  onChange,
}: {
  label?: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        className="control"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <select className="control" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Textarea({
  label,
  rows = 3,
  placeholder,
  value,
  onChange,
  onKeyDown,
}: {
  label?: string;
  rows?: number;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <Field label={label}>
      <textarea
        className="control control--area"
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </Field>
  );
}

export function Badge({
  tone = "neutral",
  dot,
  children,
}: {
  tone?: "green" | "neutral" | "red";
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span className="badge__dot" /> : null}
      {children}
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <span className="checkbox" data-checked={checked || undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="loading" />;
}

export function CodeBlock({ code, filename }: { code: string; filename: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span className="codeblock__lights">
          <i style={{ background: "#ff5f57" }} />
          <i style={{ background: "#febc2e" }} />
          <i style={{ background: "#28c840" }} />
        </span>
        <span className="codeblock__file">{filename}</span>
      </div>
      <pre className="codeblock__body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Avatar({
  initials,
  icon,
  size = 40,
}: {
  initials?: string;
  icon?: ReactNode;
  size?: number;
}) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size <= 34 ? 12 : 13 }}>
      {icon ?? initials}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  width = 460,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="scrim scrim--modal" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
