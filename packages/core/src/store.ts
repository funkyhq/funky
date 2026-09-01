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
// immutable. Every create requires that ownership explicitly; resolving
// a default is the api gateway's job (DEFAULT_NAMESPACE below), never
// the store's.
// In this vocabulary, entries and pending inputs carry no namespace —
// theirs rides on the SessionRef that addresses them (adapters still
// store a copy as the partition key). Work items DO carry it here: a
// claim is the one read that starts from nothing, so the claimed row
// itself must hand the driver the scope its later refs carry. The
// driver only echoes that namespace back into refs — tenancy decisions
// stay at the api's gateway. The store guarantees a session and its
// configs share one namespace, and scopes every reference by the
// namespace it carries; a foreign row is "unknown" — indistinguishable
// from nonexistent, so nothing leaks.
export const DEFAULT_NAMESPACE = "default";

// --- configs ---

// Agent configs are mutable, with a monotonic version used for optional
// optimistic concurrency. Env configs update in place. Both being mutable,
// a session has to make each one durable at creation — by a different
// mechanism, because only one of them leaves something immutable to point
// at. It PINS the agent config's concrete version, and COPIES the env
// config's resolved recipe (EnvConfigSnapshot below), keeping the env
// config id beside the copy for provenance rather than resolution. Either
// way, a later edit cannot reshape a run already under way.
//
// Archive is the one terminal transition: it retires either config without
// deleting it. The row stays readable, and an agent config's versions stay
// resolvable; sessions that already pinned the agent version and copied the
// env recipe keep running. What stops is further update and use by a new
// session. There is no unarchive, so nothing here spells one.

/** A namespace-scoped reference to an agent config. */
export const AgentConfigRef = z.object({
  namespace: z.string().min(1),
  agentConfigId: z.string().min(1),
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

export const AgentConfig = AgentConfigRef.extend({
  ...CreateAgentConfigRequest.omit({ namespace: true }).shape,
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
  envConfigId: z.string().min(1),
});
export type EnvConfigRef = z.infer<typeof EnvConfigRef>;

/** Lists one namespace's env configs with keyset pagination. */
export const ListEnvConfigsRequest = z.object({
  namespace: z.string().min(1),
  limit: z.number().int().min(1),
  after: z.string().min(1).optional(),
});
export type ListEnvConfigsRequest = z.infer<typeof ListEnvConfigsRequest>;

/**
 * The recipe proper — the fields that describe the world, resolved, with
 * no envelope around them. Declared once here and derived from in every
 * direction: optional in the create and update requests (absence is a
 * default to resolve), required on the stored row, and required in the
 * copy a session carries. A capability promoted into the recipe therefore
 * cannot be half-wired — it becomes requestable, storable, and
 * snapshotted in one edit — and no session can provision from a recipe
 * that quietly lost a field.
 *
 * A session stores this by COPY rather than by reference: env configs
 * update in place, so there is no immutable version to pin the way a
 * session pins one agent config version. The copy is what makes a
 * session's world deterministic — a later edit can never reshape a run
 * already under way. envConfigId stays beside it for provenance; nothing
 * reads through it to provision.
 */
export const EnvConfigSnapshot = z.object({
  network: NetworkPolicy, // absence resolved to { type: "unrestricted" }
  // Presence is guaranteed at create() or creation fails — missing deps
  // surface at provision, not mid-session.
  packages: Packages, // absence resolved to {}
});
export type EnvConfigSnapshot = z.infer<typeof EnvConfigSnapshot>;

// The recipe arrives partial and is stored materialized: every field a
// request may omit is one the store resolves to a decision at create.
export const CreateEnvConfigRequest = z.object({
  namespace: z.string().min(1),
  ...EnvConfigSnapshot.partial().shape,
  metadata: JsonValue.optional(),
});
export type CreateEnvConfigRequest = z.infer<typeof CreateEnvConfigRequest>;

/** An in-place partial update; omission preserves the stored field. */
export const UpdateEnvConfigRequest = z.object({
  ...EnvConfigSnapshot.partial().shape,
  metadata: JsonValue.optional(),
});
export type UpdateEnvConfigRequest = z.infer<typeof UpdateEnvConfigRequest>;

export const EnvConfig = EnvConfigRef.extend({
  // Materialized at create — resolved decisions, not restatable defaults.
  ...EnvConfigSnapshot.shape,
  metadata: JsonValue.optional(),
  createdAt: z.iso.datetime(),
  // Set once when the recipe is retired. Absence is the active state;
  // archive is terminal, so there is no boolean state to toggle back.
  archivedAt: z.iso.datetime().optional(),
});
export type EnvConfig = z.infer<typeof EnvConfig>;

// --- sessions ---

/** A namespace-scoped reference to a session. */
export const SessionRef = z.object({
  namespace: z.string().min(1),
  sessionId: z.string().min(1),
});
export type SessionRef = z.infer<typeof SessionRef>;

/** Lists one namespace's sessions with keyset pagination. */
export const ListSessionsRequest = z.object({
  namespace: z.string().min(1),
  limit: z.number().int().min(1),
  after: z.string().min(1).optional(),
  // The default list is active rows only: archived history grows without
  // bound, and a caller asking for its sessions means the live ones. The
  // terminal rows are an explicit opt-in; retrieval by id is unaffected.
  includeArchived: z.boolean().optional(),
});
export type ListSessionsRequest = z.infer<typeof ListSessionsRequest>;

export const CreateSessionRequest = z.object({
  namespace: z.string().min(1),
  agentConfigId: z.string(),
  // Omit to pin the latest version at creation time.
  agentConfigVersion: z.number().int().min(1).optional(),
  envConfigId: z.string(),
  metadata: JsonValue.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

// The row is its own ref, like WorkItem: the key comes first, and the
// request's fields ride in verbatim minus namespace, which the key
// already carries — every field declared exactly once.
export const Session = SessionRef.extend({
  ...CreateSessionRequest.omit({ namespace: true }).shape,
  // Materialized from the request or the agent config's latest version.
  agentConfigVersion: z.number().int().min(1),
  // The env recipe as it read at create (EnvConfigSnapshot above). A
  // resolved decision, materialized like the version above it, so it is
  // always present — never restated from the env config row.
  envConfigSnapshot: EnvConfigSnapshot,
  // The session's one workspace, registered by the driver's first
  // execute_tools claim (Store.bindSandbox); absent until then.
  sandboxId: z.string().optional(),
  createdAt: z.iso.datetime(),
  // Archive is terminal: the session remains readable but accepts no new
  // client writes. Absence, rather than null, is the active state.
  archivedAt: z.iso.datetime().optional(),
});
export type Session = z.infer<typeof Session>;

// --- work items ---

export const ItemType = z.enum(["inference", "execute_tools"]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum(["ready", "leased", "done"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

/**
 * A reference to a work item — the full path to the row: namespace,
 * parent session, item.
 */
export const WorkItemRef = SessionRef.extend({
  itemId: z.string().min(1),
});
export type WorkItemRef = z.infer<typeof WorkItemRef>;

export const WorkItem = WorkItemRef.extend({
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
