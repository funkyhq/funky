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

/** Reachability as intent, not mechanism: an adapter that cannot enforce
 *  what this asks for must refuse to provision rather than run more open. */
export type NetworkPolicy =
  { type: "unrestricted" } | { type: "none" } | { type: "allowlist"; domains: string[] };

/** Specs keyed by package manager ("pip", "npm", "apt", …), each spec left
 *  in its own ecosystem's syntax — the key names the interpreter. */
export type Packages = Record<string, string[]>;

/**
 * One env config: the sandbox recipe a session's commands run inside.
 * Unlike an agent config it is updated IN PLACE — there is no version to
 * pin, which is why a session copies the recipe instead of referencing it.
 */
export type EnvConfig = {
  id: string;
  namespace: string;
  network: NetworkPolicy;
  packages: Packages;
  createdAt: string;
  /** The latest edit to the recipe. Equal to createdAt until the first
   *  update; archiving retires it without editing it, so it does not move. */
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

/** The query string for the params that were given, or nothing at all. */
function search(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const rendered = query.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

function get<T>(
  path: string,
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path + search(params), { signal });
}

// Params as well as a body: the create route takes its namespace in the
// body (the core request IS the wire shape), every id-addressed route takes
// it as ?namespace=.
function post<T>(
  path: string,
  body: unknown,
  params: Record<string, string | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path + search(params), {
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
    {},
    opts.signal,
  );
}

/** One config at its current version, by id. What a deep link resolves
 *  against when the row isn't on a page the list has walked to yet. */
export function getAgentConfig(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentConfig> {
  return get<AgentConfig>(
    `/v1/agent-configs/${encodeURIComponent(id)}`,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * A partial update, which lands as the NEXT version rather than a rewrite.
 * Absent fields are left as they were — so what isn't sent is preserved,
 * metadata included — and any field that IS sent bumps the version even if
 * its value is unchanged, which is why callers send only what differs.
 */
export type UpdateAgentConfigInput = {
  inference?: InferenceConfig;
  systemPrompt?: string;
  /** Optimistic concurrency: the version this edit was made against. The
   *  api answers 409 if it is no longer the current one. */
  version?: number;
};

export function updateAgentConfig(
  id: string,
  input: UpdateAgentConfigInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentConfig> {
  return post<AgentConfig>(
    `/v1/agent-configs/${encodeURIComponent(id)}`,
    input,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * Archives a config and returns it carrying the mark. Terminal, and the
 * api has no route back: the row stays readable at every version and the
 * sessions that already pinned one keep running, but it takes no further
 * update and no new session can name it. Idempotent by consequence — a
 * second call answers with the first one's archivedAt rather than failing.
 */
export function archiveAgentConfig(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AgentConfig> {
  return post<AgentConfig>(
    `/v1/agent-configs/${encodeURIComponent(id)}/archive`,
    // No body, because the route takes none — there is nothing to say
    // beyond "retire this". JSON.stringify(undefined) is undefined, which
    // fetch sends as no body at all.
    undefined,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * One page of the namespace's env configs, newest first. Archived recipes
 * are listed beside live ones — they stay readable, and the sessions that
 * copied them keep running — so a row's status is worth a column.
 */
export function listEnvConfigs(
  opts: { after?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<Page<EnvConfig>> {
  return get<Page<EnvConfig>>(
    "/v1/env-configs",
    {
      namespace: DEFAULT_NAMESPACE,
      limit: opts.limit === undefined ? undefined : String(opts.limit),
      after: opts.after,
    },
    opts.signal,
  );
}
