// packages/sessions/src/strategy.ts — the shared turn seam.
//
// runTurn (turn.ts) is a SHELL: it gates on session status, loads the pinned agent
// version, reads the log once, builds the shared plumbing (append / terminalFail /
// exec), and then hands a TurnShell to a TurnStrategy selected by the pinned runtime.
//
// A strategy owns the turn's INNER loop and everything that genuinely differs between
// runtimes — the native loop's reducer-driven steps, or the harness loop's fence +
// crash-recovery + vendor delegation + commit. The shell owns everything they share.
// See ports/harness/DESIGN.md and turn.ts.

import type { EventPayload, EventType, SessionEvent, ToolCall } from "./events";
import type { ExecResult } from "./exec";
import type { Job } from "./queue";
import type { SessionRow, TurnDeps, TurnOutcome, VersionRow } from "./turn";

/** The classes turn_failed records (events.ts). Transient classes never reach the log
 *  — they retry — so they are not part of this union. */
export type ErrorClass = "LLM_PERMANENT" | "SANDBOX_FATAL" | "BUDGET" | "HARNESS" | "INTERNAL";

/** Everything a strategy needs from the shell. Built once per turn, after the session
 *  gate and the single log read. */
export type TurnShell = {
  job: Job;
  ns: string;
  sessionId: string;
  /** The queue already incremented attempts on claim; true on the final delivery. A
   *  would-be retry_later on the last attempt must instead record a terminal failure. */
  lastAttempt: boolean;
  session: SessionRow;
  /** The PINNED agent version — system prompt, model, tool policy. Never the latest. */
  version: VersionRow;
  deps: TurnDeps;
  /** The log, read ONCE. `append` keeps it current in memory; a strategy that does its
   *  own transactional appends (the harness fence/commit) MUST push to this array too,
   *  so later reads reflect reality without another round-trip — exactly as today. */
  events: SessionEvent[];
  /** Conditional append at lastSeq+1; mirrors the row into `events`; resolves with the
   *  seq it landed at (the harness derives exec idemKeys from it; native ignores it).
   *  Throws ErrConflict on a lost (session_id, seq) race — another worker owns the turn. */
  append: <T extends EventType>(type: T, payload: EventPayload<T>) => Promise<number>;
  /** Record a terminal turn_failed. Returns "conflict" if even that append loses the
   *  race (another worker owns the turn); "retry_later" if it could not be recorded. */
  terminalFail: (errorClass: ErrorClass, message: string) => Promise<TurnOutcome>;
  /** Run one tool call under an idemKey with the single-reboot policy (exec.ts), bound
   *  to this session's sandbox handle. The same idemKey re-attaches, never re-runs. */
  exec: (call: ToolCall, idemKey: string) => Promise<ExecResult>;
};

export interface TurnStrategy {
  /** Run the turn's inner loop. Return a TurnOutcome, or throw for mapError / the
   *  shell's shared error map. */
  run(shell: TurnShell): Promise<TurnOutcome>;
  /** Classify a strategy-specific error into an outcome. Return null to DEFER to the
   *  shell's shared mapping (ErrConflict → conflict, SandboxUnavailable → SANDBOX_FATAL
   *  / retry, else INTERNAL / retry). Runs inside the shell's catch, so terminalFail
   *  and lastAttempt are reached through `shell`. */
  mapError?(err: unknown, shell: TurnShell): TurnOutcome | Promise<TurnOutcome> | null;
}
