// apps/web/src/pages/CreateSession.tsx
// The Start Session dialog: the two configs a session is made of, and the
// first thing to say to it.
//
// Two calls, not one. The api creates a session and takes messages through
// separate routes — a session is a place, and a message is something that
// happens in it — so this dialog does both and has to be honest about the
// gap between them: if the message fails, the session still exists, and
// saying so is the only answer that doesn't either lose it or create a
// second one (see submit).
//
// Neither route takes an idempotency key, so a request whose ANSWER is lost
// cannot be told apart from one that was refused — and nothing this console
// can read settles it either. Only the api REFUSING a request proves it was
// not taken, so that is the one failure either half offers to repeat:
//
//  - A refused create or message wrote nothing. Say so, and let it be sent
//    again.
//  - An unanswered one is unknown, and stays unknown. A create says a
//    session may exist and to check the list; a message stops offering to
//    be sent at all, and points at the conversation, where the log shows
//    whether it arrived and the composer can send it if it didn't.
//
// The pickers offer ACTIVE configs only. An archived one is readable and
// keeps its running sessions, but nothing new may name it — the api answers
// 409 — so offering it would be offering a refusal.
import { type FormEvent, type RefObject, useEffect, useState } from "react";
import {
  type AgentConfig,
  ApiError,
  DEFAULT_NAMESPACE,
  type EnvConfig,
  type NetworkPolicy,
  type Session,
  createSession,
  listAgentConfigs,
  listEnvConfigs,
  sendMessage,
} from "../lib/api";
import { Field, type FieldOption } from "../components/Field";
import { Modal } from "../components/Modal";

/**
 * How deep the pickers read. One page each, at the api's ceiling: a picker
 * is a choice, not an inventory, and a namespace with more than this many
 * configs is one where picking from a list has stopped being the way to
 * start a session anyway. The sections themselves page properly.
 */
const PICKER_LIMIT = 100;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const active = (config: { archivedAt?: string }) => config.archivedAt === undefined;

/** Enough of an id to tell two rows apart at a glance; the session's page
 *  shows every id it was made from in full. */
const short = (id: string) => id.slice(0, 8);

/** What a recipe does to the network, which is the whole of what an env
 *  config currently decides. */
function networkLabel(network: NetworkPolicy): string {
  return network.type === "allowlist"
    ? `allowlist of ${network.domains.length}`
    : network.type === "none"
      ? "no network"
      : "unrestricted";
}

const agentOptions = (configs: AgentConfig[]): FieldOption[] =>
  configs.map((config) => ({
    id: config.id,
    label: `${config.inference.model} · v${config.version} · ${short(config.id)}`,
  }));

const envOptions = (configs: EnvConfig[]): FieldOption[] =>
  configs.map((config) => ({
    id: config.id,
    label: `${networkLabel(config.network)} · ${short(config.id)}`,
  }));

/** The active configs a session can be made from, once both lists land. */
type Choices = { agents: AgentConfig[]; envs: EnvConfig[] };

export function CreateSession({
  onCreated,
  onClose,
  returnFocus,
}: {
  /** The new session. The caller opens it — creating one is how you get to
   *  the conversation, not an end in itself. */
  onCreated: (session: Session) => void;
  onClose: () => void;
  /** Focus lands here if creating the session removed whatever opened this
   *  (Modal's `returnFocus`) — the first row replaces the empty state. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [choices, setChoices] = useState<Choices>();
  /**
   * How the last request ended, when it didn't go through, and which one
   * it was.
   *
   * "refused" is the api rejecting it, which proves the write never ran, so
   * making it again is safe. "unconfirmed" is no answer at all — and no
   * read settles that, however new the session is: a client disconnecting
   * does not cancel the request, so a transaction still committing looks
   * exactly like one that never started, and asking too early then trying
   * again is how one session, or one instruction, becomes two.
   *
   * The stage is what the dialog can offer afterwards. An unconfirmed
   * message leaves a session to open; an unconfirmed create leaves nothing
   * at all — no id to show, and no way to ask — so the only honest move is
   * out of the dialog and into the list.
   */
  const [outcome, setOutcome] = useState<{
    stage: "create" | "message";
    kind: "refused" | "unconfirmed";
  }>();
  const [agentConfigId, setAgentConfigId] = useState("");
  const [envConfigId, setEnvConfigId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // The session, once it exists. Set before the message is sent, so a
  // failure after this point knows there is a row to answer for.
  const [created, setCreated] = useState<Session>();
  // The api's refusal — from either call, or from the reads that fill the
  // pickers.
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      listAgentConfigs({ limit: PICKER_LIMIT, signal: abort.signal }),
      listEnvConfigs({ limit: PICKER_LIMIT, signal: abort.signal }),
    ]).then(
      ([agents, envs]) => {
        const usable = { agents: agents.data.filter(active), envs: envs.data.filter(active) };
        setChoices(usable);
        // The newest of each, which is what the lists lead with — the
        // likeliest choice, and never an empty select showing nothing.
        setAgentConfigId(usable.agents[0]?.id ?? "");
        setEnvConfigId(usable.envs[0]?.id ?? "");
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setFailure(messageOf(err));
      },
    );
    return () => abort.abort();
  }, []);

  const message = text.trim();
  const ready =
    choices !== undefined && agentConfigId !== "" && envConfigId !== "" && message !== "";
  /** Whether trying again is something this dialog may offer at all —
   *  false for either half once a request has gone unanswered. */
  const resendable = outcome?.kind !== "unconfirmed";
  /** The create is the half with nothing to fall back to. */
  const strandedCreate = outcome?.stage === "create" && outcome.kind === "unconfirmed";
  // What the pickers can't offer, said once: a session needs one of each,
  // and neither section is reachable from inside a dialog.
  const missing =
    choices === undefined
      ? undefined
      : choices.agents.length === 0 && choices.envs.length === 0
        ? "an agent config and an env config"
        : choices.agents.length === 0
          ? "an agent config"
          : choices.envs.length === 0
            ? "an env config"
            : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready || !resendable) return;

    setFailure(undefined);
    setBusy(true);

    // The session, made once and kept. Held locally as well as in state
    // because state does not move inside this call: a failure after the
    // create must know a session exists, and `created` would still read
    // undefined in this closure.
    let session = created;
    if (session === undefined) {
      try {
        // No abort signal: a create in flight is a row that may well exist,
        // so the dialog refuses to close rather than walk away from an
        // answer it would have to guess at.
        session = await createSession({ agentConfigId, envConfigId });
      } catch (err) {
        // Only the api refusing the REQUEST proves nothing was written. No
        // answer at all, a body that stopped arriving mid-json, a 5xx
        // raised after the row was committed — none of those say, and there
        // is no idempotency key to make pressing Start again safe.
        const refused = err instanceof ApiError && err.status !== undefined && err.status < 500;
        setOutcome({ stage: "create", kind: refused ? "refused" : "unconfirmed" });
        setFailure(
          refused ? messageOf(err) : `${messageOf(err)} A session may have been created even so.`,
        );
        setBusy(false);
        return;
      }
      setCreated(session);
    }

    try {
      await sendMessage(session.id, message);
      onCreated(session);
      // Opened — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      // The same rule as the create above, and the same reason: only a
      // refusal is definite. An unanswered send leaves this dialog with
      // nothing safe to offer, so it stops offering to send.
      const refused = err instanceof ApiError && err.status !== undefined && err.status < 500;
      setOutcome({ stage: "message", kind: refused ? "refused" : "unconfirmed" });
      setFailure(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Start session"
      description={
        <>
          One agent config, one env config, and the message that sets it going. Lands in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {strandedCreate ? (
            <p className="note">
              The api never answered, so a session may exist and may not. There is no id to show for
              it and no route that would say, so this dialog won&rsquo;t start another — close it
              and check the list.
            </p>
          ) : null}
          {created === undefined ? null : (
            <p className="note">
              Session <code>{created.id}</code> was created,{" "}
              {resendable
                ? "but the api refused its first message. Try again, or open the session and send it there."
                : "but the api never answered its first message — it may or may not have been sent. Open the session to see, and send it there if it wasn't."}
            </p>
          )}
          {missing === undefined ? null : (
            <p className="note">
              There is no active {missing} to start a session with. Make one in its own section
              first — an archived config keeps its sessions but can&rsquo;t take a new one.
            </p>
          )}

          <Field
            label="Agent config"
            name="agentConfigId"
            value={agentConfigId}
            onChange={setAgentConfigId}
            options={agentOptions(choices?.agents ?? [])}
            // Frozen once the session exists: it was made from these, and a
            // retry sends the message to THAT session. A select still
            // offering a choice it could no longer apply would be lying —
            // as would one on a form that has stopped being submittable.
            disabled={
              busy ||
              !resendable ||
              created !== undefined ||
              choices === undefined ||
              choices.agents.length === 0
            }
            required
          />
          <Field
            label="Env config"
            name="envConfigId"
            value={envConfigId}
            onChange={setEnvConfigId}
            options={envOptions(choices?.envs ?? [])}
            disabled={
              busy ||
              !resendable ||
              created !== undefined ||
              choices === undefined ||
              choices.envs.length === 0
            }
            required
          />
          <Field
            label="First message"
            name="message"
            value={text}
            onChange={setText}
            multiline
            rows={4}
            placeholder="What should the agent do?"
            disabled={busy || !resendable}
            autoFocus
            required
          />
        </div>

        <footer className="modal-foot">
          {failure ? (
            <p className="form-failure" role="alert">
              {failure}
            </p>
          ) : null}
          {created === undefined ? (
            // The only way on, once a create has gone unanswered: there is
            // no session to open and nothing safe to send, so leaving is
            // the action and it says so.
            <button
              className={resendable ? "btn" : "btn btn-primary"}
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              {resendable ? "Cancel" : "Close"}
            </button>
          ) : (
            // The session exists, so there is nothing left to cancel — only
            // a message that hasn't landed, which the conversation itself
            // can take instead. Where resending isn't safe this IS the way
            // on, so it leads.
            <button
              className={resendable ? "btn" : "btn btn-primary"}
              type="button"
              onClick={() => onCreated(created)}
              disabled={busy}
            >
              Open session
            </button>
          )}
          {resendable ? (
            <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
              {busy
                ? created === undefined
                  ? "Starting…"
                  : "Sending…"
                : created === undefined
                  ? "Start"
                  : "Try again"}
            </button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}
