// packages/sessions/src/harness-strategy.ts — the harness TurnStrategy.
//
// A harness session's agentic loop runs inside a vendor binary (ports/harness), so the
// reducer cannot compute mid-turn actions — but every stateful decision still lives
// HERE, against the same log the shell handed us, with the same conditional-append
// semantics:
//
//   1. FENCE: appending harness_attempt_started at lastSeq+1 (+ mirroring the token
//      onto sessions.harness_attempt, one tx) IS acquiring the turn. Losing the seq
//      race = another worker owns it. The token fences the driver's transcript mirror
//      (see ports/harness DESIGN.md §5).
//   2. RECOVERY: before the model speaks, every logged-but-unanswered exec call is
//      resolved by the SAME idemKey — attach to a surviving execution or replay the
//      logged decision. Exactly-once is settled from durable records, never left to the
//      (stochastic) model. The recovered results ride the continuation prompt.
//   3. COMMIT: turn_completed (or turn_failed) + the vendor session id land in one
//      transaction. A crash before commit leaves a resumable transcript tip.
//
// These three (fence / recovery pre-pass / continuation prompt) exist ONLY to reconcile
// the opaque external transcript with the log; the native strategy needs none of them.
// If you ever reach for `if (resuming) { ... }` around EXECUTION, you have misunderstood
// the design — resumption only shapes the PROMPT.

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { harnessTranscriptEntries, sessions } from "@funky/db/schema";
import {
  HarnessFencedError,
  HarnessPermanentError,
  type HarnessProjectedEvent,
  type HarnessTurnResult,
} from "@funky/harness/port";
import {
  type EventPayload,
  type SessionEvent,
  type ToolCall,
  idemKeyFor,
  makeEvent,
  plainText,
} from "./events";
import type { ExecResult } from "./exec";
import { ErrConflict } from "./store";
import type { TurnShell, TurnStrategy } from "./strategy";
import { type TurnDeps, readMaxIterations } from "./turn";

export const harnessStrategy: TurnStrategy = {
  async run(shell: TurnShell) {
    const { ns, sessionId, session, version, events, append, terminalFail, exec, deps } = shell;

    const last = events.at(-1);
    if (!last || last.type === "turn_completed" || last.type === "turn_failed") {
      return "completed"; // stale redelivery (or no work yet) — silent ack
    }
    const lastUser = findLastIndex(events, (e) => e.type === "user_message");
    if (lastUser < 0) return "completed"; // nothing to answer

    if (!deps.harness) {
      return terminalFail(
        "HARNESS",
        "agent runtime is claude-code but this worker has no harness driver (is ANTHROPIC_API_KEY set?)",
      );
    }

    // Was this turn already attempted? Decided BEFORE we append our own attempt event.
    const priorAttempts = events
      .slice(lastUser + 1)
      .filter((e) => e.type === "harness_attempt_started").length;

    // 1. Acquire the fence: attempt event + token on the session row, ONE transaction.
    // Winning the (session_id, seq) race is winning the turn; the token makes the
    // transcript store reject any still-running previous attempt's mirror batches. Any
    // failure to acquire is a retry (never terminal): a conflict means another worker
    // owns it, anything else is a blip we back off from.
    const attempt = randomUUID();
    const resumeTip = await latestTranscriptTip(deps, ns, sessionId);
    try {
      await deps.db.transaction(async (tx) => {
        const seq = (events.at(-1)?.seq ?? 0) + 1;
        const evt = makeEvent({ sessionId, namespace: ns, seq }, "harness_attempt_started", {
          attempt,
          resumed_from: resumeTip,
        });
        await deps.store.appendEvent(ns, sessionId, seq, evt, tx);
        await tx
          .update(sessions)
          .set({ harnessAttempt: attempt, updatedAt: new Date() })
          .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
        events.push({ ...evt, createdAt: new Date() });
      });
    } catch (err) {
      if (err instanceof ErrConflict) return "conflict";
      return "retry_later";
    }

    // From here on, escaping errors flow to the shell's error map (harness classes via
    // this strategy's mapError, shared classes as fallback) — no inner catch needed.

    // 2. RECOVERY: resolve every logged exec decision that has no recorded result. The
    // idemKey is the log position, so this attaches to a command the crashed attempt
    // started (it kept running in the surviving sandbox) or replays one that was
    // journaled but never spawned. Either way: executed exactly once.
    const recovered: Array<{ call: ToolCall; result: ExecResult }> = [];
    for (const { call, seq } of unansweredCalls(events, lastUser, sessionId)) {
      const idemKey = idemKeyFor(sessionId, seq, 0);
      const result = await exec(call, idemKey);
      await append("tool_result", {
        idem_key: idemKey,
        output: result.output,
        exit_code: result.exitCode,
        truncated: result.truncated,
      });
      recovered.push({ call, result });
    }

    // 3. The prompt: the user's message, or a continuation carrying the recovery.
    const userText = plainText((events[lastUser] as SessionEvent<"user_message">).payload.content);
    const prompt = priorAttempts === 0 ? userText : continuationPrompt(userText, recovered);

    // 4. The driver's appends ride the shell's conditional-append helper, serialized.
    let chain: Promise<unknown> = Promise.resolve();
    const appender = (e: HarnessProjectedEvent): Promise<{ seq: number }> => {
      const next = chain.then(async () => {
        if (e.kind === "assistant_message") {
          const seq = await append("assistant_message", {
            content: e.content,
            tool_calls: e.toolCalls,
            ...(e.usage
              ? {
                  usage: {
                    input_tokens: e.usage.inputTokens,
                    output_tokens: e.usage.outputTokens,
                  },
                }
              : {}),
          });
          return { seq };
        }
        const seq = await append("tool_result", {
          idem_key: e.idemKey,
          output: e.output,
          exit_code: e.exitCode,
          truncated: e.truncated,
        });
        return { seq };
      });
      chain = next.catch(() => {});
      return next;
    };

    const result: HarnessTurnResult = await deps.harness.runTurn({
      namespace: ns,
      sessionId,
      attempt,
      systemPrompt: version.systemPrompt,
      model: version.model,
      prompt,
      resume: resumeTip,
      limits: { maxTurns: readMaxIterations(version.toolPolicy) },
      exec,
      append: appender,
    });

    // 5. COMMIT: terminal event + the vendor session id, one transaction. Both stop
    // types commit the transcript tip — a budget stop still advanced the transcript.
    await deps.db.transaction(async (tx) => {
      const seq = (events.at(-1)?.seq ?? 0) + 1;
      const evt =
        result.stop.type === "success"
          ? makeEvent({ sessionId, namespace: ns, seq }, "turn_completed", {})
          : makeEvent({ sessionId, namespace: ns, seq }, "turn_failed", {
              error_class: "BUDGET",
              message: result.stop.message,
            });
      await deps.store.appendEvent(ns, sessionId, seq, evt, tx);
      await tx
        .update(sessions)
        .set({
          harnessState: { driver: "claude-code", sdk_session_id: result.sdkSessionId },
          updatedAt: new Date(),
        })
        .where(and(eq(sessions.namespace, ns), eq(sessions.id, sessionId)));
      events.push({ ...evt, createdAt: new Date() });
    });
    return result.stop.type === "success" ? "completed" : "failed";
  },

  // Error policy — the harness-specific classes; everything else defers to the shell.
  mapError(err, shell) {
    if (err instanceof HarnessFencedError) return "conflict"; // fenced = another worker owns it
    if (err instanceof HarnessPermanentError) return shell.terminalFail("HARNESS", err.message);
    return null; // ErrConflict / SandboxUnavailable / generic → shell's shared mapping
  },
};

// ---------------------------------------------------------------------------
// Log scans
// ---------------------------------------------------------------------------

/** Exec decisions journaled this turn with no recorded result — the harness flavor of
 *  the reducer's "has that call been answered?" step. */
function unansweredCalls(
  events: SessionEvent[],
  lastUser: number,
  sessionId: string,
): Array<{ call: ToolCall; seq: number }> {
  const out: Array<{ call: ToolCall; seq: number }> = [];
  const turn = events.slice(lastUser + 1);
  for (const e of turn) {
    if (e.type !== "assistant_message") continue;
    const p = e.payload as EventPayload<"assistant_message">;
    const call = p.tool_calls[0];
    if (!call) continue;
    const idemKey = idemKeyFor(sessionId, e.seq, 0);
    const answered = turn.some(
      (r) =>
        r.type === "tool_result" &&
        (r.payload as EventPayload<"tool_result">).idem_key === idemKey,
    );
    if (!answered) out.push({ call, seq: e.seq });
  }
  return out;
}

/** The vendor session id to resume from: the newest main-transcript row for this
 *  session. Authoritative because fenced writes never land (every row belongs to a
 *  legitimate attempt); the session row's harness_state is only a cache/audit field. */
async function latestTranscriptTip(
  deps: TurnDeps,
  ns: string,
  sessionId: string,
): Promise<string | null> {
  const [row] = await deps.db
    .select({ sdkSessionId: harnessTranscriptEntries.sdkSessionId })
    .from(harnessTranscriptEntries)
    .where(
      and(
        eq(harnessTranscriptEntries.namespace, ns),
        eq(harnessTranscriptEntries.funkySessionId, sessionId),
        eq(harnessTranscriptEntries.subpath, ""),
      ),
    )
    .orderBy(desc(harnessTranscriptEntries.ord))
    .limit(1);
  return row?.sdkSessionId ?? null;
}

/** The recovery preamble: what the interrupted attempt's commands actually did, so the
 *  resumed model continues instead of re-running side effects it can't see. */
function continuationPrompt(
  userText: string,
  recovered: Array<{ call: ToolCall; result: ExecResult }>,
): string {
  const lines = [
    "<system-reminder>",
    "This turn was interrupted by an infrastructure failure and is being resumed.",
    "The user's request for this turn was:",
    userText,
    "",
  ];
  if (recovered.length > 0) {
    lines.push(
      "Commands you had already started completed with these results (do NOT re-run them):",
    );
    for (const { call, result } of recovered) {
      lines.push(
        `$ ${call.cmd}`,
        `[exit code: ${result.exitCode}]`,
        result.output.length > 4000 ? `${result.output.slice(0, 4000)}\n[truncated]` : result.output,
        "",
      );
    }
  }
  lines.push(
    "Continue the task from where it left off; only run new commands that are still needed.",
    "</system-reminder>",
  );
  return lines.join("\n");
}

function findLastIndex<T>(xs: T[], p: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (p(xs[i]!)) return i;
  return -1;
}
