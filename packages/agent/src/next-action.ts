import type { AgentMessage, ToolCall } from "@funky/core";

export type RunEndStatus = "completed" | "max_tokens" | "cancelled";

export type Action =
  | { kind: "inference" }
  | { kind: "execute_tools"; calls: ToolCall[] }
  | { kind: "end_run"; status: RunEndStatus }
  /** Provider failure. Carries nothing: the message is on the AssistantMessage,
   *  and retry-vs-commit is the driver's call — policy is memoryless. */
  | { kind: "error" };

/**
 * The policy: given the last message a step committed, decide what the run
 * does next. The role already names the step that produced it — inference
 * commits an assistant message, execute_tools commits tool results, intake
 * commits the user message that starts a run — so the policy dispatches on
 * the message union itself; there is no separate "step result" vocabulary.
 *
 * Pure and memoryless. The caller invokes it at commit time and persists the
 * consequence — the next item, or the run's end as the atomic NON-creation
 * of one — in the same transaction as the step's output, so a crash can
 * never separate a message from the decision it caused. Decision order:
 *
 *   1. cancelRequested — true when a cancel control entry addresses the
 *      current run; the driver computes it from the log at each boundary —
 *      ends the run "cancelled", whatever the step produced.
 *   2. User messages and tool results feed into inference — error results
 *      too; recovery is the model's job.
 *   3. An assistant message dispatches on failure first (error → driver
 *      decides retry vs commit; aborted → cancelled; max_tokens → truncated),
 *      then on the presence of tool calls rather than stopReason: a committed
 *      toolCall with no result is a malformed context for every later request.
 *
 * There is deliberately no turn cap. The runaway breaker will be a token
 * budget accumulated from persisted usage — guarding the inference branch
 * here — once the ledger lands; turn counts are a poor proxy for spend.
 *
 * Not here by design: pending-input drain. Steering shapes the next context
 * (buildContext) and follow-ups chain new runs (intake); neither changes
 * which item comes next.
 */
export function nextAction(message: AgentMessage, cancelRequested: boolean): Action {
  if (cancelRequested) return { kind: "end_run", status: "cancelled" };

  switch (message.role) {
    case "user":
    case "toolResult":
      return { kind: "inference" };
    case "assistant":
      switch (message.stopReason) {
        case "error":
          return { kind: "error" };
        case "aborted":
          return { kind: "end_run", status: "cancelled" };
        case "max_tokens":
          // Truncated output — any tool calls in it are suspect, never executed.
          return { kind: "end_run", status: "max_tokens" };
        case "end_turn":
        case "tool_use": {
          const calls = message.content.filter((part) => part.type === "toolCall");
          if (calls.length > 0) return { kind: "execute_tools", calls };
          return { kind: "end_run", status: "completed" };
        }
      }
  }
}
