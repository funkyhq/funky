// The top tab strip: one tab per session (active gets the blue dot + underline),
// a "+" to open a new session, and — pushed right — the active agent's mini
// avatar and model badge.

import { Avatar } from "./Avatar";
import { modelLabel } from "../lib/models";
import type { Agent } from "../types";

interface SessionTabsProps {
  agent: Agent;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export function SessionTabs({ agent, activeSessionId, onSelectSession, onNewSession }: SessionTabsProps) {
  return (
    <div className="tabstrip">
      {agent.sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            className={`tab${active ? " active" : ""}`}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="tab-dot" />
            {session.title}
            {active && <span className="tab-underline" />}
          </button>
        );
      })}

      <button className="tab-new" onClick={onNewSession} title="New session" aria-label="New session">
        +
      </button>

      <div className="tabstrip-right">
        <Avatar letter={agent.avatarLetter} size={26} fontSize={10} />
        <span className="model-badge">{modelLabel(agent.modelId)}</span>
      </div>
    </div>
  );
}
