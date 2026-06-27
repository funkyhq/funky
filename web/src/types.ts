// App-domain types (distinct from the wire types in api/types.ts).
//
// A conversation is a flat list of ChatItems: the agent turn returns text,
// tool calls, and tool results as separate events, and we render them in order.

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  // One tool call: the AgentToolUse merged with its matching AgentToolResult,
  // rendered as a single "cartridge" (command header + nested output).
  | {
      kind: "tool";
      id: string;
      name: string; // tool name → the chip label (e.g. "bash")
      command: string; // the command / input shown in the header
      output: string; // combined result text (empty until the result arrives)
      status: "running" | "done" | "error";
    }
  | { kind: "error"; id: string; text: string };

export interface Session {
  /** Backend session id, `ses_…`. */
  id: string;
  /** Display title, e.g. "Session 01". */
  title: string;
  items: ChatItem[];
  /** Draft text in the composer for this session. */
  composer: string;
  /** True while this session's agent turn is in flight (drives the typing dots). */
  typing: boolean;
}

export interface Agent {
  /** Backend agent id, `agt_…`. */
  id: string;
  name: string;
  /** Model string sent to the backend, e.g. "claude-opus-4-8". The display
   *  label (e.g. "Opus 4.8") is derived from this via modelLabel(). */
  modelId: string;
  systemPrompt: string;
  /** Single uppercase letter for the avatar. */
  avatarLetter: string;
  sessions: Session[];
  activeSessionId: string | null;
}

export interface AppState {
  agents: Agent[];
  activeAgentId: string | null;
  /** Shared environment id (`env_…`), created lazily and reused for new sessions. */
  environmentId: string | null;
  /** Whether the Create-Agent modal is open. */
  modalOpen: boolean;
  /** A transient error/notice shown as a toast (e.g. a failed "new session"). */
  banner: string | null;
}
