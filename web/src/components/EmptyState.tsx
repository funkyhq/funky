// The new-session empty state (design Screen 2): floating mascot, a headline
// greeting the active agent, and a prompt to start typing.

import { Mascot } from "./Mascot";

export function EmptyState({ agentName }: { agentName: string }) {
  return (
    <div className="empty-state">
      <Mascot />
      <div className="empty-title">SAY HI TO {agentName.toUpperCase()}</div>
      <div className="empty-sub">
        New session ready. Type a message below to start the conversation.
      </div>
    </div>
  );
}
