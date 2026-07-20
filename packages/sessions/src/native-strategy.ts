// packages/sessions/src/native-strategy.ts — Funky's native turn loop.
//
// The simplest TurnStrategy: Funky owns every step. The reducer computes the single
// next Action from the log, the strategy performs it, appends the result, and repeats
// — reading the log ONCE (via the shell) and keeping it current in memory. buildContext
// is the ONLY source of provider messages: it rebuilds the conversation from our log
// every inference, so "every assistant tool_use is answered by a matching tool_result"
// holds across crashes and the v1 one-call cap. Raw provider responses are never cached.
//
// Because the model's context is a pure function of the log, crash-resume is FREE here:
// the reducer replays the log prefix and recomputes the same next action. There is no
// fence beyond the (session_id, seq) PK, no recovery pre-pass, and no continuation
// prompt — the harness strategy needs all three only to reconcile an external vendor
// transcript with the log; the native loop has no external state to reconcile.

import type { ChatMessage } from "@funky/llm";
import { LlmPermanentError, LlmTransientError } from "@funky/llm";
import {
  type EventPayload,
  type SessionEvent,
  plainText,
  textContent,
} from "./events";
import { nextAction } from "./reducer";
import type { TurnOutcome } from "./turn";
import { readMaxIterations } from "./turn";
import type { TurnShell, TurnStrategy } from "./strategy";

// ---------------------------------------------------------------------------
// buildContext — log → provider messages
// ---------------------------------------------------------------------------
/** Rebuild the provider message list from the log. The system prompt comes from the
 *  PINNED agent version on the session row, never the agent's current latest. Bookkeeping
 *  events (turn_completed / turn_failed / session_provisioned / harness_attempt_started)
 *  are skipped — they are not conversation. This is the sole producer of ChatMessage[];
 *  never replay a raw response. */
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
      // turn_completed / turn_failed / session_provisioned / harness_attempt_started
      // → skipped (bookkeeping).
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// nativeStrategy — perform the reducer's action, append, repeat
// ---------------------------------------------------------------------------
export const nativeStrategy: TurnStrategy = {
  async run(shell: TurnShell): Promise<TurnOutcome> {
    const { events, append, exec, version } = shell;
    const systemPrompt = version.systemPrompt;
    const model = version.model;
    const maxIterations = readMaxIterations(version.toolPolicy);

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
          const result = await shell.deps.llm.complete({
            model,
            messages: buildContext(events, systemPrompt),
            trace: { sessionId: shell.sessionId },
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
          const res = await exec(action.call, action.idemKey);
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
  },

  // Error policy — the LLM-specific classes; everything else defers to the shell.
  // A command that ran and failed never reaches here — that's a result, not a throw.
  mapError(err, shell) {
    if (err instanceof LlmPermanentError) return shell.terminalFail("LLM_PERMANENT", err.message);
    if (err instanceof LlmTransientError) {
      // Escaped the driver's retries. Append nothing; the queue's backoff replays the log.
      return shell.lastAttempt
        ? shell.terminalFail("INTERNAL", `llm transient: ${err.message}`)
        : "retry_later";
    }
    return null; // ErrConflict / SandboxUnavailable / generic → shell's shared mapping
  },
};
