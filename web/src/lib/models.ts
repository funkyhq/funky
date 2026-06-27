// The three models the Create-Agent modal offers. `label` is the chunky badge
// text from the design; `id` is the model string the agent-service forwards to
// the Anthropic Messages API (agent_service/local_python_anthropic).

export interface ModelOption {
  label: string;
  id: string;
}

export const MODELS: readonly ModelOption[] = [
  { label: "Opus 4.8", id: "claude-opus-4-8" },
  { label: "Sonnet 4.6", id: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
];

export const DEFAULT_MODEL = MODELS[0];

/** The badge label for a model id, falling back to the raw id if unknown. */
export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
