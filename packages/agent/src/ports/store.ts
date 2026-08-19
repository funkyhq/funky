import type {
  AgentConfig,
  AgentMessage,
  ConfigId,
  CreateAgentConfigRequest,
  CreateEnvConfigRequest,
  CreateSessionRequest,
  EnvConfig,
  InputId,
  IntakeResult,
  ItemId,
  PendingInput,
  Session,
  SessionEntry,
  SessionId,
  UserMessage,
  WorkItem,
} from "@funky/core";
import type { RunEndStatus } from "../engine/next-action";

/**
 * The Store port — the harness's single source of truth. Deliberately one
 * interface, not three: commitStep must span entries, work items, and
 * pending inputs in one transaction, and splitting the interface would
 * lie about that atomicity.
 *
 * Two write paths, two callers: the api calls intake, the driver calls
 * commitStep. They are the only status mutations in the system, and work
 * items are born only inside their transactions — which is why there is
 * no createWorkItem.
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
 */
export interface Store {
  // --- configs — write-once, so every get is infinitely cacheable ---

  createAgentConfig(req: CreateAgentConfigRequest): Promise<ConfigId>;
  getAgentConfig(id: ConfigId): Promise<AgentConfig | undefined>;
  createEnvConfig(req: CreateEnvConfigRequest): Promise<ConfigId>;
  getEnvConfig(id: ConfigId): Promise<EnvConfig | undefined>;

  // --- sessions ---

  /** Rejects unknown config ids — a session never dangles. */
  createSession(req: CreateSessionRequest): Promise<SessionId>;
  getSession(id: SessionId): Promise<Session | undefined>;
  /** Register the session's one sandbox: a compare-and-set on the
   *  binding — fills a null binding when `previous` is omitted, or
   *  replaces exactly `previous` when the caller is recovering a dead
   *  sandbox. Returns the bound id either way: the atomic pick that
   *  keeps every claimer executing in one workspace — a racer whose
   *  candidate lost learns the winner and discards its own (see
   *  driver/ensure-sandbox.ts). Rejects an unknown session. */
  bindSandbox(sessionId: SessionId, sandboxId: string, previous?: string): Promise<string>;

  // --- reads — table-shaped; reads need no atomicity ---

  /** `after` is a seq cursor: only entries with seq > after. */
  readEntries(sessionId: SessionId, after?: number): Promise<SessionEntry[]>;
  /** Inspection and audit; workers get items through claimItem. */
  listItems(sessionId: SessionId): Promise<WorkItem[]>;
  pendingInputs(sessionId: SessionId): Promise<PendingInput[]>;

  // --- worker coordination ---

  /**
   * Atomically lease one ready item (CAS / SKIP LOCKED semantics);
   * undefined = no work. No type filter — workers dispatch on the
   * claimed item's type. sessionId narrows the scan for the (deferred)
   * driver-per-sandbox topology.
   *
   * The returned token is the fencing credential, minted by the store
   * fresh for every claim (2026-08-12) — uniqueness is structural, not
   * caller discipline. A re-claim of the same item always issues a new
   * token, so a previous holder's zombie is fenced by construction.
   */
  claimItem(req: { leaseMs: number; sessionId?: SessionId }): Promise<Claim | undefined>;

  /**
   * Extend the lease by the duration chosen at claim; false = lease
   * lost, the driver must abort its step. itemId addresses the item;
   * the token authorizes the write. (A progress-checkpoint payload was
   * cut 2026-08-12 — it returns with its first reader, shaped by that
   * reader's needs.)
   */
  heartbeat(itemId: ItemId, token: LeaseToken): Promise<boolean>;

  /**
   * Appends a cancel ControlEntry to the log — nothing else. Workers
   * check behind the tail at boundaries; seq order scopes which run the
   * cancel addresses (one landing after a run's terminal message
   * addresses a run that no longer exists and is ignored).
   */
  requestCancel(sessionId: SessionId): Promise<void>;

  // --- write paths — one transaction each ---

  /**
   * The api's write path. Branches inside its transaction: no open item
   * → the message becomes an entry and an inference item starts a run;
   * open item → the message parks as a pending input. Whether a parked
   * input steers or follows up is decided by which boundary drains it,
   * never by the message itself.
   */
  intake(sessionId: SessionId, message: UserMessage): Promise<IntakeResult>;

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

/** Minted by the store per claim; opaque to callers, checked by equality. */
export type LeaseToken = string;

/** claimItem's result: the leased item plus its fencing credential. */
export interface Claim {
  item: WorkItem;
  token: LeaseToken;
}

export interface CommitStepRequest {
  itemId: ItemId;
  /** The claim's credential — itemId addresses, the token authorizes. */
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
