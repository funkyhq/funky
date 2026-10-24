// apps/web/src/components/CredentialsFields.tsx
// The credentials as cards, one per credential: the env var that holds the
// placeholder, the stored secret that is the key, the domains, and the
// header set on requests to them, outside the sandbox. Shared by the agent
// config dialogs, so a credential is edited through the field it was
// written with.
//
// The secret field suggests the names the store holds but takes any: a
// config can name a key before it is stored, and a session's run fails with
// "secret not found" only if it still isn't when the sandbox is created.
import { useEffect, useId, useState } from "react";
import { listSecrets } from "../lib/api";
import { type CredentialFields, NEW_CREDENTIAL } from "../lib/credentials";
import { Field } from "./Field";
import { CloseIcon, PlusIcon } from "./Icons";
import "./CredentialsFields.css";

export function CredentialsFields({
  credentials,
  onChange,
  disabled,
}: {
  credentials: CredentialFields[];
  onChange: (credentials: CredentialFields[]) => void;
  disabled?: boolean;
}) {
  const [stored, setStored] = useState<string[]>([]);
  const suggestions = useId();

  useEffect(() => {
    const abort = new AbortController();
    // Suggestions only. With no store, or no answer, the field is the free
    // text it is anyway — and a store that isn't configured is said where
    // it is fixed: the Secret page, and the run that needs one.
    listSecrets({ signal: abort.signal }).then(
      (secrets) => setStored(secrets.map((secret) => secret.name)),
      () => {},
    );
    return () => abort.abort();
  }, []);

  function edit(at: number, change: Partial<CredentialFields>) {
    onChange(credentials.map((card, i) => (i === at ? { ...card, ...change } : card)));
  }

  return (
    <div className="field">
      <span className="field-label">
        Credentials
        <span className="field-optional">optional</span>
      </span>

      <div className="creds">
        {/* Keyed by position: cards are only added at the end or removed,
            and every input is controlled, so a card's fields always show
            its own values whichever node renders them. */}
        {credentials.map((card, i) => (
          <section className="cred" key={i} aria-label={`Credential ${i + 1}`}>
            <div className="field-row">
              <Field
                label="Env var"
                name={`credential-${i}-env`}
                value={card.env}
                onChange={(env) => edit(i, { env })}
                placeholder="STRIPE_API_KEY"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                required
              />
              <Field
                label="Secret"
                name={`credential-${i}-secret`}
                value={card.secret}
                onChange={(secret) => edit(i, { secret })}
                placeholder="stripe-live"
                list={suggestions}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                required
              />
            </div>
            <Field
              label="Domains"
              name={`credential-${i}-domains`}
              value={card.domains}
              onChange={(domains) => edit(i, { domains })}
              placeholder="api.stripe.com"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              required
            />
            <div className="field-row">
              <Field
                label="Header"
                name={`credential-${i}-header`}
                value={card.header}
                onChange={(header) => edit(i, { header })}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                required
              />
              <Field
                label="Value"
                name={`credential-${i}-value`}
                value={card.value}
                onChange={(value) => edit(i, { value })}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                required
              />
            </div>
            {disabled ? null : (
              <button
                className="cred-remove"
                type="button"
                onClick={() => onChange(credentials.filter((_, j) => j !== i))}
                aria-label={`Remove credential ${i + 1}`}
              >
                <CloseIcon />
              </button>
            )}
          </section>
        ))}

        {disabled ? (
          credentials.length === 0 ? (
            <p className="cred-none">None</p>
          ) : null
        ) : (
          <button
            className="cred-add"
            type="button"
            onClick={() => onChange([...credentials, NEW_CREDENTIAL])}
          >
            <PlusIcon width={13} height={13} />
            Add credential
          </button>
        )}
      </div>

      <datalist id={suggestions}>
        {stored.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  );
}
