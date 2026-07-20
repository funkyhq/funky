// packages/configs/src/types.ts
import type { ModelConfig, RuntimeConfig } from "@funky/db/schema";

/** Set by the auth middleware; consumed by every service method. */
export type AuthContext = {
  namespace: string; // "default" in OSS
  principal: string; // "token:default" | "user:..." | "key:..."
};

export type Agent = {
  type: "agent";
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  version: number; // latest
  system_prompt: string;
  model: ModelConfig;
  tool_policy: Record<string, unknown>;
  /** null = the native loop; {"type":"claude-code"} = the Claude Code harness. */
  runtime: RuntimeConfig | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type AgentVersion = {
  type: "agent_version";
  agent_id: string;
  version: number;
  system_prompt: string;
  model: ModelConfig;
  tool_policy: Record<string, unknown>;
  runtime: RuntimeConfig | null;
  created_at: string;
  created_by: string | null;
};

export type CreateAgentInput = {
  id?: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
  system_prompt: string;
  model: ModelConfig;
  tool_policy?: Record<string, unknown>;
  runtime?: RuntimeConfig | null;
};

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "id">>;

export type Page<T> = { data: T[]; has_more: boolean; last_id?: string };
