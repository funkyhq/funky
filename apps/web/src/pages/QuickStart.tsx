// apps/web/src/pages/QuickStart.tsx
// The whole quickstart as one walk: the agent config, the session that
// runs it, and the message that sets it going — one step per api call, in
// the order the api takes them, without visiting two sections. Beside the
// card, the step's call as curl, rebuilt from the form on every change, so
// the walk teaches the api it drives.
//
// NOTHING IS WRITTEN UNTIL THE LAST STEP. Each step is one call, but none
// of them is sent until "Start session" is pressed,
// which is what makes walking backwards free: a step you return to is still
// a form, because the config it describes does not exist yet. That is the
// whole reason the numbers above are clickable at all.
//
// The one exception is a submit that got PART WAY, and it is the only place
// this page is complicated. Three calls run in order — agent config,
// session, first message — and none of them takes an idempotency
// key, so what has already landed must be kept and skipped on the next
// press. Two consequences follow, both visible:
//
//  - A config that exists can no longer be edited here. The step that wrote
//    it shows what was written and says so, because a form still taking
//    changes would be describing a row the api is already holding.
//  - Only the api REFUSING a call proves it never ran. An unanswered one is
//    unknown, and what this page then offers depends on what pressing again
//    would COST: a second config is a spare row nothing will ever run, so
//    that is offered and named; a second session or a repeated first
//    message is a second agent set going, or one told the same thing twice,
//    so those stop the walk and point at the session list instead.
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type AgentConfig,
  ApiError,
  type CreateAgentConfigInput,
  DEFAULT_NAMESPACE,
  type Packages,
  type Session,
  createAgentConfig,
  createSession,
  sendMessage,
} from "../lib/api";
import { type AgentFields, byId, initialFields, toInference } from "../lib/agent";
import { type NetworkFields, POLICIES, toPolicy } from "../lib/network";
import { compact, packagesLine } from "../lib/packages";
import { PRELUDE, agentConfigCall, messageCall, sessionCall } from "../lib/curl";
import { AgentFields as AgentFieldset } from "../components/AgentFields";
import { Field } from "../components/Field";
import { NetworkFields as NetworkFieldset } from "../components/NetworkFields";
import { PackagesFields } from "../components/PackagesFields";
import { ProviderKeys } from "../components/ProviderKeys";
import { AgentIcon, SendIcon, SessionIcon } from "../components/Icons";
import "./QuickStart.css";

/** Where a started session is opened. */
const SECTION = "#/session";

/** The three steps, one per call, in the order the api takes them. The
 *  index IS the step number, and the dots above the card are these.
 *  `route` heads the curl panel, `comment` opens the call inside it. */
const STEPS = [
  {
    label: "Agent",
    Icon: AgentIcon,
    title: "Create the agent config",
    blurb:
      "The model a session thinks with, the prompt it starts from, the network its commands can reach, and the packages installed for them.",
    route: "POST /v1/agent-configs",
    comment: "# 1. the agent config: the model, the prompt, and its sandbox",
  },
  {
    label: "Session",
    Icon: SessionIcon,
    title: "Create the session",
    blurb: "Review the agent and its sandbox. The session runs exactly this.",
    route: "POST /v1/sessions",
    comment: "# 2. a session pinning it ($AID is step 1's answer)",
  },
  {
    label: "Message",
    Icon: SendIcon,
    title: "Send the first message",
    blurb: "What sets the agent going. A worker picks the session up once it has work.",
    route: "POST /v1/sessions/:id/messages",
    comment: "# 3. its first message ($SID is step 2's answer)",
  },
];

/** Which call the submit is making — for the button to name, and for a
 *  failure to say what it was doing when it stopped. */
type Stage = "agent" | "session" | "message";

/** What the submit has actually created. Empty until "Start session" is
 *  pressed, and only ever added to: a submit that stopped part way keeps
 *  what landed, so pressing again resumes rather than duplicating. */
type Made = { agent?: AgentConfig; session?: Session };

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
  /** The stage whose call went unanswered, when repeating it is not this
   *  page's to offer — a session that may exist, or a message that may have
   *  been delivered. Set once and never cleared: no read settles either. */
  const [stranded, setStranded] = useState<"session" | "message">();

  const card = useRef<HTMLDivElement>(null);
  // Whether this page is still the one on screen. Nothing aborts the chain
  // when it goes away — a sidebar link or the Back button unmounts this
  // while a create is still out — and the calls are worth finishing: the
  // press authorized all three, and stopping half way leaves a config with
  // no session where finishing leaves a session the list can show. What must
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
  const message = text.trim();
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
   *  two ask only what the config needs; the session adds nothing to fill. */
  const ready = provider !== undefined && network !== undefined && (step < last || message !== "");

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
    if (busy || !ready || stranded !== undefined || network === undefined) return;
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

      stage = "session";
      setDoing("session");
      const session = made.session ?? (await createSession({ agentConfigId: agentConfig.id }));
      setMade((prev) => ({ ...prev, session }));

      stage = "message";
      setDoing("message");
      await sendMessage(session.id, message);

      // Into the conversation, which is where a session that has been
      // given its first message belongs — an assignment, so Back returns
      // here. Only while this page is still the one on screen (see `live`):
      // the session is made either way, and the list has it.
      if (live.current) window.location.hash = `${SECTION}/${session.id}`;
    } catch (err) {
      const refused = refusal(err);
      if (!refused && (stage === "session" || stage === "message")) setStranded(stage);
      setFailure(
        refused || stage === "session" || stage === "message"
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
  const call =
    step === 0 ? agentConfigCall(agentInput) : step === 1 ? sessionCall() : messageCall(message);
  const script = `${PRELUDE}\n\n${current.comment}\n${call}`;

  return (
    <section className="qs">
      <header className="qs-head">
        <h1 className="qs-title">Quick Start</h1>
        <p className="qs-lede">
          An agent config, a session that runs it, and its first message — one api call per step, in
          the <code>{DEFAULT_NAMESPACE}</code> namespace. Nothing is created until the last step;
          beside each one is its call as curl.
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
              ) : step === 1 ? (
                <>
                  {made.agent === undefined ? null : (
                    <p className="note">
                      Already created by the attempt that stopped: <code>{made.agent.id}</code> at v
                      {made.agent.version}
                      {made.session === undefined ? null : (
                        <>
                          , and its session <code>{made.session.id}</code>
                        </>
                      )}
                      .
                    </p>
                  )}
                  {/* The config as the session will run it, one field per
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
                </>
              ) : (
                <>
                  {made.session === undefined ? null : (
                    <p className="note">
                      Session <code>{made.session.id}</code> was created,{" "}
                      {stranded === "message"
                        ? "but the api never answered its first message — it may or may not have been sent. Open it to see, and send it there if it wasn't."
                        : "but the api refused its first message. Try again, or open the session and send it there."}
                    </p>
                  )}
                  {stranded === "session" ? (
                    <p className="note">
                      The api never answered, so a session may exist and may not. There is no id to
                      show for it and no route that would say, so this page won&rsquo;t start
                      another — check the session list.
                    </p>
                  ) : null}

                  <Field
                    label="First message"
                    name="message"
                    value={text}
                    onChange={setText}
                    multiline
                    rows={4}
                    placeholder="What should the agent do?"
                    disabled={busy || stranded !== undefined}
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
              through, and the way out of it is one Next away.

              On the last step a session that exists takes the button: it is
              the thing that was being made, so it leads once starting can't
              finish here. */}
            {step < last ? (
              <button className="btn btn-primary" type="submit" disabled={!ready}>
                Next
              </button>
            ) : (
              <>
                {made.session === undefined ? null : (
                  // The session exists whatever became of its first message,
                  // so the way into it is offered from here on: beside Try
                  // again where the message may be sent again, and AS the way
                  // on where it may not — the log there says whether it
                  // arrived, and the composer can send it if it didn't.
                  <a
                    className={stranded === "message" ? "btn btn-primary" : "btn"}
                    href={`${SECTION}/${made.session.id}`}
                  >
                    Open session
                  </a>
                )}
                {stranded === "session" ? (
                  <a className="btn btn-primary" href={SECTION}>
                    Go to sessions
                  </a>
                ) : stranded === "message" ? null : (
                  <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
                    {doing === "agent"
                      ? "Creating the agent config…"
                      : doing === "session"
                        ? "Creating the session…"
                        : doing === "message"
                          ? "Sending the first message…"
                          : made.session === undefined
                            ? "Start session"
                            : "Try again"}
                  </button>
                )}
              </>
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
