// The driver — the claim → step → commit loop, and the Store port's
// second caller (intake is the api's write path; commitStep is ours).
// Two exports, mechanism and policy: runStep is one claim → at most one
// commit, the unit the driver tests exercise directly; runDriver is the
// production shell a worker process hosts — claim, step, repeat — until
// the process dies or the host's drain signal fires (below).
//
// The rule the durability story rests on: an interrupted step is never
// committed. A dying worker — SIGKILL, OOM, node loss — commits nothing
// mid-step; the lease expires and the next claimer resumes from the
// unchanged log — re-running an inference item, but never an
// execute_tools item: attempt > 1 marks the dead claimer, and the
// re-claim commits interrupted results instead of re-executing side
// effects (tools are at-most-once across claims). FencedError on
// commit is the same rule from the other side: the item's fate belongs
// to another claim now — drop the work, claim again. The heartbeat
// losing (or failing to reach) the lease aborts the in-flight provider
// stream and tool calls, bounding a zombie's side effects and spend.
//
// Drain is the crash path made cheap, not a second story. A scale-down
// or a deploy delivers SIGTERM a fixed few seconds before SIGKILL
// (Cloud Run: 10s), and the platform picks the instance, busy or not.
// When the drain signal fires the loop stops claiming; a held claim —
// from claimItem through the sandbox bind to commit — gets drainMs to
// finish on its own, and if it does not, the step is aborted and the
// lease released (Store.releaseItem: expiry moved to now), so the next
// poll of any live worker resumes the session at once instead of after
// the lease. The re-claim sees a released item exactly as a dead
// claimer's, so everything above still holds; and a drain that never
// completes — SIGKILL first, a store the release cannot reach — IS the
// crash path, which is therefore exercised on every unplanned death and
// on every drain that runs out of time. The aborted work is abandoned,
// not awaited: a tool that ignores its signal keeps its promise open,
// and the host exits over it.
//
// Cancellation is checked at step boundaries, never mid-step:
// requestCancel appends a control entry and the log's order scopes
// which run it addresses (see cancelRequested). At the claim boundary a
// pending cancel skips the step entirely; at the commit boundary it
// ends the run whatever the step produced. v1 cancel latency is
// therefore one step.

import type {
  AgentMessage,
  AssistantMessage,
  InferenceConfig,
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
  /** The inference adapters this worker wired, keyed by the id a
   *  config's `inference.provider` names. Resolved per claim, so
   *  sessions on one worker run on different vendors; the keys are the
   *  whole of what this worker serves (see unservedProvider). */
  providers: ReadonlyMap<string, InferenceProvider>;
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
  /** The host's drain signal (SIGTERM). Once it fires the loop claims
   *  nothing more, a held claim gets `drainMs` to commit before it is
   *  aborted and released, and runDriver returns. Without one the loop
   *  ends only with the process. */
  drain?: AbortSignal;
  /** How long a held claim may keep running after the drain fires.
   *  Default 7s: inside Cloud Run's fixed 10s SIGTERM→SIGKILL window,
   *  with room for the release's round trip and the exit. */
  drainMs?: number;
}

/**
 * Claim and run work items until the process dies or the drain signal
 * fires — there is no other exit, by design. Store failures outside the
 * fence propagate; restart policy belongs to the host (in the cloud:
 * the container restarting). Returns only by draining, holding nothing.
 */
export async function runDriver(deps: DriverDeps, opts: DriverOptions = {}): Promise<void> {
  const leaseMs = opts.leaseMs ?? 60_000;
  const idlePollMs = opts.idlePollMs ?? 1_000;
  const drainMs = opts.drainMs ?? 7_000;
  const drain = opts.drain;
  while (!drain?.aborted) {
    const claim = await deps.store.claimItem({ leaseMs, session: opts.session });
    if (!claim) {
      await sleep(idlePollMs, drain);
      continue;
    }
    // The hold is armed for the claim's whole life, bind included, and
    // the claim runs to whichever comes first: its own end, or the drain
    // deadline aborting it and releasing the lease. On the second path
    // the claim's promise is abandoned (see header) — a late failure in
    // it has no one left to report to.
    const hold = holdClaim(deps.store, claim, drain, drainMs);
    try {
      const running = runClaim(deps, claim, leaseMs, hold.signal);
      running.catch(() => {});
      await Promise.race([running, hold.released]);
    } finally {
      hold.disarm();
    }
  }
}

/** One claim, bind included: ensure-on-claim, then the step. */
async function runClaim(
  deps: DriverDeps,
  claim: Claim,
  leaseMs: number,
  abort: AbortSignal,
): Promise<void> {
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
  if (abort.aborted) return; // drained during the bind: the hold has released the claim
  await runStep(deps, claim, leaseMs, tools, abort);
}

/**
 * Arm a claim for the drain. Nothing happens until the drain fires;
 * then the claim has drainMs to reach its own end, after which the step
 * is aborted (through `signal`) and the lease released, so another
 * worker can claim the item at once. `released` settles only on that
 * path — a claim that ends in time is never released: its commit
 * decided the item's fate, and a release after a commit matches nothing
 * anyway. A release the store cannot serve is swallowed: the lease then
 * expires on its own, which is the crash path.
 */
function holdClaim(
  store: Store,
  claim: Claim,
  drain: AbortSignal | undefined,
  drainMs: number,
): { signal: AbortSignal; released: Promise<void>; disarm: () => void } {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onDeadline = async (): Promise<void> => {
    abort.abort();
    try {
      await store.releaseItem(claim.item, claim.token);
    } catch {
      // Unreachable store: the lease expires on its own — the crash path.
    }
    release();
  };
  const onDrain = (): void => {
    timer = setTimeout(() => void onDeadline(), drainMs);
  };
  if (drain?.aborted) onDrain();
  else drain?.addEventListener("abort", onDrain, { once: true });
  return {
    signal: abort.signal,
    released,
    disarm: () => {
      drain?.removeEventListener("abort", onDrain);
      clearTimeout(timer);
    },
  };
}

const EMPTY_TOOLS = new Map<string, Tool>();

/**
 * One claim → at most one commit; the tested unit of the driver — the
 * loop above is policy around it. Holds the lease via heartbeats for
 * the step's duration; a lost lease aborts the step, and an interrupted
 * step is dropped, never committed. `tools` carries the executables the
 * loop bound for an execute_tools claim; an inference step never reads
 * it. `abort` is the caller's stop (the drain deadline): the step aborts
 * exactly as on lease loss — dropped, never committed.
 */
export async function runStep(
  deps: StepDeps,
  claim: Claim,
  leaseMs: number,
  tools: Map<string, Tool> = EMPTY_TOOLS,
  abort?: AbortSignal,
): Promise<void> {
  const { store } = deps;
  // The claimed row is its own ref: a WorkItemRef for the item-addressed
  // writes, and structurally a SessionRef for the session-scoped reads —
  // the claim handed us every scope this step needs.
  const { item, token } = claim;

  // Fires on lease loss, and on the caller's abort — either way "stop
  // working; this step will not commit".
  const step = new AbortController();
  const onAbort = (): void => step.abort();
  if (abort?.aborted) step.abort();
  else abort?.addEventListener("abort", onAbort, { once: true });
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
      // `provider` is read here and nowhere else: it picks the adapter
      // and stops — it never joins the request (see the port). A
      // provider this worker did not wire fails the step in the commit,
      // not in a throw (see unservedProvider).
      const provider = deps.providers.get(config.inference.provider);
      const message = provider
        ? await inference(
            { provider, onDelta: deps.onDelta },
            {
              model: config.inference.model,
              maxTokens: config.inference.maxTokens,
              temperature: config.inference.temperature,
              system: config.systemPrompt,
              context: buildContext(entries, steering),
              tools: deps.toolSpecs,
            },
            step.signal,
          )
        : unservedProvider(config.inference, deps.providers);
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
    abort?.removeEventListener("abort", onAbort);
  }
}

/**
 * The step's outcome for a provider this worker didn't wire: an
 * error-stopped message, committed, so the run ends "error" with the
 * reason in the log. Not a throw — an uncommitted item is re-claimed on
 * lease expiry by workers with the same env, and would cycle forever.
 */
function unservedProvider(
  inference: InferenceConfig,
  providers: ReadonlyMap<string, InferenceProvider>,
): AssistantMessage {
  const served = [...providers.keys()].sort().join(", ") || "none";
  return {
    role: "assistant",
    content: [],
    model: inference.model,
    stopReason: "error",
    errorMessage: `no inference provider "${inference.provider}" on this worker (it serves: ${served})`,
  };
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

/** Sleep, cut short by the signal: an idle worker leaves on the drain
 *  rather than one poll later. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
