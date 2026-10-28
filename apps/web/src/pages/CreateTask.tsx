// apps/web/src/pages/CreateTask.tsx
// The New Task dialog: the agent config to hand the work to, and the work.
//
// One call. The api creates the task's session and gives it its first
// message in the same transaction, so there is no half-made state to
// answer for: a task either exists, running, or it doesn't.
//
// The route takes no idempotency key, so a request whose ANSWER is lost
// cannot be told apart from one that was refused. Only the api REFUSING the
// request proves nothing was written, so that is the one failure this
// dialog offers to send again. An unanswered one may have made a task, and
// sending again could set a second agent going on the same work, so the
// dialog stops offering and points at the list instead.
//
// The picker offers ACTIVE configs only. An archived one is readable and
// keeps its running tasks, but nothing new may name it — the api answers
// 409 — so offering it would be offering a refusal.
import { type FormEvent, type RefObject, useEffect, useState } from "react";
import {
  type AgentConfig,
  ApiError,
  DEFAULT_NAMESPACE,
  type NetworkPolicy,
  type Task,
  createTask,
  listAgentConfigs,
} from "../lib/api";
import { Field, type FieldOption } from "../components/Field";
import { Modal } from "../components/Modal";

/**
 * How deep the picker reads. One page, at the api's ceiling: a picker is a
 * choice, not an inventory, and a namespace with more than this many configs
 * is one where picking from a list has stopped being the way to start work
 * anyway. The sections themselves page properly.
 */
const PICKER_LIMIT = 100;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const active = (config: { archivedAt?: string }) => config.archivedAt === undefined;

/** Enough of an id to tell two rows apart at a glance. */
const short = (id: string) => id.slice(0, 8);

/** What a config's sandbox does to the network. */
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
    label: `${config.inference.model} · v${config.version} · ${networkLabel(config.network)} · ${short(config.id)}`,
  }));

export function CreateTask({
  onCreated,
  onClose,
  returnFocus,
}: {
  /** The new task. The caller opens it — creating one is how you get to
   *  the conversation, not an end in itself. */
  onCreated: (task: Task) => void;
  onClose: () => void;
  /** Focus lands here if creating the task removed whatever opened this
   *  (Modal's `returnFocus`) — the first row replaces the empty state. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  /** The active configs a task can name, once the list lands. */
  const [agents, setAgents] = useState<AgentConfig[]>();
  const [agentConfigId, setAgentConfigId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** A create that went unanswered: a task may exist, so this dialog stops
   *  offering to make one. Set once and never cleared — no read settles it. */
  const [unconfirmed, setUnconfirmed] = useState(false);
  // The api's refusal — of the create, or of the read that fills the picker.
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    listAgentConfigs({ limit: PICKER_LIMIT, signal: abort.signal }).then(
      (page) => {
        const usable = page.data.filter(active);
        setAgents(usable);
        // The newest, which is what the list leads with — the likeliest
        // choice, and never an empty select showing nothing.
        setAgentConfigId(usable[0]?.id ?? "");
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setFailure(messageOf(err));
      },
    );
    return () => abort.abort();
  }, []);

  const content = text.trim();
  const ready = agents !== undefined && agentConfigId !== "" && content !== "";
  // What the picker can't offer, said once: a task needs a config, and its
  // section isn't reachable from inside a dialog.
  const missing = agents !== undefined && agents.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready || unconfirmed) return;

    setFailure(undefined);
    setBusy(true);
    try {
      // No abort signal: a create in flight is a task that may well exist,
      // so the dialog refuses to close rather than walk away from an answer
      // it would have to guess at.
      onCreated(await createTask({ agentConfigId, content }));
      // Opened — the caller unmounts this, so there is no state to reset.
    } catch (err) {
      // Only the api refusing the REQUEST proves nothing was written. No
      // answer at all, a body that stopped arriving mid-json, a 5xx raised
      // after the row was committed — none of those say.
      const refused = err instanceof ApiError && err.status !== undefined && err.status < 500;
      if (!refused) setUnconfirmed(true);
      setFailure(
        refused ? messageOf(err) : `${messageOf(err)} A task may have been created even so.`,
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New task"
      description={
        <>
          The agent config to run it, and what it should do. Lands in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace.
        </>
      }
      dismissible={!busy}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit} noValidate>
        <div className="modal-body form-fields">
          {unconfirmed ? (
            <p className="note">
              The api never answered, so a task may exist and may not. This dialog won&rsquo;t
              create another — close it and check the list.
            </p>
          ) : null}
          {missing ? (
            <p className="note">
              There is no active agent config to give a task to. Make one in its own section first —
              an archived config keeps its tasks but can&rsquo;t take a new one.
            </p>
          ) : null}

          <Field
            label="Agent config"
            name="agentConfigId"
            value={agentConfigId}
            onChange={setAgentConfigId}
            options={agentOptions(agents ?? [])}
            disabled={busy || unconfirmed || agents === undefined || agents.length === 0}
            required
          />
          <Field
            label="Task"
            name="content"
            value={text}
            onChange={setText}
            multiline
            rows={4}
            placeholder="What should the agent do?"
            disabled={busy || unconfirmed}
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
          <button
            // The only way on once a create has gone unanswered, so it
            // leads and says so.
            className={unconfirmed ? "btn btn-primary" : "btn"}
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            {unconfirmed ? "Close" : "Cancel"}
          </button>
          {unconfirmed ? null : (
            <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
              {busy ? "Creating…" : "Create task"}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
