// apps/web/src/lib/api.ts
// The api as the browser sees it: same-origin paths and no credential.
// Auth is the dev server's job — vite.config.ts proxies /v1 to the api and
// injects the bearer token — so nothing here, and nothing in the bundle,
// ever holds it.
//
// The wire types are hand-mirrored from @funky/core rather than imported:
// core's shapes are zod schemas, and a console that only reads JSON has no
// reason to pull a validator into the browser. What follows is exactly
// what apps/api returns, nothing more.

// The namespace is part of every request the api takes (create bodies
// carry it, id-addressed and list routes take ?namespace=); absence
// resolves to this default, and the console has no namespace switcher yet,
// so it addresses exactly this one.
export const DEFAULT_NAMESPACE = "default";

export type InferenceConfig = {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
};

/** One agent config, at one version. */
export type AgentConfig = {
  id: string;
  namespace: string;
  inference: InferenceConfig;
  systemPrompt: string;
  /** Monotonic; an update lands as the next version rather than a rewrite. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Set once retired. Archive is terminal, so absence is the active state. */
  archivedAt?: string;
  metadata?: unknown;
};

/** The envelope every collection route returns (api routes/common.ts). */
export type Page<T> = {
  data: T[];
  hasMore: boolean;
  /** Cursor for the next page — what to send as `after`; absent when empty. */
  lastId?: string;
};

/** A failed call, carrying the api's own message when it sent one. */
export class ApiError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// The console's likeliest failure by far, and neither "Failed to fetch" nor
// "502 Bad Gateway" names it: the api isn't up, or the proxy can't reach it.
const UNREACHABLE = "Can't reach the api — is it running, and is FUNKY_API_URL right?";

/** The message out of the api's error envelope, or what the status means. */
async function failure(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => undefined);
  const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
  // A gateway status carries no envelope because the api never answered:
  // it is the dev server's proxy speaking, so say what that means.
  const gateway = res.status === 502 || res.status === 503 || res.status === 504;
  return new ApiError(
    message ?? (gateway ? UNREACHABLE : `${res.status} ${res.statusText}`),
    res.status,
  );
}

/** One call, with every failure already shaped: an abort stays an abort,
 *  an unreachable api says so, and anything else carries the api's own
 *  message (see failure()). */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: "application/json", ...init.headers } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(UNREACHABLE);
  }
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

function get<T>(
  path: string,
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  return request<T>(`${path}?${query}`, { signal });
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // JSON.stringify drops undefined properties, so an optional field left
    // unset is absent from the body rather than sent as null — which is
    // what the api's schemas mean by optional.
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * One page of the namespace's agent configs, newest first. The api resolves
 * each config to its CURRENT version, so a config appears once here however
 * many times it has been updated.
 */
export function listAgentConfigs(
  opts: { after?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<Page<AgentConfig>> {
  return get<Page<AgentConfig>>(
    "/v1/agent-configs",
    {
      namespace: DEFAULT_NAMESPACE,
      limit: opts.limit === undefined ? undefined : String(opts.limit),
      after: opts.after,
    },
    opts.signal,
  );
}

/** The create body, minus the namespace this console pins for every call. */
export type CreateAgentConfigInput = {
  inference: InferenceConfig;
  systemPrompt: string;
  metadata?: unknown;
};

/**
 * Creates an agent config and returns it at version 1. The namespace rides
 * in the BODY here — the create route takes the core request as its wire
 * shape — where the other routes take it as ?namespace=.
 */
export function createAgentConfig(
  input: CreateAgentConfigInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentConfig> {
  return post<AgentConfig>(
    "/v1/agent-configs",
    { namespace: DEFAULT_NAMESPACE, ...input },
    opts.signal,
  );
}
