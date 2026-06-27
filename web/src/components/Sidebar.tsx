// The left Agents column: the "+ NEW AGENT" button, the agent list (active row
// gets the blue-tint fill + hard shadow), and the FUNKY wordmark pinned to the
// bottom with a subtle reset control.

import { Avatar } from "./Avatar";
import { modelLabel } from "../lib/models";
import type { Agent } from "../types";

interface SidebarProps {
  agents: Agent[];
  activeAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
  onReset: () => void;
}

export function Sidebar({ agents, activeAgentId, onSelectAgent, onNewAgent, onReset }: SidebarProps) {
  return (
    <aside className="sidebar">
      <button className="btn-primary new-agent" onClick={onNewAgent}>
        + NEW AGENT
      </button>

      <div className="section-label">AGENTS</div>

      <div className="agent-list">
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            active={agent.id === activeAgentId}
            onClick={() => onSelectAgent(agent.id)}
          />
        ))}
        {agents.length === 0 && (
          <div className="agent-empty">No agents yet — create one to start.</div>
        )}
      </div>

      <div className="sidebar-footer">
        <span className="wordmark">FUNKY</span>
        <button
          className="reset-link"
          onClick={onReset}
          title="Clear locally-stored agents, sessions, and history"
        >
          ↺ reset
        </button>
      </div>
    </aside>
  );
}

function AgentRow({ agent, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  return (
    <button className={`agent-row${active ? " active" : ""}`} onClick={onClick}>
      <Avatar letter={agent.avatarLetter} size={32} fontSize={12} />
      <span className="agent-meta">
        <span className="agent-name">{agent.name}</span>
        <span className="agent-model">{modelLabel(agent.modelId)}</span>
      </span>
    </button>
  );
}
