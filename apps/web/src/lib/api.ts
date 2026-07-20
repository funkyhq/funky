// The Funky API client. Talks to the real REST API over same-origin relative paths; the
// Vite dev server proxies these to the backend and injects the bearer token (see
// vite.config.ts), so the browser never holds the credential and there is no CORS to fight.
import type {
  Agent,
  Environment,
  ModelConfig,
  Page,
  NetworkPolicy,
  RuntimeConfig,
  SendMessageResult,
  Session,
  SessionEvent,
} from './types'

export class ApiError extends Error {
  status: number
  errorType: string
  constructor(status: number, errorType: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorType = errorType
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    const err = json?.error
    throw new ApiError(res.status, err?.type ?? 'api_error', err?.message ?? res.statusText)
  }
  return json as T
}

// ---- health ----------------------------------------------------------------

/** Resolves true when the backend is reachable and healthy, false otherwise. */
export async function checkHealth(timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('/healthz', { signal: ctrl.signal })
    if (!res.ok) return false
    const json = await res.json().catch(() => null)
    return json?.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---- agents -----------------------------------------------------------------

export type CreateAgentInput = {
  name: string
  system_prompt: string
  model: ModelConfig
  runtime?: RuntimeConfig | null
  description?: string | null
}

export const agents = {
  create: (input: CreateAgentInput) => request<Agent>('POST', '/v1/agents', input),
  list: (params?: { limit?: number; after_id?: string; include_archived?: boolean }) =>
    request<Page<Agent>>('GET', `/v1/agents${query(params)}`),
  get: (id: string) => request<Agent>('GET', `/v1/agents/${id}`),
  archive: (id: string) => request<Agent>('POST', `/v1/agents/${id}/archive`),
}

// ---- environments -----------------------------------------------------------

// The environment is just identity + network policy. The sandbox runtime image is the
// backend's concern, not a user field.
export type CreateEnvInput = {
  name: string
  description?: string | null
  network: NetworkPolicy
}

export const environments = {
  create: (input: CreateEnvInput) =>
    request<Environment>('POST', '/v1/environments', {
      name: input.name,
      description: input.description ?? null,
      network: input.network,
    }),
  list: (params?: { limit?: number; after_id?: string; include_archived?: boolean }) =>
    request<Page<Environment>>('GET', `/v1/environments${query(params)}`),
  get: (id: string) => request<Environment>('GET', `/v1/environments/${id}`),
  archive: (id: string) => request<Environment>('POST', `/v1/environments/${id}/archive`),
  remove: (id: string) => request<void>('DELETE', `/v1/environments/${id}`),
}

// ---- sessions ---------------------------------------------------------------

export type CreateSessionInput = {
  agent: string // agent id (latest version resolved server-side)
  environment_id: string
  title?: string | null
}

export const sessions = {
  create: (input: CreateSessionInput) => request<Session>('POST', '/v1/sessions', input),
  list: (params?: { limit?: number; after_id?: string; include_archived?: boolean }) =>
    request<Page<Session>>('GET', `/v1/sessions${query(params)}`),
  get: (id: string) => request<Session>('GET', `/v1/sessions/${id}`),
  archive: (id: string) => request<Session>('POST', `/v1/sessions/${id}/archive`),
  sendMessage: (id: string, content: string) =>
    request<SendMessageResult>('POST', `/v1/sessions/${id}/messages`, { content }),
  events: (id: string, params?: { after_seq?: number; limit?: number }) =>
    request<Page<SessionEvent>>('GET', `/v1/sessions/${id}/events${query(params)}`),
  /**
   * Poll until a freshly-created session leaves `provisioning`. The very first message must
   * not be sent while the sandbox is still provisioning: the append would race the
   * `session_provisioned` event and the session can hang. Waiting for `ready` sidesteps that
   * without any server change (subsequent messages are always safe).
   */
  waitReady: async (id: string, timeoutMs = 30000): Promise<Session> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const s = await request<Session>('GET', `/v1/sessions/${id}`)
      if (s.status !== 'provisioning' || Date.now() > deadline) return s
      await new Promise((r) => setTimeout(r, 400))
    }
  },
}

// ---- SSE --------------------------------------------------------------------

const EVENT_TYPES = [
  'session_provisioned',
  'user_message',
  'assistant_message',
  'tool_result',
  'turn_completed',
  'turn_failed',
] as const

/**
 * Open a live event stream for a session. EventSource works over the same-origin proxied
 * path (the proxy adds auth) and auto-resumes via Last-Event-ID on reconnect. Pass
 * `afterSeq` to start after a cursor on the first connect. Returns a close function.
 */
export function streamEvents(
  sessionId: string,
  onEvent: (e: SessionEvent) => void,
  afterSeq?: number,
): () => void {
  const url =
    `/v1/sessions/${sessionId}/events/stream` +
    (afterSeq ? `?after_seq=${afterSeq}` : '')
  const es = new EventSource(url)
  const handler = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(ev.data) as SessionEvent)
    } catch {
      // ignore malformed frames / heartbeats
    }
  }
  for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener)
  return () => es.close()
}

// ---- helpers ----------------------------------------------------------------

function query(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return ''
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Concatenate the text blocks of an assistant_message / user_message payload. */
export function eventText(e: SessionEvent): string {
  return (e.payload.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
