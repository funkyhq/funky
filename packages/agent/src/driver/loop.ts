// The driver — the claim → step → commit loop, and the Store port's
// second caller (intake is the api's write path; commitStep is ours).
// Two exports, mechanism and policy: runStep is one claim → at most one
// commit, the unit the driver tests exercise directly; runDriver is the
// production shell a worker process hosts — claim, step, repeat — and
// it ends only with the process. Funky is cloud-only: scale-down is
// removing the container, and the crash rule makes that safe, so there
// is deliberately no stop signal and no graceful-drain path.
//
// The rule the durability story rests on: an interrupted step is never
// committed. A dying worker — SIGKILL, OOM, node loss — commits nothing
// mid-step; the lease expires and the next claimer resumes from the
// unchanged log — re-running an inference item, but never an
// execute_tools item: attempt > 1 marks the dead claimer, and the
// re-claim commits interrupted results instead of re-executing side
// effects (tools are at-most-once across claims). Shutdown IS a crash,
// so crash-safety is exercised on every shutdown. FencedError on
// commit is the same rule from the other
// side: the item's fate belongs to another claim now — drop the work,
// claim again. The only mid-step abort is internal: the heartbeat
// losing (or failing to reach) the lease aborts the in-flight provider
// stream and tool calls, bounding a zombie's side effects and spend.
//
// Cancellation is checked at step boundaries, never mid-step:
// requestCancel appends a control entry and the log's order scopes
// which run it addresses (see cancelRequested). At the claim boundary a
// pending cancel skips the step entirely; at the commit boundary it
// ends the run whatever the step produced. v1 cancel latency is
// therefore one step.

import type {
  AgentMessage,
  ProviderEvent,
  SessionEntry,
  SessionRef,
  ToolCall,
  ToolSpec,
  WorkItemRef,
} from "@funky/core";
import { buildContext } from "../engine/build-context";
import { executeTools, interruptedResult, type ToolUpdate } from "../engine/execute-tools";
import { inference } from "../engine/inference";
import { type Action, nextAction } from "../engine/next-action";
import type { Tool } from "../engine/tool";
import type { InferenceProvider } from "../ports/inference-provider";
import {
  type Claim,
  type CommitStepRequest,
  FencedError,
  type LeaseToken,
  type Store,
} from "../ports/store";

/** What one step needs. Executables are not here: runStep receives the
 *  bound map as an argument, because binding is the loop's job. */
export interface StepDeps {
  store: Store;
  provider: InferenceProvider;
  /** Static tool declarations for the inference branch. Declaring tools
   *  never needs a sandbox, so an inference-only turn never pays for
   *  one — the ensure-on-claim half of the ratified lifecycle. */
  toolSpecs: ToolSpec[];
  /** Decoration taps forwarded to the engine steps. Fire-and-forget. */
  onDelta?: (event: ProviderEvent) => void;
  onUpdate?: (update: ToolUpdate) => void;
}

export interface DriverDeps extends StepDeps {
  /** Bind the executables for a claim whose item is execute_tools:
   *  ensure the sandbox, bind the tools, hand the map to runStep. The
   *  composition root closes this over ensureSandbox +
   *  createSandboxTools; tests hand back a fixed map. A rejection is
   *  worker trouble, not tool trouble: it propagates uncommitted and
   *  the crash rule applies. Note the cost: the claim already counted,
   *  so the re-claim sees attempt > 1 and interrupts the batch rather
   *  than retrying the bind — a transient sandbox outage costs the
   *  model one recoverable batch, never a duplicated side effect. */
  bindTools(ref: SessionRef): Promise<Map<string, Tool>>;
}

export interface DriverOptions {
  /** Lease duration per claim; each heartbeat extends by this. Default 60s. */
  leaseMs?: number;
  /** Delay between empty claim attempts. Default 1s. Poll-only until a
   *  Notifier port exists. */
  idlePollMs?: number;
  /** Narrow claims to one session (the driver-per-sandbox topology). */
  session?: SessionRef;
}

/**
 * Claim and run work items until the process dies — there is no other
 * exit, by design. Store failures outside the fence propagate; restart
 * policy belongs to the host (in the cloud: the container restarting).
 */
export async function runDriver(deps: DriverDeps, opts: DriverOptions = {}): Promise<never> {
  const leaseMs = opts.leaseMs ?? 60_000;
  const idlePollMs = opts.idlePollMs ?? 1_000;
  while (true) {
    const claim = await deps.store.claimItem({ leaseMs, session: opts.session });
    if (!claim) {
      await sleep(idlePollMs);
      continue;
    }
    // Ensure-on-claim: only an execute_tools item that will actually
    // execute pays for a sandbox — a re-claim (attempt > 1) synthesizes
    // interrupted results and needs none. The bind runs on the claim's
    // initial lease — heartbeats start inside runStep — so if a slow
    // sandbox create outlives the lease, the step's commit is fenced:
    // wasted work, never wrong work.
    const tools =
      claim.item.type === "execute_tools" && claim.item.attempt === 1
        ? await deps.bindTools(claim.item)
        : undefined;
    await runStep(deps, claim, leaseMs, tools);
  }
}

const EMPTY_TOOLS = new Map<string, Tool>();

/**
 * One claim → at most one commit; the tested unit of the driver — the
 * loop above is policy around it. Holds the lease via heartbeats for
 * the step's duration; a lost lease aborts the step, and an interrupted
 * step is dropped, never committed. `tools` carries the executables the
 * loop bound for an execute_tools claim; an inference step never reads
 * it.
 */
export async function runStep(
  deps: StepDeps,
  claim: Claim,
  leaseMs: number,
  tools: Map<string, Tool> = EMPTY_TOOLS,
): Promise<void> {
  const { store } = deps;
  // The claimed row is its own ref: a WorkItemRef for the item-addressed
  // writes, and structurally a SessionRef for the session-scoped reads —
  // the claim handed us every scope this step needs.
  const { item, token } = claim;

  // Fires only on lease loss — "stop working; this step will not commit".
  const step = new AbortController();
  const heartbeat = startHeartbeat(store, item, token, leaseMs, () => step.abort());

  try {
    // The first beat is awaited: no step work — not even reads — happens
    // on a claim whose lease wasn't just revalidated. Without the await,
    // a claim that expired during the loop's sandbox bind could execute
    // a tool before the heartbeat noticed.
    await heartbeat.validated;
    if (step.signal.aborted) return;

    const entries = bySeq(await store.readEntries(item));

    // Claim boundary: a pending cancel ends the run without running the
    // step. Nothing is appended — for an execute_tools item this is the
    // cancel-before-execute path; buildContext synthesizes the interrupted
    // results whenever the log is next read. "cancelled" parks pending
    // inputs for the next intake instead of chaining.
    if (cancelRequested(entries)) {
      await store.commitStep({
        itemRef: item,
        token,
        append: [],
        next: { kind: "end_run", status: "cancelled" },
      });
      return;
    }

    let append: AgentMessage[];
    let consumeInputs: string[] | undefined;
    // The last message this step commits — the log's tail once the
    // commit lands, and the shape nextAction dispatches on.
    let tail: AgentMessage;

    if (item.type === "inference") {
      const session = await store.getSession(item);
      if (!session) throw new Error(`driver: claimed item for unknown session ${item.sessionId}`);
      const config = await store.getAgentConfig({
        namespace: session.namespace,
        agentConfigId: session.agentConfigId,
        version: session.agentConfigVersion,
      });
      if (!config) throw new Error(`driver: session ${item.sessionId} has no agent config`);
      // Drain-at-inference-prep is what makes these inputs steering: they
      // shape this context, ride in this commit before the step's output,
      // and are consumed by it.
      const pending = await store.pendingInputs(item);
      const steering = pending.map((input) => input.message);
      // config.inference.provider picked the adapter at composition and
      // is not part of the request.
      // StepDeps is structurally an InferenceDeps; no re-wrapping.
      const message = await inference(
        deps,
        {
          model: config.inference.model,
          maxTokens: config.inference.maxTokens,
          temperature: config.inference.temperature,
          system: config.systemPrompt,
          context: buildContext(entries, steering),
          tools: deps.toolSpecs,
        },
        step.signal,
      );
      append = [...steering, message];
      consumeInputs = pending.map((input) => input.id);
      tail = message;
    } else {
      // Never-retry extends across claims: attempt > 1 means an earlier
      // claimer died holding this item, and its side effects may have
      // run uncommitted — indistinguishable from not having run at all.
      // The step is not re-executed; every call settles as the same
      // interrupted result buildContext synthesizes for dangling calls,
      // and the model decides recovery from what it can see.
      const calls = tailCalls(entries);
      const results =
        item.attempt > 1
          ? calls.map((call) => interruptedResult(call))
          : await executeTools({ tools, onUpdate: deps.onUpdate }, { calls }, step.signal);
      append = results;
      // All results share one fate; the last one becomes the tail.
      const last = results[results.length - 1];
      if (!last) throw new Error("driver: executeTools returned no results");
      tail = last;
    }

    // An interrupted step is never committed (see header). The lease
    // will expire and the next claimer resumes from the unchanged log —
    // re-running inference, interrupting a tool batch (attempt > 1).
    if (step.signal.aborted) return;

    // Commit boundary: pick up cancels that landed during the step. Only
    // control entries can land mid-step — our open item bars intake from
    // appending messages — so the context cannot have grown behind us.
    const lastSeq = entries.length > 0 ? entries[entries.length - 1]?.seq : undefined;
    const delta = bySeq(await store.readEntries(item, lastSeq));
    const action = nextAction(tail, cancelRequested([...entries, ...delta]));

    await store.commitStep({
      itemRef: item,
      token,
      append,
      consumeInputs,
      next: toNext(action),
    });
  } catch (err) {
    if (err instanceof FencedError) return; // reclaimed elsewhere — drop, claim again
    throw err;
  } finally {
    heartbeat.stop();
  }
}

/**
 * Does a cancel address the run of the currently open item? A tail
 * read, not a history walk — a theorem of the one-open-item invariant:
 * while an item is open, message entries have exactly one writer, the
 * transaction that created that item (intake's started branch requires
 * no open item; commitStep requires holding the lease). So everything
 * after the log's last message entry can only be cancels and decoration
 * (custom, compaction); a trailing cancel necessarily landed during
 * this run, and a cancel behind the last message entry was already
 * answered or addressed a run that is over.
 *
 * Precondition: call only while holding the session's open item — the
 * claim IS the run-liveness bit this function would otherwise have to
 * re-derive. Consumers without a claim (a UI, the reaper, the verdict
 * fold) need that derivation; it gets built with them.
 *
 * Best-effort edge, inherent to log-order scoping: a cancel that
 * commits between the driver's boundary read and its commitStep lands
 * behind the next batch and is not seen; re-cancelling works.
 */
export function cancelRequested(entries: SessionEntry[]): boolean {
  const ordered = bySeq(entries);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const entry = ordered[i];
    if (entry?.type === "control") return true;
    if (entry?.type === "message") return false;
  }
  return false;
}

/** The calls an execute_tools item exists to run: the log tail's. */
function tailCalls(entries: SessionEntry[]): ToolCall[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const calls = entry.message.content.filter((part) => part.type === "toolCall");
      if (calls.length > 0) return calls;
    }
    break;
  }
  throw new Error("driver: execute_tools item but no tool calls at the log tail");
}

function toNext(action: Action): CommitStepRequest["next"] {
  switch (action.kind) {
    case "inference":
      return { kind: "inference" };
    case "execute_tools":
      return { kind: "execute_tools" };
    case "end_run":
      return { kind: "end_run", status: action.status };
    case "error":
      // v1 retry policy: none. The provider failure is committed — the
      // message in `append` says why — and the run ends as "error".
      return { kind: "end_run", status: "error" };
  }
}

/**
 * Extend the lease immediately and then every leaseMs / 3 until
 * stopped. The first beat is an entry-time revalidation runStep AWAITS
 * (`validated`) before doing any work: it re-covers whatever the
 * claim's initial lease already spent before the step began — above
 * all the loop's sandbox bind — so a step whose lease is already gone
 * drops before executing a single tool. A heartbeat that throws gets
 * the lost-lease response: abort the step and let the lease decide —
 * if it was actually alive, the item simply expires into a re-claim
 * (inference re-runs; a tool batch interrupts). Wasted work, never
 * wrong work.
 */
function startHeartbeat(
  store: Store,
  ref: WorkItemRef,
  token: LeaseToken,
  leaseMs: number,
  onLost: () => void,
): { validated: Promise<void>; stop: () => void } {
  const period = Math.max(1, Math.floor(leaseMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const beat = async (): Promise<void> => {
    let alive = false;
    try {
      alive = await store.heartbeat(ref, token);
    } catch {
      alive = false;
    }
    if (stopped) return;
    if (!alive) {
      onLost();
      return;
    }
    timer = setTimeout(() => void beat(), period);
  };
  return {
    validated: beat(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function bySeq(entries: SessionEntry[]): SessionEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
