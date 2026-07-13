// packages/sessions/src/reducer.ts — Phase D: the pure fold. NO I/O.
//
// The reducer answers exactly one question: given this log, what happens next? It
// imports nothing but ./events — no database, no ports, no clock, no randomness. It is
// a TOTAL function: every valid log prefix yields an action, so crash-resume is not a
// code path, it is THE code path. A worker that dies mid-turn leaves a log; a different
// worker replays it, computes the same next action from the same prefix, and continues.
// If you ever reach for `if (resuming) { ... }`, you have misunderstood the design.

import { type EventPayload, type SessionEvent, type ToolCall, idemKeyFor } from "./events";

export type Action =
  /** Call the model with the rebuilt context. */
  | { kind: "infer" }
  /** Run this tool call. idemKey is DERIVED from log position — never random. */
  | { kind: "exec_tool"; call: ToolCall; idemKey: string }
  /** The model answered with no tool call: append turn_completed, then ack. */
  | { kind: "finish" }
  /** Iteration budget exhausted: append turn_failed(BUDGET), then ack. */
  | { kind: "fail"; reason: "budget" }
  /** The log already ends in a terminal event — this job is stale. Ack, do nothing. */
  | { kind: "noop" };

export function nextAction(events: SessionEvent[], maxIterations: number): Action {
  if (events.length === 0) {
    throw new Error("reducer: empty log — a turn job must have a user_message");
  }

  // 1. Already terminal? The job is a redelivery of work that finished. Stand down.
  const last = events[events.length - 1]!;
  if (last.type === "turn_completed" || last.type === "turn_failed") {
    return { kind: "noop" };
  }

  const lastUser = findLastIndex(events, (e) => e.type === "user_message");
  const lastAssistant = findLastIndex(events, (e) => e.type === "assistant_message");

  // 2. No assistant reply since the user's message → the model must speak.
  //    (Also covers session_provisioned arriving after a queued user_message.)
  if (lastAssistant < lastUser) {
    return { kind: "infer" };
  }

  // 3. There is an assistant message in this turn. Did it ask for a tool?
  const assistant = events[lastAssistant] as SessionEvent<"assistant_message">;
  const calls = assistant.payload.tool_calls; // v1: length 0 or 1

  if (calls.length === 0) {
    return { kind: "finish" }; // the model answered; the turn is over
  }

  const call = calls[0]!;
  const idemKey = idemKeyFor(assistant.sessionId, assistant.seq, 0);

  // 4. Has that call already been answered? (Results always follow their call.)
  const answered = events
    .slice(lastAssistant + 1)
    .some(
      (e) =>
        e.type === "tool_result" &&
        (e.payload as EventPayload<"tool_result">).idem_key === idemKey,
    );

  if (!answered) {
    return { kind: "exec_tool", call, idemKey }; // ← resume lands here after a crash
  }

  // 5. Tool answered → budget check → back to the model.
  const iterations = events
    .slice(lastUser + 1)
    .filter((e) => e.type === "assistant_message").length;

  if (iterations >= maxIterations) return { kind: "fail", reason: "budget" };
  return { kind: "infer" };
}

function findLastIndex<T>(xs: T[], p: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (p(xs[i]!)) return i;
  return -1;
}
