import type { ModelConfig, Provider } from './types'

// Provider availability is injected by Vite from the root .env. Only booleans reach the
// browser bundle; API keys stay in the dev-server/worker processes.
export const ANTHROPIC_ENABLED: boolean =
  typeof __ANTHROPIC_ENABLED__ !== 'undefined' ? __ANTHROPIC_ENABLED__ : false
export const TOGETHER_ENABLED: boolean =
  typeof __TOGETHER_ENABLED__ !== 'undefined' ? __TOGETHER_ENABLED__ : false

export type AvailableModelOption = {
  label: string
  provider: Provider
  model: string
  disabled?: false
}
export type UnavailableModelOption = {
  label: string
  disabled: true
}
export type ModelOption = AvailableModelOption | UnavailableModelOption

const ANTHROPIC_MODELS: AvailableModelOption[] = [
  { label: 'Opus 4.8', provider: 'anthropic', model: 'claude-opus-4-8' },
  { label: 'Sonnet 5', provider: 'anthropic', model: 'claude-sonnet-5' },
]

const TOGETHER_MODELS: ModelOption[] = [
  // Together lists Kimi K3 in its model library but marks its Serverless API endpoint as
  // coming soon. Keep it visible without creating agents that fail at inference time.
  { label: 'Kimi K3 — coming soon', disabled: true },
  { label: 'GLM-5.2', provider: 'togetherai', model: 'zai-org/GLM-5.2' },
  {
    label: 'DeepSeek V4 Pro',
    provider: 'togetherai',
    model: 'deepseek-ai/DeepSeek-V4-Pro',
  },
  { label: 'Qwen3.7 Max', provider: 'togetherai', model: 'Qwen/Qwen3.7-Max' },
  {
    label: 'Gemma 4 31B IT',
    provider: 'togetherai',
    model: 'google/gemma-4-31B-it',
  },
]

export const MODEL_OPTIONS: ModelOption[] = [
  ...(ANTHROPIC_ENABLED ? ANTHROPIC_MODELS : []),
  ...(TOGETHER_ENABLED ? TOGETHER_MODELS : []),
]

function isAvailable(option: ModelOption): option is AvailableModelOption {
  return option.disabled !== true
}

// The first enabled option is the default. The fallback is only used outside Vite or when
// no provider key is configured; ModelField renders a setup hint instead of a picker then.
const DEFAULT_MODEL: AvailableModelOption = MODEL_OPTIONS.find(isAvailable) ?? {
  label: 'Opus 4.8',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
}

export const DEFAULT_MODEL_LABEL = DEFAULT_MODEL.label

export function modelConfigFor(label: string): ModelConfig {
  const opt = MODEL_OPTIONS.find(
    (candidate): candidate is AvailableModelOption =>
      candidate.label === label && isAvailable(candidate),
  ) ?? DEFAULT_MODEL
  return { provider: opt.provider, model: opt.model }
}

// Friendly label for a stored agent's model, falling back to the raw id (e.g. agents
// created before this list changed).
export function modelLabel(model: ModelConfig): string {
  return MODEL_OPTIONS.find(
    (option) =>
      isAvailable(option) &&
      option.provider === model.provider &&
      option.model === model.model,
  )?.label ?? model.model
}
