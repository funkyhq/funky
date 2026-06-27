// Turn the events a turn produced (proto3 JSON) into flat ChatItems for render.

import type { AgentToolResult, ContentBlock, FunkyEvent } from "../api/types";
import type { ChatItem } from "../types";

function blocksText(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks.map((b) => b.text?.text ?? "").join("");
}

/** A stable React key per item: the backend Event id, or a fresh client id. */
function itemId(ev: FunkyEvent): string {
  return ev.id ?? crypto.randomUUID();
}

/**
 * Map the agent-produced events of one turn to ChatItems, preserving order.
 * The send endpoint returns only the agent's events (text, tool uses, tool
 * results) — the user's prompt is rendered optimistically by the caller.
 */
export function eventsToItems(events: FunkyEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  events.forEach((ev, idx) => {
    if (ev.agent_message) {
      const text = blocksText(ev.agent_message.content);
      if (text.trim()) items.push({ kind: "agent", id: itemId(ev), text });
    } else if (ev.agent_tool_use) {
      // Fold the tool call and its result into one item. The backend emits the
      // result as the next event referencing this call's id; if it's absent
      // (e.g. a future streaming backend, mid-call), the tool is still "running".
      const use = ev.agent_tool_use;
      const result = findToolResult(events, idx, use.id);
      const input = use.input ?? {};
      const command =
        typeof input.command === "string" ? input.command : JSON.stringify(input);
      items.push({
        kind: "tool",
        id: itemId(ev),
        name: use.name || "tool",
        command,
        output: result ? blocksText(result.content) : "",
        status: !result ? "running" : result.is_error ? "error" : "done",
      });
    } else if (ev.user_message) {
      // Not returned by `send` today, but handle it so a backend that ever echoes
      // the prompt doesn't drop it.
      const text = blocksText(ev.user_message.content);
      if (text.trim()) items.push({ kind: "user", id: itemId(ev), text });
    }
    // agent_tool_result events are folded into their tool_use above, so skipped.
  });
  return items;
}

/** The AgentToolResult answering the tool_use at `useIdx`, if present after it. */
function findToolResult(
  events: FunkyEvent[],
  useIdx: number,
  useId: string | undefined,
): AgentToolResult | undefined {
  for (let j = useIdx + 1; j < events.length; j++) {
    const result = events[j].agent_tool_result;
    if (result && result.tool_use_id === useId) return result;
  }
  return undefined;
}
