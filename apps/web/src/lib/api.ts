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
 * The create body, minus the namespace this console pins for every call.
 * Every field is optional because every one has a default the api resolves
 * at create — an absent network is unrestricted, absent packages are none —
 * so what this omits is a decision left to the api, not one left unmade.
 */
export type CreateEnvConfigInput = {
  network?: NetworkPolicy;
  packages?: Packages;
  metadata?: unknown;
};

/**
 * Creates an env config and returns it MATERIALIZED: the defaults resolved,
 * so the answer is the recipe as stored rather than the request that was
 * sent. The namespace rides in the body here, as it does for agent configs.
 */
export function createEnvConfig(
  input: CreateEnvConfigInput = {},
  opts: { signal?: AbortSignal } = {},
): Promise<EnvConfig> {
  return post<EnvConfig>(
    "/v1/env-configs",
    { namespace: DEFAULT_NAMESPACE, ...input },
    {},
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

/** One recipe by id. What a deep link resolves against when the row isn't
 *  on a page the list has walked to yet. */
export function getEnvConfig(id: string, opts: { signal?: AbortSignal } = {}): Promise<EnvConfig> {
  return get<EnvConfig>(
    `/v1/env-configs/${encodeURIComponent(id)}`,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * A partial update, applied IN PLACE. Absent fields are left as they were,
 * so what a caller doesn't send — packages, metadata — survives the edit.
 *
 * There is no `version` here, and its absence is the point: an env config
 * has no immutable version to pin, so this carries no optimistic-concurrency
 * precondition the way an agent config's update does. Two edits racing means
 * the later write wins outright. An archived recipe takes no update at all —
 * the api answers 409 rather than reviving it.
 */
export type UpdateEnvConfigInput = {
  network?: NetworkPolicy;
  packages?: Packages;
  metadata?: unknown;
};

export function updateEnvConfig(
  id: string,
  input: UpdateEnvConfigInput,
  opts: { signal?: AbortSignal } = {},
): Promise<EnvConfig> {
  return post<EnvConfig>(
    `/v1/env-configs/${encodeURIComponent(id)}`,
    input,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * Archives a recipe and returns it carrying the mark. Terminal, and the api
 * has no route back: the row stays readable and the sessions that already
 * COPIED it keep running — a session provisions from its own copy rather
 * than through the id — but it takes no further update and no new session
 * can name it. Idempotent by consequence: a second call answers with the
 * first one's archivedAt rather than failing.
 *
 * It retires the recipe without EDITING it, so updatedAt does not move. That
 * is why this answer carries the same freshness token as the update before
 * it, and why the list breaks that tie toward archive (keepsArchive in
 * lib/useList.ts).
 */
export function archiveEnvConfig(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<EnvConfig> {
  return post<EnvConfig>(
    `/v1/env-configs/${encodeURIComponent(id)}/archive`,
    // No body, because the route takes none — there is nothing to say
    // beyond "retire this". JSON.stringify(undefined) is undefined, which
    // fetch sends as no body at all.
    undefined,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/**
 * The env recipe as it read when a session was created. A session COPIES
 * the recipe rather than pointing at it — env configs update in place, so
 * there is no version to pin — which is what keeps a run's world fixed
 * once it has started.
 */
export type EnvConfigSnapshot = {
  network: NetworkPolicy;
  packages: Packages;
};

/**
 * One session: an agent config at one pinned version, a copy of an env
 * recipe, and the durable append-only entry log the two run against.
 *
 * There is no state field here, and its absence is the point: funky
 * derives whether a session is running from its work items and its log
 * rather than storing it on the row, so the only status a session carries
 * on the wire is the lifecycle one below.
 */
export type Session = {
  id: string;
  namespace: string;
  agentConfigId: string;
  /** Pinned at creation, so a later update to the config cannot reshape a
   *  run already under way. */
  agentConfigVersion: number;
  /** Provenance for the snapshot beside it; nothing resolves through it. */
  envConfigId: string;
  envConfigSnapshot: EnvConfigSnapshot;
  /** The session's one workspace, registered when a worker first runs tools
   *  for it. Absent until then. */
  sandboxId?: string;
  createdAt: string;
  /** Set once retired. Archive is terminal, so absence is the active state. */
  archivedAt?: string;
  metadata?: unknown;
};

/**
 * One page of the namespace's sessions, newest first.
 *
 * `includeArchived` mirrors the api's own switch, default and all: the api
 * lists ACTIVE rows only unless asked, because archived history grows
 * without bound and a caller asking for its sessions usually means the live
 * ones. A caller that draws a status column wants both — that is the
 * console's editorial call, so the page makes it (see pages/Sessions.tsx).
 */
export function listSessions(
  opts: {
    after?: string;
    limit?: number;
    includeArchived?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<Page<Session>> {
  return get<Page<Session>>(
    "/v1/sessions",
    {
      namespace: DEFAULT_NAMESPACE,
      limit: opts.limit === undefined ? undefined : String(opts.limit),
      after: opts.after,
      // snake_case because the wire is, and spelled as a word rather than a
      // flag: the route parses "true"/"false" by name — JavaScript
      // truthiness would read "false" as true — so an absent switch has to
      // be absent from the query, not sent as an empty string.
      include_archived:
        opts.includeArchived === undefined ? undefined : String(opts.includeArchived),
    },
    opts.signal,
  );
}

/** One session by id. What the detail page resolves a link against — the
 *  list is a page of rows, and a session can be addressed without it. */
export function getSession(id: string, opts: { signal?: AbortSignal } = {}): Promise<Session> {
  return get<Session>(
    `/v1/sessions/${encodeURIComponent(id)}`,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

/** The create body, minus the namespace this console pins for every call.
 *  Omitting `agentConfigVersion` pins the config's latest version at create,
 *  which is what a console starting a session from a picker means. */
export type CreateSessionInput = {
  agentConfigId: string;
  agentConfigVersion?: number;
  envConfigId: string;
  metadata?: unknown;
};

/**
 * Creates a session and returns it materialized: the agent version pinned
 * and the env recipe copied, so the answer is the world the run will have
 * rather than the request that asked for it. The namespace rides in the
 * body here, as it does for both config creates.
 *
 * An archived config answers 409 and an unknown one 400 — the api's words
 * either way, which is why the dialog shows only active configs.
 */
export function createSession(
  input: CreateSessionInput,
  opts: { signal?: AbortSignal } = {},
): Promise<Session> {
  return post<Session>("/v1/sessions", { namespace: DEFAULT_NAMESPACE, ...input }, {}, opts.signal);
}

/**
 * Archives a session and returns it carrying the mark. Terminal, and the
 * api has no route back: the log stays readable and every client write
 * closes with it — no further message, no cancel, no sandbox rebinding.
 *
 * Unlike a config's archive this one can be REFUSED. The api takes the
 * transition only while the session is IDLE and answers 409 while a work
 * item is still open, and nothing on the wire says which a session is —
 * running is derived from its items rather than stored on the row (see
 * Session) — so the refusal is the only way to find out.
 *
 * A message parked behind a cancelled run is drained into the log by the
 * same transaction, so the log can grow at the very moment it closes.
 * Idempotent otherwise: a second call answers with the first one's
 * archivedAt rather than failing.
 */
export function archiveSession(id: string, opts: { signal?: AbortSignal } = {}): Promise<Session> {
  return post<Session>(
    `/v1/sessions/${encodeURIComponent(id)}/archive`,
    // No body, because the route takes none — there is nothing to say
    // beyond "retire this". JSON.stringify(undefined) is undefined, which
    // fetch sends as no body at all.
    undefined,
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}

// --- the session log ---
//
// Messages are what the model sees; entries are what the store owns. The
// console only reads them, so what follows mirrors the payloads without the
// vocabulary core needs to write them.

/** A vendor's own continuity data, keyed by vendor namespace. Opaque here
 *  exactly as it is in core: the console renders parts, never replays them. */
type ProviderMetadata = unknown;

export type TextContent = { type: "text"; text: string; providerMetadata?: ProviderMetadata };
export type ImageContent = { type: "image"; data: string; mimeType: string };
export type ThinkingContent = {
  type: "thinking";
  /** Empty for a redacted block — the vendor keeps the text. */
  thinking: string;
  providerMetadata?: ProviderMetadata;
  /** Legacy, Anthropic-only, no longer written; rows older than
   *  providerMetadata carry the signature here. */
  thinkingSignature?: string;
  redacted?: boolean;
};
export type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerMetadata?: ProviderMetadata;
};

/** Token counts only — cost is computed at display time from pricing, never
 *  stored, so a price change can't reinterpret an old session. */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A subset of `output`, when the provider reports the breakdown. */
  reasoning?: number;
};

/** Why a turn ended. The last two are the harness's own outcomes, not the
 *  provider's, and such messages are kept in the log but left out of the
 *  context a later turn is built from. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error";

export type UserMessage = { role: "user"; content: Array<TextContent | ImageContent> };

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCall>;
  model: string;
  stopReason: StopReason;
  /** Absent when the stream died before the provider reported usage. */
  usage?: Usage;
  /** Set when stopReason is "error". */
  errorMessage?: string;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  /** Tool-specific payload for a UI to render; never sent to the model. */
  details?: unknown;
  isError: boolean;
};

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** The envelope the store mints around every payload: an id, the session's
 *  own gapless ordering, and when it landed. */
type EntryBase = { id: string; seq: number; timestamp: string };

/**
 * One row of the session log. `message` is the transcript; the other three
 * are the log's other tenants — an app's own payload, a reserved compaction
 * marker, and the harness control plane — and a reader that doesn't know a
 * type must skip it rather than guess.
 */
export type SessionEntry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & { type: "custom"; namespace: string; data: unknown })
  | (EntryBase & { type: "compaction"; summary: string; upToSeq: number })
  | (EntryBase & { type: "control"; control: "cancel" });

/**
 * What a message did, decided inside intake's transaction: it either
 * started a run or queued behind the one already going.
 *
 * The difference is visible, and a chat has to say so — a queued message is
 * NOT in the log yet. It waits in its own table and is appended when the
 * run it arrived behind ends, so until then the only place it exists for a
 * reader is the client that sent it.
 */
export type IntakeResult =
  { kind: "started"; itemId: string } | { kind: "queued"; inputId: string };

/** The log from `after` on, in seq order — the whole log when `after` is
 *  absent. A bare array rather than a page: a session's log is read in
 *  full, and the stream below is how a caller follows it. */
export function readEntries(
  id: string,
  opts: { after?: number; signal?: AbortSignal } = {},
): Promise<SessionEntry[]> {
  return get<SessionEntry[]>(
    `/v1/sessions/${encodeURIComponent(id)}/entries`,
    {
      namespace: DEFAULT_NAMESPACE,
      after: opts.after === undefined ? undefined : String(opts.after),
    },
    opts.signal,
  );
}

/**
 * The URL an EventSource tails the log from — a path, not a fetch, because
 * following the log is the browser's job here: EventSource reconnects on
 * its own and resumes with Last-Event-ID, which this route honors over
 * `after`. Same-origin, so it carries the proxy's auth like every other
 * call; EventSource could not have set a header anyway.
 */
export function entryStreamUrl(id: string, after?: number): string {
  return (
    `/v1/sessions/${encodeURIComponent(id)}/stream` +
    search({
      namespace: DEFAULT_NAMESPACE,
      after: after === undefined ? undefined : String(after),
    })
  );
}

/**
 * Sends a user message. 202 either way — the answer says what intake did
 * with it, never what the agent will do about it, which happens in a worker
 * afterwards. Plain text is the wire's other accepted spelling for content;
 * the api normalizes it and stamps the role.
 *
 * An archived session answers 409: it keeps its log readable and takes no
 * further client write.
 */
export function sendMessage(
  id: string,
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<IntakeResult> {
  return post<IntakeResult>(
    `/v1/sessions/${encodeURIComponent(id)}/messages`,
    { content: text },
    { namespace: DEFAULT_NAMESPACE },
    opts.signal,
  );
}
