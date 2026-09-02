// apps/web/src/pages/CreateEnvConfig.tsx
// The Create Env dialog: the POST /v1/env-configs body as a form.
//
// The form writes the network policy and nothing else. Packages are the
// recipe's other half and this dialog doesn't offer them yet — left out of
// the body they are left absent, which the api resolves to {} at create, so
// what lands is a recipe that installs nothing rather than a half-written
// one. Metadata is omitted the way the agent dialog omits its optional
// parts: it belongs to a recipe being tuned, not to one being made. Post the
// body directly, or update the recipe afterwards, when either is what you
// want.
//
// Namespace is omitted for the same reason as everywhere else: the console
// addresses exactly one (see DEFAULT_NAMESPACE in lib/api.ts) and has no
// switcher, so offering the field would let a recipe land somewhere the
// list can't show it.
import { type FormEvent, type RefObject, useState } from "react";
import {
  type CreateEnvConfigInput,
  createEnvConfig,
  DEFAULT_NAMESPACE,
  type EnvConfig,
  type NetworkPolicy,
} from "../lib/api";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";

/** The three policies core defines, in the order they narrow: reach
 *  anything, reach a named few, reach nothing. */
const POLICIES = [
  { id: "unrestricted", label: "Unrestricted — reach anything" },
  { id: "allowlist", label: "Allowlist — reach only these domains" },
  { id: "none", label: "None — no network at all" },
];

/** Only the allowlist carries anything beyond its own name, so `domains` is
 *  held beside the type rather than inside it: switching policies twice
 *  comes back to what was typed. */
type Fields = { type: NetworkPolicy["type"]; domains: string };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The domains as typed, one per line or comma-separated, in the order they
 * were written. Blanks are dropped and repeats collapsed — neither is a
 * domain the sandbox could be told about twice — but nothing else is
 * touched: the api takes these as strings and this console is in no
 * position to decide what a hostname may look like.
 */
function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const entry of text.split(/[\n,]/)) {
    const domain = entry.trim();
    if (domain !== "") seen.add(domain);
  }
  return [...seen];
}

export function CreateEnvConfig({
  onCreated,
  onClose,
  returnFocus,
}: {
  /** The new recipe, materialized — the caller puts it on the list. */
  onCreated: (config: EnvConfig) => void;
  onClose: () => void;
  /** Focus lands here if creating the recipe removed whatever opened this
   *  (Modal's `returnFocus`) — the first row replaces the empty state. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // The api's own default is where the form starts: an unrestricted recipe
  // is what posting an empty body would have made.
  const [fields, setFields] = useState<Fields>({ type: "unrestricted", domains: "" });
  const [busy, setBusy] = useState(false);
  // The api's refusal — a 400, or an api that isn't there.
  const [failure, setFailure] = useState<string>();

  const allowlist = fields.type === "allowlist";
  const domains = allowlist ? parseDomains(fields.domains) : [];
  // An allowlist of nothing reaches nothing, which is what `none` already
  // says — and says legibly. So the form asks for the domain rather than
  // taking a recipe whose type and effect disagree.
  const incomplete = allowlist && domains.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || incomplete) return;

    const network: NetworkPolicy = allowlist
      ? { type: "allowlist", domains }
      : { type: fields.type as "unrestricted" | "none" };
    const input: CreateEnvConfigInput = { network };

    setFailure(undefined);
    setBusy(true);
    try {
      // No abort signal: a create in flight is a row that may well exist, so
      // the dialog refuses to close (dismissible below) rather than walk
      // away from an answer it would then have to guess at.
      onCreated(await createEnvConfig(input));
      // Created — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create env config"
      description={
        <>
          The network a session&rsquo;s commands can reach. Lands in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace with no packages — those aren&rsquo;t set here
          yet.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          <Field
            label="Network"
            name="network"
            value={fields.type}
            onChange={(type) =>
              setFields((prev) => ({ ...prev, type: type as NetworkPolicy["type"] }))
            }
            options={POLICIES}
            autoFocus
            required
          />

          {/* The one policy with anything to say beyond its name. Keyed to
              nothing and mounted only here: a recipe that isn't an allowlist
              has no domains to show, and an empty box would suggest it did. */}
          {allowlist ? (
            <Field
              label="Domains"
              name="domains"
              value={fields.domains}
              onChange={(text) => setFields((prev) => ({ ...prev, domains: text }))}
              placeholder={"pypi.org\nfiles.pythonhosted.org"}
              rows={4}
              multiline
              required
            />
          ) : null}
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
          <button className="btn btn-primary" type="submit" disabled={busy || incomplete}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
