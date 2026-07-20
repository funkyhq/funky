// packages/sessions/src/turn.ts — the turn SHELL.
//
// runTurn is deliberately thin: it gates on session status, loads the PINNED agent
// version, reads the log ONCE, builds the plumbing every runtime shares (the
// conditional-append helper, terminalFail, exec-with-reboot), and hands a TurnShell to
// the TurnStrategy selected by the pinned runtime. The strategies own everything that
// genuinely differs:
//
//   - nativeStrategy (native-strategy.ts): Funky's own infer/exec loop. The model's
//     context is a pure function of the log, so crash-resume is free (reducer replay).
//   - harnessStrategy (harness-strategy.ts): a vendor agent SDK (e.g. Claude Code) owns
//     the loop; the strategy adds a write fence, a crash-recovery pre-pass, and a commit
//     to reconcile the opaque external transcript with the log.
//
// The pinned runtime never changes mid-session, so a session's strategy is stable for
// its whole life. See ports/harness/DESIGN.md.

import { and, eq } from "drizzle-orm";
import type { Db } from "@funky/db";
import { type RuntimeConfig, agentConfigVersions, sessions } from "@funky/db/schema";
import type { HarnessPort } from "@funky/harness/port";
import type { LlmPort } from "@funky/llm";
import type { SandboxDriver, SandboxHandle } from "@funky/sandbox";
import { SandboxUnavailableError } from "@funky/sandbox";
import { type EventPayload, type EventType, makeEvent } from "./events";
import { makeExecWithReboot } from "./exec";
import { harnessStrategy } from "./harness-strategy";
import { nativeStrategy } from "./native-strategy";
import type { Job } from "./queue";
import { ErrConflict, EventStore } from "./store";
import type { ErrorClass, TurnShell, TurnStrategy } from "./strategy";

// buildContext is native's context builder; re-exported here so `./turn`'s public
// surface (and its importers/tests) stay stable after the strategy split.
export { buildContext } from "./native-strategy";

// ---------------------------------------------------------------------------
// runTurn — gate, load, build the shell, dispatch to the strategy
// ---------------------------------------------------------------------------
export type TurnDeps = {
  store: EventStore;
  llm: LlmPort;
  sandbox: SandboxDriver;
  db: Db; // for reading session + agent version rows
  /** Optional: agent versions with runtime {type:"claude-code"} dispatch to this
   *  port (harness-strategy.ts). A harness session on a worker without a driver fails
   *  the turn with a terminal HARNESS error. */
  harness?: HarnessPort;
};

export type TurnOutcome =
  | "completed" // the agent finished → worker ACKs
  | "failed" // turn_failed appended → worker ACKs (a recorded failure IS a success from
  //           the queue's perspective; the user sees the failure event)
  | "conflict" // another worker owns this turn → worker ACKs silently
  | "abandoned" // session archived/failed → worker ACKs
  | "retry_later"; // sandbox still provisioning, or a transient failure → worker NACKs

export async function runTurn(job: Job, deps: TurnDeps): Promise<TurnOutcome> {
  const ns = job.namespace;
  const sessionId = job.sessionId;
  // The queue already incremented attempts on claim; this is the last delivery once it
  // reaches maxAttempts. On the last attempt a would-be retry_later must instead be
  // recorded as a terminal turn_failed, so a broken sandbox never hangs the session.
  const lastAttempt = job.attempts >= job.maxAttempts;

  // 1. Session gate.
  const session = await loadSession(deps.db, ns, sessionId);
  if (!session) return "abandoned"; // no such session in this namespace — nothing to drive
  if (session.status === "provisioning") return "retry_later"; // backoff waits; do NOT block
  if (session.status === "failed" || session.status === "archived") return "abandoned";

  // 2. The PINNED agent version → system prompt, model, iteration budget, runtime.
  const version = await loadAgentVersion(deps.db, session.agentConfigId, session.agentVersion);
  if (!version) return "abandoned"; // pinned version vanished — nothing coherent to run

  // 3. The log IS the state. Read once; the shell's append keeps it current in memory.
  const events = await deps.store.readEvents(ns, sessionId);

  // 4. Shared plumbing: conditional append, terminal-failure recorder, exec+reboot.
  const append = async <T extends EventType>(
    type: T,
    payload: EventPayload<T>,
  ): Promise<number> => {
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    const evt = makeEvent({ sessionId, namespace: ns, seq }, type, payload);
    await deps.store.appendEvent(ns, sessionId, seq, evt);
    events.push({ ...evt, createdAt: new Date() });
    return seq;
  };

  const terminalFail = async (errorClass: ErrorClass, message: string): Promise<TurnOutcome> => {
    try {
      await append("turn_failed", { error_class: errorClass, message });
    } catch (e) {
      if (e instanceof ErrConflict) return "conflict";
      return "retry_later";
    }
    return "failed";
  };

  const exec = makeExecWithReboot({
    db: deps.db,
    sandbox: deps.sandbox,
    ns,
    sessionId,
    handle: (session.sandboxHandle ?? null) as SandboxHandle | null,
  });

  const shell: TurnShell = {
    job,
    ns,
    sessionId,
    lastAttempt,
    session,
    version,
    deps,
    events,
    append,
    terminalFail,
    exec,
  };

  // 5. Select the strategy by pinned runtime, run it, and map any escaping error onto
  //    a TurnOutcome (strategy-specific classes first, shared classes as fallback).
  const strategy = selectStrategy(version.runtime);
  try {
    return await strategy.run(shell);
  } catch (err) {
    const mapped = await strategy.mapError?.(err, shell);
    return mapped ?? (await mapError(err, shell));
  }
}

/** Pinned runtime → strategy. null / {type:"native"} → the native loop; {type:"claude-code"}
 *  → the harness loop. Replaces the former inline dispatch branch. */
function selectStrategy(runtime: RuntimeConfig | null): TurnStrategy {
  switch (runtime?.type) {
    case "claude-code":
      return harnessStrategy;
    case "native":
    case undefined: // null runtime column → native (the historical default)
      return nativeStrategy;
    default: {
      const never: never = runtime;
      throw new Error(`unknown runtime: ${JSON.stringify(never)}`);
    }
  }
}

/** The shared error map: the classes every strategy resolves the same way. Strategy-
 *  specific classes (Llm*, Harness*) are handled by the strategy's own mapError first;
 *  anything it defers on lands here. */
function mapError(err: unknown, shell: TurnShell): TurnOutcome | Promise<TurnOutcome> {
  if (err instanceof ErrConflict) return "conflict"; // someone else owns this turn
  if (err instanceof SandboxUnavailableError) {
    return shell.lastAttempt ? shell.terminalFail("SANDBOX_FATAL", err.message) : "retry_later";
  }
  const message = err instanceof Error ? err.message : String(err);
  return shell.lastAttempt ? shell.terminalFail("INTERNAL", message) : "retry_later";
}

// ---------------------------------------------------------------------------
// Row access — every query scoped by namespace.
// ---------------------------------------------------------------------------
export type SessionRow = typeof sessions.$inferSelect;
export type VersionRow = typeof agentConfigVersions.$inferSelect;

async function loadSession(db: Db, ns: string, sessionId: string): Promise<SessionRow | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)))
    .limit(1);
  return row;
}

async function loadAgentVersion(
  db: Db,
  agentConfigId: string,
  version: number,
): Promise<VersionRow | undefined> {
  const [row] = await db
    .select()
    .from(agentConfigVersions)
    .where(
      and(
        eq(agentConfigVersions.agentConfigId, agentConfigId),
        eq(agentConfigVersions.version, version),
      ),
    )
    .limit(1);
  return row;
}

/** The spigot that stops a buggy agent looping forever against a paid LLM API.
 *  `tool_policy.max_iterations`, default 20. (Harness sessions map it onto the
 *  vendor loop's maxTurns.) */
export function readMaxIterations(toolPolicy: Record<string, unknown>): number {
  const v = toolPolicy["max_iterations"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 20;
}
