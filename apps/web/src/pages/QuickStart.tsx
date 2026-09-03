// apps/web/src/pages/QuickStart.tsx
// The whole quickstart as one walk: the agent config, the env config, and
// the session that pairs them — the three things a running agent is made
// of, in the order the api makes them, without visiting three sections.
//
// NOTHING IS WRITTEN UNTIL THE LAST STEP. The api has three create routes
// and this page uses all of them, but not until "Start session" is pressed,
// which is what makes walking backwards free: a step you return to is still
// a form, because the config it describes does not exist yet. That is the
// whole reason the numbers above are clickable at all.
//
// The one exception is a submit that got PART WAY, and it is the only place
// this page is complicated. Four calls run in order — agent config, env
// config, session, first message — and none of them takes an idempotency
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
  DEFAULT_NAMESPACE,
  type EnvConfig,
  type Session,
  createAgentConfig,
  createEnvConfig,
  createSession,
  sendMessage,
} from "../lib/api";
import { type AgentFields, byId, initialFields, toInference } from "../lib/agent";
import { type NetworkFields, POLICIES, toPolicy } from "../lib/network";
import { AgentFields as AgentFieldset } from "../components/AgentFields";
import { Field } from "../components/Field";
import { NetworkFields as NetworkFieldset } from "../components/NetworkFields";
import { ProviderKeys } from "../components/ProviderKeys";
import { AgentIcon, EnvironmentIcon, SessionIcon } from "../components/Icons";
import "./QuickStart.css";

/** Where a started session is opened. */
const SECTION = "#/session";

/** The three steps, in the order the api makes them. The index IS the step
 *  number, and the dots above the card are these. */
const STEPS = [
  {
    label: "Agent",
    Icon: AgentIcon,
    title: "Create the agent config",
    blurb: "The model a session thinks with, and the prompt it starts from.",
  },
  {
    label: "Environment",
    Icon: EnvironmentIcon,
    title: "Create the env config",
    blurb: "The sandbox recipe its commands run inside. Only the network is set here.",
  },
  {
    label: "Session",
    Icon: SessionIcon,
    title: "Start the session",
    blurb: "The two configs above, and the message that sets the agent going.",
  },
];

/** Which call the submit is making — for the button to name, and for a
 *  failure to say what it was doing when it stopped. */
type Stage = "agent" | "env" | "session" | "message";

/** What the submit has actually created. Empty until "Start session" is
 *  pressed, and only ever added to: a submit that stopped part way keeps
 *  what landed, so pressing again resumes rather than duplicating. */
type Made = { agent?: AgentConfig; env?: EnvConfig; session?: Session };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Only a refusal proves the call never ran: intake and every create run
 *  after the api's own checks, or not at all. Anything else — no answer, a
 *  body that stopped mid-json, a 5xx raised after the row was committed —
 *  leaves the question open. */
const refusal = (err: unknown) =>
  err instanceof ApiError && err.status !== undefined && err.status < 500;

/** One line of what a set of fields will make, for the step that shows the
 *  two configs rather than offering them. */
function policyLine(fields: NetworkFields): string {
  const label = POLICIES.find((policy) => policy.id === fields.type)?.label ?? fields.type;
  const network = toPolicy(fields);
  return network?.type === "allowlist" ? `${label}: ${network.domains.join(", ")}` : label;
}

export function QuickStart() {
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState<AgentFields>(initialFields);
  // The api's own default is where the form starts: an unrestricted recipe
  // is what posting an empty body would have made.
  const [env, setEnv] = useState<NetworkFields>({ type: "unrestricted", domains: "" });
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
  // press authorized all four, and stopping half way leaves configs with no
  // session where finishing leaves a session the list can show. What must
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
  const network = toPolicy(env);
  const message = text.trim();
  const last = STEPS.length - 1;

  /** Whether the step on screen has what it needs to be left. */
  const ready =
    step === 0
      ? provider !== undefined
      : step === 1
        ? network !== undefined
        : message !== "" && network !== undefined && provider !== undefined;

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
      const agentConfig =
        made.agent ??
        (await createAgentConfig({
          inference: toInference(agent),
          systemPrompt: agent.systemPrompt,
        }));
      setMade((prev) => ({ ...prev, agent: agentConfig }));

      stage = "env";
      setDoing("env");
      const envConfig = made.env ?? (await createEnvConfig({ network }));
      setMade((prev) => ({ ...prev, env: envConfig }));

      stage = "session";
      setDoing("session");
      const session =
        made.session ??
        (await createSession({ agentConfigId: agentConfig.id, envConfigId: envConfig.id }));
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

  return (
    <section className="qs">
      <header className="qs-head">
        <h1 className="qs-title">Quick Start</h1>
        <p className="qs-lede">
          An agent config, an env config, and a session that pairs them — made together, in the{" "}
          <code>{DEFAULT_NAMESPACE}</code> namespace. Nothing is created until the last step.
        </p>
      </header>

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
                      <code>{made.agent.id}</code> at v{made.agent.version}. Starting again picks up
                      from what is still missing.
                    </p>
                  )}
                  <AgentFieldset
                    fields={agent}
                    onChange={setAgent}
                    disabled={busy || made.agent !== undefined}
                  />
                </>
              )
            ) : step === 1 ? (
              <>
                {made.env === undefined ? null : (
                  <p className="note">
                    Already created by the attempt that stopped, so these fields are settled:{" "}
                    <code>{made.env.id}</code>. Starting again picks up from what is still missing.
                  </p>
                )}
                <NetworkFieldset
                  fields={env}
                  onChange={setEnv}
                  disabled={busy || made.env !== undefined}
                />
              </>
            ) : (
              <>
                {/* What the press will make, not what it has: these two
                    carry no id until they exist. The one exception is a
                    submit that already made them, and then the id is what
                    is worth showing. */}
                <ul className="qs-plan">
                  <li>
                    <span className="qs-plan-key">Agent config</span>
                    <span className="qs-plan-value">
                      {provider === undefined
                        ? "No provider configured"
                        : `${provider.label} · ${
                            provider.models.find((model) => model.id === agent.model)?.label ??
                            agent.model
                          }`}
                    </span>
                    <span className="qs-plan-note">
                      {agent.systemPrompt.trim() === ""
                        ? "No system prompt"
                        : agent.systemPrompt.trim()}
                    </span>
                    <span className="qs-plan-state">
                      {made.agent === undefined ? (
                        "created when you start"
                      ) : (
                        <code>{made.agent.id}</code>
                      )}
                    </span>
                  </li>
                  <li>
                    <span className="qs-plan-key">Env config</span>
                    <span className="qs-plan-value">{policyLine(env)}</span>
                    <span className="qs-plan-note">
                      No packages — the console doesn&rsquo;t set those yet.
                    </span>
                    <span className="qs-plan-state">
                      {made.env === undefined ? (
                        "created when you start"
                      ) : (
                        <code>{made.env.id}</code>
                      )}
                    </span>
                  </li>
                </ul>

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
                    show for it and no route that would say, so this page won&rsquo;t start another
                    — check the session list.
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
                    : doing === "env"
                      ? "Creating the env config…"
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
    </section>
  );
}
