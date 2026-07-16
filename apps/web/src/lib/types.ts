// Mirrors the real Funky API wire shapes (see apps/api + packages/*). The console codes
// against these directly — snake_case field names match the JSON on the wire.

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'openrouter'
  | 'togetherai'
  | 'fireworks'
  | 'baseten'

export type ModelConfig = {
  provider: Provider
  model: string
  max_tokens?: number
  temperature?: number
}

export type Agent = {
  type: 'agent'
  id: string
  name: string
  description: string | null
  metadata: Record<string, string>
  version: number
  system_prompt: string
  model: ModelConfig
  tool_policy: Record<string, unknown>
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type Egress = { allow: string[] }

export type Environment = {
  type: 'environment'
  id: string
  name: string
  description: string | null
  metadata: Record<string, string>
  egress: Egress
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type SessionStatus = 'provisioning' | 'ready' | 'failed' | 'archived'

export type Session = {
  type: 'session'
  id: string
  status: SessionStatus
  agent: { id: string; version: number }
  environment_id: string
  title: string | null
  metadata: Record<string, string>
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type TextBlock = { type: 'text'; text: string }
export type ContentBlock = TextBlock
export type ToolCall = { kind: 'exec'; cmd: string; timeout_ms?: number }

export type SessionEventType =
  | 'session_provisioned'
  | 'user_message'
  | 'assistant_message'
  | 'tool_result'
  | 'turn_completed'
  | 'turn_failed'

export type SessionEvent = {
  type: SessionEventType
  seq: number
  session_id: string
  created_at: string
  payload: {
    content?: ContentBlock[]
    tool_calls?: ToolCall[]
    usage?: { input_tokens: number; output_tokens: number }
    idem_key?: string
    output?: string
    exit_code?: number
    truncated?: boolean
    error_class?: string
    message?: string
  }
}

export type Page<T> = {
  data: T[]
  has_more: boolean
  last_id?: string
  last_seq?: number
}

export type SendMessageResult = { turn: 'queued'; seq: number }

// The API error envelope: { type: "error", error: { type, message }, request_id }
export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'api_error'
