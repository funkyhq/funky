// The scrolling message area. Empty (and idle) ⇒ the new-session empty state;
// otherwise the messages, plus the typing dots while a turn is in flight.
//
// User messages are right-aligned bubbles; everything the assistant produces in
// one turn (reply text + tool cartridges) is grouped under a single avatar.
// Auto-scrolls to the newest content.

import { useEffect, useRef } from "react";

import { EmptyState } from "./EmptyState";
import { Turn } from "./Turn";
import { TypingIndicator } from "./TypingIndicator";
import type { Agent, ChatItem, Session } from "../types";

type Group =
  | { kind: "user"; item: Extract<ChatItem, { kind: "user" }> }
  | { kind: "error"; item: Extract<ChatItem, { kind: "error" }> }
  | { kind: "turn"; key: string; items: ChatItem[] };

/** Collapse a flat item list into render groups: a turn is a run of consecutive
 *  assistant items (reply text + tool calls) between user/error messages. */
function groupItems(items: ChatItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ kind: "user", item });
    } else if (item.kind === "error") {
      groups.push({ kind: "error", item });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === "turn") last.items.push(item);
      else groups.push({ kind: "turn", key: item.id, items: [item] });
    }
  }
  return groups;
}

export function Conversation({ agent, session }: { agent: Agent; session: Session }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.items.length, session.typing]);

  if (session.items.length === 0 && !session.typing) {
    return <EmptyState agentName={agent.name} />;
  }

  return (
    <div className="conversation">
      {groupItems(session.items).map((group) => {
        if (group.kind === "user") {
          return (
            <div key={group.item.id} className="msg msg-user">
              {group.item.text}
            </div>
          );
        }
        if (group.kind === "error") {
          return (
            <div key={group.item.id} className="msg-error">
              ⚠ {group.item.text}
            </div>
          );
        }
        return <Turn key={group.key} items={group.items} avatarLetter={agent.avatarLetter} />;
      })}
      {session.typing && <TypingIndicator letter={agent.avatarLetter} />}
      <div ref={endRef} />
    </div>
  );
}
