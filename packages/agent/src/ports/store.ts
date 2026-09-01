import type {
  AgentConfig,
  AgentConfigRef,
  AgentConfigVersionRef,
  AgentMessage,
  CreateAgentConfigRequest,
  CreateEnvConfigRequest,
  CreateSessionRequest,
  EnvConfig,
  EnvConfigRef,
  InputId,
  IntakeResult,
  ListAgentConfigsRequest,
  ListEnvConfigsRequest,
  ListSessionsRequest,
  PendingInput,
  Session,
  SessionEntry,
  SessionRef,
  UpdateAgentConfigRequest,
  UpdateEnvConfigRequest,
  UserMessage,
  WorkItem,
  WorkItemRef,
} from "@funky/core";
import type { RunEndStatus } from "../engine/next-action";

/**
 * The Store port — the harness's single source of truth. Deliberately one
 * interface, not three: commitStep must span entries, work items, and
 * pending inputs in one transaction, and splitting the interface would
 * lie about that atomicity.
 *
 * Two run write paths, two callers: the api calls intake, the driver calls
 * commitStep. They are the only run-status mutations in the system, and
 * work items are born only inside their transactions — which is why there
 * is no createWorkItem. archiveSession is the separate terminal lifecycle
 * transition and may land only while neither path has left an open item.
 *
 * The load-bearing invariant: at most one open (non-done) item per
 * session. "Busy" IS an open item's existence, and a run's end is the
 * atomic NON-creation of a next one. Adapters enforce it structurally
 * (a unique partial index or equivalent); the intake transaction is the
 * race referee.
 *
 * Envelopes are store-minted inside the writing transaction: callers
 * hand payloads and requests, the store assigns id/createdAt on rows and
 * id/seq/timestamp on entries.
 *
 * Backend neutrality: the interface is domain-shaped and never exposes a
 * transaction handle. Any backend with multi-record ACID transactions,
 * CAS claiming, per-session monotonic seq, and unique constraints can
 * implement it; the conformance suite keeps that honest.
 *
 * Addressing is by namespace-scoped ref throughout (the config refs,
 * SessionRef, WorkItemRef): the namespace is part of the address, not a
 * filter, and a foreign row answers exactly like a nonexistent one —
 * undefined from gets, empty from list reads, "unknown" from write
 * paths. WorkItemRef carries its parent sessionId too, and a mismatched
 * parent is foreign the same way. The api builds refs from its
 * gateway-derived namespace; the driver builds them from the claimed
 * item's own fields, and never decides on them.
 */
export interface Store {
  // --- configs ---

  /** Create the first version of an agent config. Namespace must be specified. */
  createAgentConfig(req: CreateAgentConfigRequest): Promise<AgentConfigRef>;
  /** Returns the latest config, or the exact version when the ref specifies one. */
  getAgentConfig(ref: AgentConfigRef | AgentConfigVersionRef): Promise<AgentConfig | undefined>;
  /**
   * Partially update one namespace's agent config. Omitted fields are
   * preserved. A supplied version is an optimistic-concurrency precondition;
   * mismatch throws VersionConflictError, while an unknown or foreign id is
   * undefined. Every successful mutation increments the stored version; a
   * request containing only the precondition is a read-like no-op.
   *
   * An archived config is read-only: a mutation throws ArchivedError, and
   * that verdict precedes a stale version's — archived is terminal, so
   * retrying with a fresher version would only fail again.
   */
  updateAgentConfig(
    ref: AgentConfigRef,
    req: UpdateAgentConfigRequest,
  ): Promise<AgentConfig | undefined>;
  /**
   * Archive one namespace's agent config — the terminal transition, and
   * the only state change that is not an edit. The row stays readable and
   * every version stays resolvable, so sessions that already pinned one
   * run on untouched; what stops is future writes (updateAgentConfig
   * throws ArchivedError) and future references (createSession rejects
   * it). There is no unarchive, which is what makes this idempotent: a
   * second archive is a no-op returning the first one's archivedAt.
   */
  archiveAgentConfig(ref: AgentConfigRef): Promise<AgentConfig | undefined>;
  /** One namespace's agent configs, newest first — see ListAgentConfigsRequest. */
  listAgentConfigs(req: ListAgentConfigsRequest): Promise<AgentConfig[]>;

  /** Create an environment config. Namespace must be specified. */
  createEnvConfig(req: CreateEnvConfigRequest): Promise<EnvConfigRef>;
  /** Returns the namespace-scoped environment config. */
  getEnvConfig(ref: EnvConfigRef): Promise<EnvConfig | undefined>;
  /**
   * Partially update one namespace's environment config in place. Omitted
   * fields are preserved; a real edit advances updatedAt, while an empty
   * request is a read-like no-op that preserves it. Namespace is immutable
   * and carried by the ref. An unknown or foreign ref is indistinguishable
   * from absence and returns undefined.
   *
   * An archived config is read-only: a mutation throws ArchivedError. An
   * empty request remains a read and returns the archived row unchanged.
   *
   * In place means exactly that: there is no version history, and this
   * reaches no existing session. Sessions carry their own copy of the
   * recipe (createSession), so an update changes only what sessions
   * created after it will provision from.
   */
  updateEnvConfig(ref: EnvConfigRef, req: UpdateEnvConfigRequest): Promise<EnvConfig | undefined>;
  /**
   * Archive one namespace's environment config. The row stays readable and
   * sessions that already copied its recipe keep running; future writes and
   * references from new sessions are refused. Archiving does not edit the
   * recipe, so updatedAt is preserved. There is no unarchive, making repeat
   * calls idempotent: they return the original archivedAt.
   */
  archiveEnvConfig(ref: EnvConfigRef): Promise<EnvConfig | undefined>;
  /** One namespace's env configs, newest first — see ListEnvConfigsRequest. */
  listEnvConfigs(req: ListEnvConfigsRequest): Promise<EnvConfig[]>;

  // --- sessions ---

  /** Create a session, making both configs durable against later edits:
   *  PINS the requested agent version (or the latest when omitted), and
   *  COPIES the env config's resolved recipe onto the row as
   *  envConfigSnapshot — env configs update in place, so there is no
   *  version to pin, and an implementation that stored only the reference
   *  would let an edit reshape a running session's world. Namespace must
   *  be specified. Rejects unknown configs or versions with
   *  namespace-scoped checks, so foreign ids remain indistinguishable from
   *  nonexistent ones, and either archived config with ArchivedError.
   *  Archiving and creating are serialized on each config row: a session
   *  either commits before an archive or sees it — never lands after one.
   *  The env config row is read under the same discipline, so the copy is
   *  always of a committed, active state. */
  createSession(req: CreateSessionRequest): Promise<SessionRef>;
  getSession(ref: SessionRef): Promise<Session | undefined>;
  /**
   * Permanently archive an idle session. The row and its history remain
   * readable, but intake, cancellation, and sandbox rebinding become
   * read-only conflicts. A non-done work item is the session's running
   * state, so attempting the transition while one exists throws
   * SessionNotIdleError. A cancelled run parks its pending inputs for the
   * next intake and archive guarantees there is no next one, so the
   * transition drains them into the log — appended as entries in arrival
   * order, chaining nothing. The archive check and intake/commit transitions
   * serialize on the session row: archive cannot race a session from idle
   * into running. Repeating an archive is an idempotent read of the first
   * archivedAt; unknown and foreign refs return undefined.
   */
  archiveSession(ref: SessionRef): Promise<Session | undefined>;
  /** Register the session's one sandbox: a compare-and-set on the
   *  binding — fills a null binding when `previous` is omitted, or
   *  replaces exactly `previous` when the caller is recovering a dead
   *  sandbox. Returns the bound id either way: the atomic pick that
   *  keeps every claimer executing in one workspace — a racer whose
   *  candidate lost learns the winner and discards its own (see
   *  driver/ensure-sandbox.ts). Rejects an unknown, foreign, or archived
   *  session. */
  bindSandbox(ref: SessionRef, sandboxId: string, previous?: string): Promise<string>;
  /** One namespace's active sessions, newest first. includeArchived opts
   *  terminal rows back in — see ListSessionsRequest. */
  listSessions(req: ListSessionsRequest): Promise<Session[]>;

  // --- reads — table-shaped; reads need no atomicity ---

  /** `after` is a seq cursor: only entries with seq > after. */
  readEntries(ref: SessionRef, after?: number): Promise<SessionEntry[]>;
  /** Inspection and audit; workers get items through claimItem. */
  listItems(ref: SessionRef): Promise<WorkItem[]>;
  pendingInputs(ref: SessionRef): Promise<PendingInput[]>;

  // --- worker coordination ---

  /**
   * Atomically lease one ready item (CAS / SKIP LOCKED semantics);
   * undefined = no work. No type filter — workers dispatch on the
   * claimed item's type. session narrows the scan for the (deferred)
   * driver-per-sandbox topology.
   *
   * The returned token is the fencing credential, minted by the store
   * fresh for every claim (2026-08-12) — uniqueness is structural, not
   * caller discipline. A re-claim of the same item always issues a new
   * token, so a previous holder's zombie is fenced by construction.
   */
  claimItem(req: { leaseMs: number; session?: SessionRef }): Promise<Claim | undefined>;

  /**
   * Extend the lease by the duration chosen at claim; false = lease
   * lost, the driver must abort its step. The ref addresses the item;
   * the token authorizes the write. (A progress-checkpoint payload was
   * cut 2026-08-12 — it returns with its first reader, shaped by that
   * reader's needs.)
   */
  heartbeat(ref: WorkItemRef, token: LeaseToken): Promise<boolean>;

  /**
   * Appends a cancel ControlEntry to the log — nothing else. Workers
   * check behind the tail at boundaries; seq order scopes which run the
   * cancel addresses (one landing after a run's terminal message
   * addresses a run that no longer exists and is ignored). An archived
   * session rejects the write with ArchivedError.
   */
  requestCancel(ref: SessionRef): Promise<void>;

  // --- write paths — one transaction each ---

  /**
   * The api's write path. Branches inside its transaction: no open item
   * → the message becomes an entry and an inference item starts a run;
   * open item → the message parks as a pending input. Whether a parked
   * input steers or follows up is decided by which boundary drains it,
   * never by the message itself. An archived session rejects intake with
   * ArchivedError.
   */
  intake(ref: SessionRef, message: UserMessage): Promise<IntakeResult>;

  /**
   * The driver's write path: append the step's output, drain any
   * consumed inputs, and resolve the claimed item — cause and
   * consequence in one transaction. Fenced symmetrically with
   * heartbeat: the commit must carry the claim's token within a live
   * lease — a stale token OR an expired lease throws, even if no one
   * has reclaimed the item (strict expiry, 2026-08-12). Late work
   * is discarded, never merged: after expiry the item's fate belongs
   * to its next claimer. Re-committing a done item resolves
   * idempotently (crash-after-commit recovery).
   */
  commitStep(req: CommitStepRequest): Promise<void>;

  // P4 adds reaper operations (lease expiry, interrupted-result synthesis).
}

/**
 * Thrown by commitStep when the fence rejects the write — a stale token
 * or an expired lease. A typed class because the driver must tell this
 * apart from infrastructure failure: fenced means the item's fate belongs
 * to another claim, so the correct response is to drop the step's work
 * and claim again; anything else means the commit's outcome is unknown.
 */
export class FencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedError";
  }
}

export type ArchivedResourceKind = "agent" | "env" | "session";

/** What each kind is called in the message; the wording belongs to the
 *  kind, not to the factory that names it. */
const ARCHIVED_LABEL: Record<ArchivedResourceKind, string> = {
  agent: "agent config",
  env: "env config",
  session: "session",
};

/**
 * Thrown when a mutation or new reference targets any archived resource.
 * One type is deliberate: agent configs, env configs, and sessions share
 * the same terminal verdict and callers normally need one catch path. The
 * resourceKind/resourceId pair preserves specific identity when it matters.
 * Terminal, unlike VersionConflictError or SessionNotIdleError: no retry can
 * ever succeed.
 *
 * The thrower names the kind — the factories, never a shape test on the
 * ref. A Session row is structurally a SessionRef AND carries both config
 * ids, so inferring the kind would misread the whole-row-as-ref calls the
 * api makes (store.intake(session, …)); every throw site already knows
 * which resource it read.
 */
export class ArchivedError extends Error {
  readonly namespace: string;
  readonly resourceId: string;
  readonly resourceKind: ArchivedResourceKind;

  private constructor(kind: ArchivedResourceKind, namespace: string, resourceId: string) {
    super(`${ARCHIVED_LABEL[kind]} ${namespace}/${resourceId} is archived`);
    this.name = "ArchivedError";
    this.namespace = namespace;
    this.resourceId = resourceId;
    this.resourceKind = kind;
  }

  static forAgentConfig(ref: AgentConfigRef): ArchivedError {
    return new ArchivedError("agent", ref.namespace, ref.agentConfigId);
  }

  static forEnvConfig(ref: EnvConfigRef): ArchivedError {
    return new ArchivedError("env", ref.namespace, ref.envConfigId);
  }

  static forSession(ref: SessionRef): ArchivedError {
    return new ArchivedError("session", ref.namespace, ref.sessionId);
  }
}

/** Thrown when archive is requested while the session has an open item. */
export class SessionNotIdleError extends Error {
  readonly namespace: string;
  readonly sessionId: string;

  constructor(ref: SessionRef) {
    super(`session ${ref.namespace}/${ref.sessionId} is not idle`);
    this.name = "SessionNotIdleError";
    this.namespace = ref.namespace;
    this.sessionId = ref.sessionId;
  }
}

/** Thrown when an agent-config update's expected version is stale. */
export class VersionConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `agent config version ${actualVersion} does not match expected version ${expectedVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

/** Minted by the store per claim; opaque to callers, checked by equality. */
export type LeaseToken = string;

/** claimItem's result: the leased item plus its fencing credential. */
export interface Claim {
  item: WorkItem;
  token: LeaseToken;
}

export interface CommitStepRequest {
  // Named itemRef, not item: Claim.item is the full row, and reusing the
  // name for a ref would make the claim/commit pair lie about its shape.
  itemRef: WorkItemRef;
  /** The claim's credential — itemRef addresses, the token authorizes. */
  token: LeaseToken;
  /** Payloads — the store mints envelopes. Drained steering precedes step output. */
  append: AgentMessage[];
  /** Pending rows whose messages are in `append` — deleted in the same transaction. */
  consumeInputs?: InputId[];
  /**
   * The claimed item's consequence. A next item continues the run; end_run
   * ends it as the atomic NON-creation of one. Its status is the driver's
   * verdict — the engine's RunEndStatus plus "error", a surfaced provider
   * failure the driver chose not to retry. The status is NOT stored (the
   * tail shape re-derives it); it drives the commit's branch: with pending
   * inputs present, end_run auto-chains a new run in the same transaction,
   * except "cancelled", which parks them for the next intake.
   */
  next:
    | { kind: "inference" }
    | { kind: "execute_tools" }
    | { kind: "end_run"; status: RunEndStatus | "error" };
}
