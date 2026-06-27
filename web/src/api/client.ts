// A tiny typed wrapper over the Funky local client's REST API
// (client/local_python). JSON in, JSON out, snake_case throughout.
//
// Calls are same-origin by default (VITE_API_BASE empty), so in dev they go
// through the Vite proxy in vite.config.ts to the client on :8000 — no CORS.

import type { ApiErrorBody, CreatedId, SendMessageResponse } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

/** A failed API call: an HTTP error, the client's error code, or no connection. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    // The fetch never reached a server (client down, wrong port, DNS, …).
    throw new ApiError(
      "Can't reach the Funky client. Is `docker compose up` running and the client on :8000?",
      0,
    );
  }

  const text = await res.text();
  const data = text ? safeParse(text) : undefined;

  if (!res.ok) {
    const body = (data ?? {}) as ApiErrorBody;
    throw new ApiError(body.error || `Request failed (HTTP ${res.status})`, res.status, body.code);
  }
  return data as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface CreateAgentInput {
  name: string;
  model: string;
  system_prompt: string;
}

export const api = {
  health: () => request<{ status: string }>("/health", { method: "GET" }),

  createAgent: (input: CreateAgentInput) => postJson<CreatedId>("/v1/agents", input),

  createEnvironment: () => postJson<CreatedId>("/v1/environments", {}),

  createSession: (agentId: string, environmentId: string) =>
    postJson<CreatedId>("/v1/sessions", {
      agent_id: agentId,
      environment_id: environmentId,
    }),

  sendMessage: (sessionId: string, prompt: string) =>
    postJson<SendMessageResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { prompt },
    ),
};

/** A human-readable message for an error, with a hint when ids look stale. */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404 || err.code === "not_found") {
      return `${err.message} — the local backend doesn't recognize this id; its data may have been reset (e.g. \`docker compose down -v\`). Use ↺ reset in the sidebar to start fresh.`;
    }
    return err.message;
  }
  return fallback;
}
