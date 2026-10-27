// apps/web/src/pages/QuickStart.tsx
// The whole quickstart as one walk: the agent config, then the task that
// sets it going — one step per api call, in the order the api takes them,
// without visiting two sections. Beside the card, the step's call as curl,
// rebuilt from the form on every change, so the walk teaches the api it
// drives.
//
// NOTHING IS WRITTEN UNTIL THE LAST STEP. Each step is one call, but none
// of them is sent until "Create task" is pressed, which is what makes
// walking backwards free: a step you return to is still a form, because the
// config it describes does not exist yet. That is the whole reason the
// numbers above are clickable at all.
//
// The one exception is a submit that got PART WAY, and it is the only place
// this page is complicated. Two calls run in order — agent config, then
// task — and neither takes an idempotency key, so a config that has already
// landed must be kept and skipped on the next press. Two consequences
// follow, both visible:
//
//  - A config that exists can no longer be edited here. The step that wrote
//    it shows what was written and says so, because a form still taking
//    changes would be describing a row the api is already holding.
//  - Only the api REFUSING a call proves it never ran. An unanswered one is
//    unknown, and what this page then offers depends on what pressing again
//    would COST: a second config is a spare row nothing will ever run, so
//    that is offered and named; a second task is a second agent set going
//    on the same work, so that stops the walk and points at the task list
//    instead.
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type AgentConfig,
  ApiError,
  type CreateAgentConfigInput,
  DEFAULT_NAMESPACE,
  type Packages,
  createAgentConfig,
  createTask,
} from "../lib/api";
import { type AgentFields, byId, initialFields, toInference } from "../lib/agent";
import { type NetworkFields, POLICIES, toPolicy } from "../lib/network";
import { compact, packagesLine } from "../lib/packages";
import { PRELUDE, agentConfigCall, taskCall } from "../lib/curl";
import { AgentFields as AgentFieldset } from "../components/AgentFields";
import { Field } from "../components/Field";
import { NetworkFields as NetworkFieldset } from "../components/NetworkFields";
import { PackagesFields } from "../components/PackagesFields";
import { ProviderKeys } from "../components/ProviderKeys";
import { AgentIcon, TaskIcon } from "../components/Icons";
import "./QuickStart.css";

/** Where a created task is opened. */
const SECTION = "#/task";

/** The two steps, one per call, in the order the api takes them. The
 *  index IS the step number, and the dots above the card are these.
 *  `route` heads the curl panel, `comment` opens the call inside it. */
const STEPS = [
  {
    label: "Agent",
    Icon: AgentIcon,
    title: "Create the agent config",
    blurb:
      "The model the agent thinks with, the prompt it starts from, the network its commands can reach, and the packages installed for them.",
    route: "POST /v1/agent-configs",
    comment: "# 1. the agent config: the model, the prompt, and its sandbox",
  },
  {
    label: "Task",
    Icon: TaskIcon,
    title: "Create the task",
    blurb: "What the agent should do. A worker picks the task up and runs it on the config below.",
    route: "POST /v1/tasks",
    comment: "# 2. the task ($AID is step 1's answer; $SID is where its log is)",
  },
];

/** Which call the submit is making — for the button to name, and for a
 *  failure to say what it was doing when it stopped. */
type Stage = "agent" | "task";

/** What the submit has actually created. Empty until "Create task" is
 *  pressed, and only ever added to: a submit that stopped part way keeps
 *  the config that landed, so pressing again resumes rather than
 *  duplicating. A task that lands ends the walk, so it is never kept. */
type Made = { agent?: AgentConfig };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Only a refusal proves the call never ran: intake and every create run
 *  after the api's own checks, or not at all. Anything else — no answer, a
 *  body that stopped mid-json, a 5xx raised after the row was committed —
 *  leaves the question open. */
const refusal = (err: unknown) =>
  err instanceof ApiError && err.status !== undefined && err.status < 500;

/** One line of what the network fields will make, for the step that shows
 *  the config rather than offering it: the policy's name without the gloss
 *  the picker gives it ("Unrestricted", not "Unrestricted — reach anything"). */
function policyLine(fields: NetworkFields): string {
  const option = POLICIES.find((policy) => policy.id === fields.type)?.label ?? fields.type;
  const label = option.split(" — ")[0];
  const network = toPolicy(fields);
  return network?.type === "allowlist" ? `${label}: ${network.domains.join(", ")}` : label;
}

/** Copies the panel's script, and says so for a moment — only once the
 *  clipboard has taken it, so a refused write never reads as done. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="btn qs-call-copy"
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function QuickStart() {
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState<AgentFields>(initialFields);
  // The policy starts open: reach anything.
  const [networkFields, setNetworkFields] = useState<NetworkFields>({
    type: "unrestricted",
    domains: "",
  });
  const [packages, setPackages] = useState<Packages>({});
  const [text, setText] = useState("");
  /** Which call is out, when one is. Absent between presses. */
  const [doing, setDoing] = useState<Stage>();
  const [failure, setFailure] = useState<string>();
  const [made, setMade] = useState<Made>({});
  /** Whether the task create went unanswered, so a task may exist and
   *  pressing again is not this page's to offer. Set once and never
   *  cleared: no read settles it. */
  const [stranded, setStranded] = useState(false);

  const card = useRef<HTMLDivElement>(null);
  // Whether this page is still the one on screen. Nothing aborts the chain
  // when it goes away — a sidebar link or the Back button unmounts this
  // while a create is still out — and the calls are worth finishing: the
  // press authorized both, and stopping half way leaves a config with no
  // task where finishing leaves a task the list can show. What must
  // NOT survive the unmount is the navigation, which would pull someone
  // into a conversation they have already walked away from.
  const live = useRef(true);
  // The step the card is currently showing, so the focus move below happens
  // on a CHANGE of step rather than on a mount. StrictMode mounts twice,
  // and a page that took focus on arrival would steal it from the sidebar
  // link that got here.
  const shown = useRef(step);

  useEffect(() => {
    // Set on the way in as well as cleared on the way out: StrictMode
    // mounts twice, and an effect that only cleared would leave this false
    // for the whole life of the second mount — guarding a navigation that
    // should have happened.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    // The same attribute Modal focuses on open, so a fieldset says where
    // focus belongs once and both surfaces honour it.
    card.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  const busy = doing !== undefined;
  const provider = byId(agent.provider);
  // Absent while the allowlist has no domain on it — the one state of the
  // network form that isn't a policy yet (see toPolicy).
  const network = toPolicy(networkFields);
  const packagesSummary = packagesLine(packages);
  const content = text.trim();
  const last = STEPS.length - 1;

  /** The agent config create, as the submit sends it and the panel shows
   *  it. An allowlist with no domain yet is shown as the empty list it is;
   *  it is never sent, since `ready` holds the walk until it has one. */
  const agentInput: CreateAgentConfigInput = {
    inference: toInference(agent),
    systemPrompt: agent.systemPrompt,
    network: network ?? { type: "allowlist", domains: [] },
    packages: compact(packages),
    // None, on purpose: a credential needs a stored key, and the walk
    // stays the short path. The agent's edit dialog adds them.
    credentials: [],
    setupCommands: [],
  };

  /** Whether the step on screen has what it needs to be left. The first
   *  asks what the config needs; the last adds the task itself. */
  const ready = provider !== undefined && network !== undefined && (step < last || content !== "");

  /** Back to a step already passed. Not forward: every step is left through
   *  its own button, which is what checks it has what it needs. */
  function goTo(index: number) {
    if (busy || index >= step) return;
    setFailure(undefined);
    setStep(index);
  }

  /**
   * The whole quickstart, in the order the api takes it. Each call is
   * skipped when a previous press already made it, so this is both the
   * submit and the resume — and the two are the same thing, since only what
   * is missing is ever sent.
   */
  async function start() {
    if (busy || !ready || stranded || network === undefined) return;
    setFailure(undefined);

    // Which call is out. Kept here rather than read back from state so the
    // catch below knows what stopped, and so each answer is recorded before
    // the next call goes out.
    let stage: Stage = "agent";
    try {
      setDoing("agent");
      // No abort signal on any of these: a create in flight is a row that
      // may well exist, so this page waits for its answer rather than
      // walking away from one it would then have to guess at.
      const agentConfig = made.agent ?? (await createAgentConfig(agentInput));
      setMade((prev) => ({ ...prev, agent: agentConfig }));

      stage = "task";
      setDoing("task");
      const task = await createTask({ agentConfigId: agentConfig.id, content });

      // Into the conversation, which is where a task that has started
      // belongs — an assignment, so Back returns here. Only while this page
      // is still the one on screen (see `live`): the task is made either
      // way, and the list has it.
      if (live.current) window.location.hash = `${SECTION}/${task.id}`;
    } catch (err) {
      const refused = refusal(err);
      if (!refused && stage === "task") setStranded(true);
      setFailure(
        refused || stage === "task"
          ? messageOf(err)
          : // A config create that went unanswered. Pressing again is
            // allowed here and nowhere else, because the worst it can cost
            // is one unused row: a config runs nothing by itself.
            `${messageOf(err)} A config may have been created even so — starting again may leave a` +
              " spare one behind, which nothing will run.",
      );
      setDoing(undefined);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step < last) {
      if (ready) setStep(step + 1);
      return;
    }
    void start();
  }

  const current = STEPS[step];
  const call = step === 0 ? agentConfigCall(agentInput) : taskCall(content);
  const script = `${PRELUDE}\n\n${current.comment}\n${call}`;

  return (
    <section className="qs">
      <header className="qs-head">
        <h1 className="qs-title">Quick Start</h1>
        <p className="qs-lede">
          An agent config, and a task that sets it going — one api call per step, in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace. Nothing is created until the last step; beside
          each one is its call as curl.
        </p>
      </header>

      {/* Steps over the card, the call beside it: a grid of named areas
          rather than nested columns, so a narrow pane can drop the call
          under the card without moving any of the three. */}
      <div className="qs-layout">
        <ol className="qs-steps">
          {STEPS.map((entry, index) => {
            const state = index === step ? "now" : index < step ? "done" : "todo";
            return (
              <li className={`qs-step qs-step-${state}`} key={entry.label}>
                {state === "done" ? (
                  // Only the steps already passed are targets. Forward is
                  // through the button on the card, which is what checks the
                  // step it is leaving.
                  <button
                    className="qs-dot"
                    type="button"
                    onClick={() => goTo(index)}
                    disabled={busy}
                    aria-label={`Back to step ${index + 1}, ${entry.label}`}
                  >
                    {index + 1}
                  </button>
                ) : (
                  <span className="qs-dot" aria-current={state === "now" ? "step" : undefined}>
                    {index + 1}
                  </span>
                )}
                <span className="qs-step-label">{entry.label}</span>
              </li>
            );
          })}
        </ol>

        <form className="qs-card" onSubmit={submit} noValidate>
          <div className="qs-body" ref={card}>
            <p className="qs-card-title">
              <current.Icon width={15} height={15} strokeWidth={1.7} aria-hidden="true" />
              {current.title}
            </p>
            <p className="qs-blurb">{current.blurb}</p>

            <div className="form-fields">
              {step === 0 ? (
                provider === undefined ? (
                  // Nothing truthful to offer: a config names the provider
                  // that will serve it, and the console lists only providers
                  // this stack has a key for.
                  <div className="note">
                    <p>
                      No provider is configured, so there is no model to name. Add a key to the
                      monorepo root <code>.env</code> — the same file <code>docker compose up</code>{" "}
                      reads — then restart the dev server.
                    </p>
                    <ProviderKeys />
                  </div>
                ) : (
                  <>
                    {made.agent === undefined ? null : (
                      <p className="note">
                        Already created by the attempt that stopped, so these fields are settled:{" "}
                        <code>{made.agent.id}</code> at v{made.agent.version}. Starting again picks
                        up from what is still missing.
                      </p>
                    )}
                    <AgentFieldset
                      fields={agent}
                      onChange={setAgent}
                      disabled={busy || made.agent !== undefined}
                    />
                    <NetworkFieldset
                      fields={networkFields}
                      onChange={setNetworkFields}
                      disabled={busy || made.agent !== undefined}
                      autoFocus={false}
                    />
                    <PackagesFields
                      packages={packages}
                      onChange={setPackages}
                      disabled={busy || made.agent !== undefined}
                    />
                  </>
                )
              ) : (
                <>
                  {made.agent === undefined ? null : (
                    <p className="note">
                      Already created by the attempt that stopped: <code>{made.agent.id}</code> at v
                      {made.agent.version}.
                    </p>
                  )}
                  {stranded ? (
                    <p className="note">
                      The api never answered, so a task may exist and may not. This page won&rsquo;t
                      create another — check the task list.
                    </p>
                  ) : null}
                  {/* The config as the task will run it, one field per
                      card: what the press will send, not a row that exists —
                      there is no id to show until it does. */}
                  <dl className="qs-review">
                    <div>
                      <dt>Model</dt>
                      <dd className="qs-review-mono">
                        {provider === undefined
                          ? "No provider configured"
                          : (provider.models.find((model) => model.id === agent.model)?.label ??
                            agent.model)}
                      </dd>
                    </div>
                    <div>
                      <dt>System prompt</dt>
                      {agent.systemPrompt.trim() === "" ? (
                        <dd className="qs-review-none">None</dd>
                      ) : (
                        <dd className="qs-review-prompt">{agent.systemPrompt.trim()}</dd>
                      )}
                    </div>
                    <div>
                      <dt>Network</dt>
                      <dd>{policyLine(networkFields)}</dd>
                    </div>
                    <div>
                      <dt>Packages</dt>
                      {packagesSummary === "none" ? (
                        <dd className="qs-review-none">None</dd>
                      ) : (
                        <dd className="qs-review-mono">{packagesSummary}</dd>
                      )}
                    </div>
                  </dl>

                  <Field
                    label="Task"
                    name="content"
                    value={text}
                    onChange={setText}
                    multiline
                    rows={4}
                    placeholder="What should the agent do?"
                    disabled={busy || stranded}
                    autoFocus
                    required
                  />
                </>
              )}
            </div>
          </div>

          <footer className="qs-foot">
            {failure ? (
              <p className="form-failure" role="alert">
                {failure}
              </p>
            ) : null}

            {step > 0 ? (
              <button className="btn" type="button" onClick={() => goTo(step - 1)} disabled={busy}>
                Back
              </button>
            ) : null}

            {/* Next until the last step, whatever the last step has already
              done: a walk that stopped is still a walk you can read back
              through, and the way out of it is one Next away. */}
            {step < last ? (
              <button className="btn btn-primary" type="submit" disabled={!ready}>
                Next
              </button>
            ) : stranded ? (
              <a className="btn btn-primary" href={SECTION}>
                Go to tasks
              </a>
            ) : (
              <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
                {doing === "agent"
                  ? "Creating the agent config…"
                  : doing === "task"
                    ? "Creating the task…"
                    : made.agent === undefined
                      ? "Create task"
                      : "Try again"}
              </button>
            )}
          </footer>
        </form>

        {/* What this step's call is, as curl, rebuilt from the form on every
          change. Not live-announced: it changes with every keystroke, and
          the form it mirrors is what is being read. */}
        <aside className="qs-call" aria-label="This step's api call">
          <div className="qs-call-head">
            <span className="qs-call-title">API call</span>
            <code className="qs-call-route">{current.route}</code>
            <CopyButton text={script} />
          </div>
          <pre className="qs-call-code">
            <code>
              {PRELUDE}
              {"\n\n"}
              <span className="qs-call-comment">{current.comment}</span>
              {"\n"}
              {call}
            </code>
          </pre>
        </aside>
      </div>
    </section>
  );
}
