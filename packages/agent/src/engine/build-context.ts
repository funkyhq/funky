import type { AgentMessage, SessionEntry, ToolCall, UserMessage } from "@funky/core";
import { interruptedResult } from "./execute-tools";

/**
 * Fold the session log into the model context. Pure: the driver reads the
 * entries and drains pending inputs; this function only decides what the
 * transcript looks like.
 *
 * The log and the context deliberately diverge — the log keeps everything,
 * the context keeps what the model may see:
 * - custom entries (app payload) and control entries (harness signals)
 *   are skipped; compaction is reserved and a no-op until its semantics
 *   land (then: drop seq <= upToSeq, inject the summary as user-role text)
 *   TODO(compaction): upToSeq must land on a call/result group boundary —
 *   a cut between an assistant message and its results would orphan the
 *   results and this fold would silently drop them from context. This is
 *   a constraint on the future compactor; nothing enforces it yet.
 *   TODO(compaction): with multiple compaction entries (recompaction),
 *   the highest upToSeq governs; earlier ones are themselves superseded.
 * - assistant messages with stopReason aborted/error stay in the log but
 *   are dropped here
 * - tool calls and results must pair up, repaired in both directions: a
 *   kept assistant message whose calls have no committed results gets
 *   synthesized interrupted results (the cancel-before-execute path), and
 *   a result whose parent assistant message was dropped is dropped with it
 *   — dangling calls and orphaned results are equally malformed
 *
 * steeringMessages append at the tail: they are steering by construction
 * (the driver drains only at inference prep; follow-ups become ordinary
 * user entries when the terminal commit chains a new run).
 *
 * Provider API shape (role alternation, results as user-role blocks) is
 * the adapter's translation, not context semantics.
 */
export function buildContext(
  entries: SessionEntry[],
  steeringMessages: UserMessage[] = [],
): AgentMessage[] {
  const context: AgentMessage[] = [];
  // Calls from the most recent kept assistant message still awaiting results.
  let openCalls = new Map<string, ToolCall>();

  const closeOpenCalls = () => {
    for (const call of openCalls.values()) context.push(interruptedResult(call));
    openCalls = new Map();
  };

  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    // Results are only valid immediately after their assistant message, so
    // any other message arriving is proof the still-open calls will never
    // be answered — and the last valid position to synthesize their results.
    if (message.role !== "toolResult") closeOpenCalls();
    switch (message.role) {
      case "user":
        context.push(message);
        break;
      case "assistant": {
        if (message.stopReason === "aborted" || message.stopReason === "error") break;
        context.push(message);
        for (const part of message.content) {
          if (part.type === "toolCall") openCalls.set(part.id, part);
        }
        break;
      }
      case "toolResult":
        // No matching open call means the parent assistant message was
        // dropped (or the result is a duplicate) — drop the result too.
        if (openCalls.delete(message.toolCallId)) context.push(message);
        break;
    }
  }
  closeOpenCalls();

  context.push(...steeringMessages);
  return context;
}
