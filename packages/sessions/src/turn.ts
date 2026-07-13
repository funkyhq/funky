// packages/sessions/src/turn.ts — Phase D: the turn loop.
//
// runTurn performs the single next Action the reducer computes, appends its result to the
// log, and repeats — reading the log ONCE and keeping it current in memory thereafter.
// buildContext is the ONLY source of provider messages: it rebuilds the conversation from
// our log every inference, so the invariant "every assistant tool_use is answered by a
// matching tool_result" holds even across crashes and the driver's v1 one-call cap. Raw
// provider response objects are never cached or replayed.

import { and, eq } from "drizzle-orm";
import type { Db } from "@funky/db";
import { agentConfigVersions, sessions } from "@funky/db/schema";
import type { ChatMessage, LlmPort } from "@funky/llm";
import { LlmPermanentError, LlmTransientError } from "@funky/llm";
import type { Executor, SandboxDriver, SandboxHandle } from "@funky/sandbox";
import { SandboxUnavailableError } from "@funky/sandbox";
import {
  type EventPayload,
  type EventType,
  type SessionEvent,
  type ToolCall,
  makeEvent,
  plainText,
  textContent,
} from "./events";
import type { Job } from "./queue";
import { nextAction } from "./reducer";
import { ErrConflict, EventStore } from "./store";

// ---------------------------------------------------------------------------
// buildContext — log → provider messages
// ---------------------------------------------------------------------------
/** Rebuild the provider message list from the log. The system prompt comes from the
 *  PINNED agent version on the session row, never the agent's current latest. Bookkeeping
 *  events (turn_completed / turn_failed / session_provisioned) are skipped — they are not
 *  conversation. This is the sole producer of ChatMessage[]; never replay a raw response. */
export function buildContext(events: SessionEvent[], systemPrompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const e of events) {
    switch (e.type) {
      case "user_message": {
        const p = e.payload as EventPayload<"user_message">;
        messages.push({ role: "user", content: plainText(p.content) });
        break;
      }
      case "assistant_message": {
        const p = e.payload as EventPayload<"assistant_message">;
        messages.push({
          role: "assistant",
          content: plainText(p.content),
          // v1 cap: at most one call; buildContext mirrors what the log recorded.
          ...(p.tool_calls[0] ? { toolCall: p.tool_calls[0] } : {}),
        });
        break;
      }
      case "tool_result": {
        const p = e.payload as EventPayload<"tool_result">;
        messages.push({ role: "tool", idemKey: p.idem_key, output: p.output, exitCode: p.exit_code });
        break;
      }
      // turn_completed / turn_failed / session_provisioned → skipped (bookkeeping).
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// runTurn — perform the action, append, repeat
// ---------------------------------------------------------------------------
export type TurnDeps = {
  store: EventStore;
  llm: LlmPort;
  sandbox: SandboxDriver;
  db: Db; // for reading session + agent version rows
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

  // 2. The PINNED agent version → system prompt, model, iteration budget.
  const version = await loadAgentVersion(deps.db, session.agentConfigId, session.agentVersion);
  if (!version) return "abandoned"; // pinned version vanished — nothing coherent to run
  const systemPrompt = version.systemPrompt;
  const model = version.model;
  const maxIterations = readMaxIterations(version.toolPolicy);

  // 3. The log IS the state. Read once; keep it current in memory (never re-read per loop).
  const events = await deps.store.readEvents(ns, sessionId);
  let handle = (session.sandboxHandle ?? null) as SandboxHandle | null;

  // Append at lastSeq+1 and mirror the row into `events` so the loop reflects reality
  // without another DB round-trip. A lost (session_id, seq) race surfaces as ErrConflict.
  const append = async <T extends EventType>(type: T, payload: EventPayload<T>): Promise<void> => {
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    const evt = makeEvent({ sessionId, namespace: ns, seq }, type, payload);
    await deps.store.appendEvent(ns, sessionId, seq, evt);
    events.push({ ...evt, createdAt: new Date() });
  };

  // Record a terminal failure. If even this append loses the seq race, another worker
  // owns the turn → conflict; a non-conflict failure means we could not record it → retry.
  const terminalFail = async (
    errorClass: "LLM_PERMANENT" | "SANDBOX_FATAL" | "INTERNAL",
    message: string,
  ): Promise<TurnOutcome> => {
    try {
      await append("turn_failed", { error_class: errorClass, message });
    } catch (e) {
      if (e instanceof ErrConflict) return "conflict";
      return "retry_later";
    }
    return "failed";
  };

  // Run one exec. Non-zero exit / timeout(124) / OOM(137) are RESULTS (they carry an exit
  // code) and are returned, never thrown. Only an unobservable command throws.
  const runExec = async (executor: Executor, call: ToolCall, idemKey: string) => {
    const req = {
      cmd: call.cmd,
      idemKey,
      ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
    };
    let output = "";
    let exitCode = 0;
    let truncated = false;
    let sawExit = false;
    for await (const ev of executor.exec(req)) {
      if (ev.kind === "exit") {
        exitCode = ev.code;
        truncated = ev.truncated;
        sawExit = true;
      } else {
        output += ev.data; // stdout / stderr both fold into combined output
      }
    }
    // A stream that ends without an exit event is unobservable, not a zero exit.
    if (!sawExit) throw new SandboxUnavailableError("exec stream ended without an exit event");
    return { output, exitCode, truncated };
  };

  // Exec with a single reboot on an unobservable sandbox. The same idemKey re-attaches to
  // a still-running command or re-runs it safely, so nothing runs twice. A second failure
  // propagates to the error policy below.
  const execWithReboot = async (call: ToolCall, idemKey: string) => {
    if (!handle) throw new SandboxUnavailableError("session has no sandbox handle");
    try {
      return await runExec(deps.sandbox.connect(handle), call, idemKey);
    } catch (err) {
      if (!(err instanceof SandboxUnavailableError)) throw err;
      handle = await deps.sandbox.reboot(handle); // persistent FS survives the reboot
      await persistHandle(deps.db, ns, sessionId, handle);
      return await runExec(deps.sandbox.connect(handle), call, idemKey);
    }
  };

  try {
    for (;;) {
      const action = nextAction(events, maxIterations);
      switch (action.kind) {
        case "noop":
          return "completed"; // redelivery of finished work — silent ack
        case "finish":
          await append("turn_completed", {});
          return "completed";
        case "fail":
          await append("turn_failed", {
            error_class: "BUDGET",
            message: `iteration budget exhausted (max_iterations=${maxIterations})`,
          });
          return "failed";
        case "infer": {
          const result = await deps.llm.complete({
            model,
            messages: buildContext(events, systemPrompt),
            trace: { sessionId },
          });
          await append("assistant_message", {
            content: textContent(result.content),
            tool_calls: result.toolCall ? [result.toolCall] : [],
            usage: {
              input_tokens: result.usage.inputTokens,
              output_tokens: result.usage.outputTokens,
            },
          });
          break;
        }
        case "exec_tool": {
          const res = await execWithReboot(action.call, action.idemKey);
          await append("tool_result", {
            idem_key: action.idemKey,
            output: res.output,
            exit_code: res.exitCode, // a non-zero exit is a result the model reacts to
            truncated: res.truncated,
          });
          break;
        }
      }
    }
  } catch (err) {
    // Error policy. A command that ran and failed never reaches here — that's a result.
    if (err instanceof ErrConflict) return "conflict"; // someone else owns this turn
    if (err instanceof LlmPermanentError) return terminalFail("LLM_PERMANENT", err.message);
    if (err instanceof LlmTransientError) {
      // Escaped the driver's retries. Append nothing; the queue's backoff replays the log.
      return lastAttempt ? terminalFail("INTERNAL", `llm transient: ${err.message}`) : "retry_later";
    }
    if (err instanceof SandboxUnavailableError) {
      return lastAttempt ? terminalFail("SANDBOX_FATAL", err.message) : "retry_later";
    }
    const message = err instanceof Error ? err.message : String(err);
    return lastAttempt ? terminalFail("INTERNAL", message) : "retry_later";
  }
}

// ---------------------------------------------------------------------------
// Row access — every query scoped by namespace.
// ---------------------------------------------------------------------------
type SessionRow = typeof sessions.$inferSelect;
type VersionRow = typeof agentConfigVersions.$inferSelect;

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

async function persistHandle(
  db: Db,
  ns: string,
  sessionId: string,
  handle: SandboxHandle,
): Promise<void> {
  await db
    .update(sessions)
    .set({ sandboxHandle: handle, updatedAt: new Date() })
    .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
}

/** The spigot that stops a buggy agent looping forever against a paid LLM API.
 *  `tool_policy.max_iterations`, default 20. */
function readMaxIterations(toolPolicy: Record<string, unknown>): number {
  const v = toolPolicy["max_iterations"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 20;
}
