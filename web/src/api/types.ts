// The proto3-JSON shapes the local client returns. Field names are snake_case
// because the server serializes events with preserving_proto_field_name=True.
// Every field is optional: proto3 JSON omits defaults, and an Event sets exactly
// one of the payload fields (the proto `oneof`).

export interface TextBlock {
  text?: string;
}

export interface ContentBlock {
  // Only text blocks exist today; the block oneof grows image/document later.
  text?: TextBlock;
}

export interface UserMessage {
  content?: ContentBlock[];
}

export interface AgentMessage {
  content?: ContentBlock[];
}

export interface AgentToolUse {
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

export interface AgentToolResult {
  tool_use_id?: string;
  content?: ContentBlock[];
  is_error?: boolean;
}

/** One entry in a session's history; exactly one payload field is set. */
export interface FunkyEvent {
  id?: string;
  session_id?: string;
  processed_at?: string;
  user_message?: UserMessage;
  agent_message?: AgentMessage;
  agent_tool_use?: AgentToolUse;
  agent_tool_result?: AgentToolResult;
}

/** `POST /v1/agents | /v1/environments | /v1/sessions` ⇒ `{ "id": "..." }`. */
export interface CreatedId {
  id: string;
}

/** `POST /v1/sessions/{id}/messages` ⇒ the events the agent turn produced. */
export interface SendMessageResponse {
  events: FunkyEvent[];
}

/** Error envelope the client returns on a 4xx/5xx. */
export interface ApiErrorBody {
  error?: string;
  code?: string;
}
