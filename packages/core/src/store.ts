import { z } from "zod";
import { NetworkPolicy, Packages } from "./environment";
import { JsonValue, UserMessage } from "./messages";
import { InferenceConfig } from "./inference";

/**
 * The Store port's vocabulary — the rows and results both sides of the
 * port speak. The api consumes the intake half (configs, sessions,
 * IntakeResult); the driver consumes the claim half (WorkItem,
 * PendingInput); store adapters implement all of it.
 *
 * The engine imports none of this: it speaks messages and entries only.
 * nextAction's cancelRequested input is computed by the driver at each
 * boundary from the log's control entries — no import edge.
 *
 * Request shapes (Create*Request, after InferenceRequest and
 * StreamRequest) become stored rows verbatim, plus store-minted envelope
 * fields (id/createdAt, and version/updatedAt on mutable agent configs).
 * Two rules keep every row one-shaped:
 * - Rows store decisions, not rules: a default that is RESOLVED at
 *   creation time is materialized into the stored row (network →
 *   unrestricted), so a later change of the platform default can never
 *   reinterpret an old row. Where absence itself is the fact (no
 *   sampling override, no metadata), absence is stored as absence.
 * - null never appears in structured vocabulary. Absence has one
 *   spelling — the TS-native one that composes with `?.`, `??`, and
 *   spread defaults. (Opaque JsonValue payloads are the caller's
 *   business and may contain anything JSON can.)
 *
 * Ids are opaque strings minted by the store. The aliases document which
 * id space a signature means; upgrading them to branded types later is a
 * change on this file only.
 */

export type ConfigId = string;
export type SessionId = string;
export type ItemId = string;
export type InputId = string;

// --- namespace ---

// The tenancy boundary, driven by the managed service's trusted gateway
// (an OSS deployment runs single-tenant). Ownership is exactly-one and
// lives as a fact on the three ownable row types — decided at create and
// immutable. Config creation requires that ownership explicitly; sessions
// still resolve absence to DEFAULT_NAMESPACE.
// Work items, entries, and pending inputs derive theirs through sessionId;
// the worker and the driver never read it. The store guarantees a session
// and its configs share one namespace, and scopes config references by the
// namespace they carry; a foreign config is "unknown" — indistinguishable
// from nonexistent, so nothing leaks.
export const DEFAULT_NAMESPACE = "default";

// --- configs ---

// Agent configs are mutable, with a monotonic version used for optional
// optimistic concurrency. Env configs update in place. Sessions pin the
// latest concrete agent version at creation, while retaining an env config
// reference.
//
// Archive is the one terminal transition: it retires an agent config
// without deleting it — the row stays readable and its versions stay
// resolvable (sessions that pinned one keep running), but it accepts no
// further update and no new session may reference it. There is no
// unarchive, so nothing here spells one.

/** A namespace-scoped reference to an agent config. */
export const AgentConfigRef = z.object({
  namespace: z.string().min(1),
  id: z.string().min(1),
});
export type AgentConfigRef = z.infer<typeof AgentConfigRef>;

/** A namespace-scoped reference to one immutable agent config version. */
export const AgentConfigVersionRef = AgentConfigRef.extend({
  version: z.number().int().min(1),
});
export type AgentConfigVersionRef = z.infer<typeof AgentConfigVersionRef>;

/** Lists one namespace's agent configs with keyset pagination. */
export const ListAgentConfigsRequest = z.object({
  namespace: z.string().min(1),
  limit: z.number().int().min(1),
  after: z.string().min(1).optional(),
});
export type ListAgentConfigsRequest = z.infer<typeof ListAgentConfigsRequest>;

export const CreateAgentConfigRequest = z.object({
  namespace: z.string().min(1),
  inference: InferenceConfig,
  systemPrompt: z.string(),
  metadata: JsonValue.optional(),
});
export type CreateAgentConfigRequest = z.infer<typeof CreateAgentConfigRequest>;

export const UpdateAgentConfigRequest = z.object({
  inference: InferenceConfig.optional(),
  systemPrompt: z.string().optional(),
  metadata: JsonValue.optional(),
  // Optional optimistic-concurrency precondition: version 3 updates only if 3 is current.
  version: z.number().int().min(1).optional(),
});
export type UpdateAgentConfigRequest = z.infer<typeof UpdateAgentConfigRequest>;

export const AgentConfig = CreateAgentConfigRequest.extend({
  id: z.string(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  // When the config was archived; absent means active. Absence is the
  // fact itself (no archive happened), so it is stored as absence — and
  // "archived" is a state with no exit, never a flag to toggle back.
  archivedAt: z.iso.datetime().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// The env config is the sandbox recipe describing the world a session runs in.
/** A namespace-scoped reference to an env config. */
export const EnvConfigRef = z.object({
  namespace: z.string().min(1),
  id: z.string().min(1),
});
export type EnvConfigRef = z.infer<typeof EnvConfigRef>;

/** Lists one namespace's env configs with keyset pagination. */
export const ListEnvConfigsRequest = z.object({
  namespace: z.string().min(1),
  limit: z.number().int().min(1),
  after: z.string().min(1).optional(),
});
export type ListEnvConfigsRequest = z.infer<typeof ListEnvConfigsRequest>;

export const CreateEnvConfigRequest = z.object({
  namespace: z.string().min(1),
  network: NetworkPolicy.optional(),
  // Presence is guaranteed at create() or creation fails — missing deps
  // surface at provision, not mid-session.
  packages: Packages.optional(),
  metadata: JsonValue.optional(),
});
export type CreateEnvConfigRequest = z.infer<typeof CreateEnvConfigRequest>;

/** An in-place partial update; omission preserves the stored field. */
export const UpdateEnvConfigRequest = z.object({
  network: NetworkPolicy.optional(),
  packages: Packages.optional(),
  metadata: JsonValue.optional(),
});
export type UpdateEnvConfigRequest = z.infer<typeof UpdateEnvConfigRequest>;

export const EnvConfig = CreateEnvConfigRequest.extend({
  id: z.string(),
  // Materialized at create — resolved decisions, not restatable defaults:
  network: NetworkPolicy, // absence resolved to { type: "unrestricted" }
  packages: Packages, // absence resolved to {}
  createdAt: z.iso.datetime(),
});
export type EnvConfig = z.infer<typeof EnvConfig>;

// --- sessions ---

export const CreateSessionRequest = z.object({
  agentConfigId: z.string(),
  // Omit to pin the latest version at creation time.
  agentConfigVersion: z.number().int().min(1).optional(),
  envConfigId: z.string(),
  // Explicit, not derived from the configs: deriving would let a leaked
  // foreign config id pull a session into the wrong namespace. The store
  // enforces the match instead.
  namespace: z.string().min(1).optional(),
  metadata: JsonValue.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const Session = CreateSessionRequest.extend({
  id: z.string(),
  namespace: z.string().min(1), // materialized: absence resolved to DEFAULT_NAMESPACE
  // Materialized from the request or the agent config's latest version.
  agentConfigVersion: z.number().int().min(1),
  // The session's one workspace, registered by the driver's first
  // execute_tools claim (Store.bindSandbox); absent until then.
  sandboxId: z.string().optional(),
  createdAt: z.iso.datetime(),
});
export type Session = z.infer<typeof Session>;

// --- work items ---

export const ItemType = z.enum(["inference", "execute_tools"]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum(["ready", "leased", "done"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const WorkItem = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: ItemType,
  status: ItemStatus,
  // Times claimed (claimItem increments; 0 = never claimed). attempt > 1
  // means an earlier claimer died holding this item — its side effects
  // may have run uncommitted, so the driver never re-executes tools on a
  // re-claim; it synthesizes interrupted results instead.
  attempt: z.number().int().min(0),
});
export type WorkItem = z.infer<typeof WorkItem>;

// --- pending inputs ---

// What is a run? It starts from a ueser query to the completion of
// the agent.

// A user message that arrived while a run was active (or parked by a
// cancelled run's terminal commit). Whether it steers or follows up is
// decided by which boundary drains it — inference prep vs terminal
// commit — never by the message itself.
export const PendingInput = z.object({
  id: z.string(),
  sessionId: z.string(),
  message: UserMessage,
  arrivedAt: z.iso.datetime(),
});
export type PendingInput = z.infer<typeof PendingInput>;

// --- intake ---

// intake()'s in-transaction branch: no open item → a new run starts, the
// message its input and an inference item its first step; open item → the
// message queues as a pending input.
export const IntakeResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    itemId: z.string(),
  }),
  z.object({
    kind: z.literal("queued"),
    inputId: z.string(),
  }),
]);
export type IntakeResult = z.infer<typeof IntakeResult>;
