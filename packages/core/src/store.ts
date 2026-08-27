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
// (an OSS deployment runs single-tenant and never sets it). Ownership is
// exactly-one and lives as a fact on the three ownable row types —
// decided at create, immutable, resolved to DEFAULT_NAMESPACE when
// absent, like every other materialized default. Work items, entries,
// and pending inputs derive theirs through sessionId; the worker and
// the driver never read it. Enforcement is split: the store guarantees
// a session and its configs share one namespace (a foreign config is
// "unknown" — indistinguishable from nonexistent, so nothing leaks);
// scoping reads to a caller's namespace is the api's fetch-then-check.
export const DEFAULT_NAMESPACE = "default";

// --- configs ---

// Agent configs are mutable, with a monotonic version used for optional
// optimistic concurrency. Env configs remain immutable sandbox recipes.
// Sessions pin the latest concrete agent version at creation, so later agent
// updates cannot change the behavior of an existing session.

export const CreateAgentConfigRequest = z.object({
  inference: InferenceConfig,
  systemPrompt: z.string(),
  namespace: z.string().min(1).optional(),
  metadata: JsonValue.optional(),
});
export type CreateAgentConfigRequest = z.infer<typeof CreateAgentConfigRequest>;

// UpdateAgent-style partial replacement: omission preserves a field. `version`
// is a precondition, not stored payload — omit it for last-write-wins.
export const UpdateAgentConfigRequest = z.object({
  inference: InferenceConfig.optional(),
  systemPrompt: z.string().optional(),
  namespace: z.string().min(1).optional(),
  metadata: JsonValue.optional(),
  version: z.number().int().min(1).optional(),
});
export type UpdateAgentConfigRequest = z.infer<typeof UpdateAgentConfigRequest>;

export const AgentConfig = CreateAgentConfigRequest.extend({
  id: z.string(),
  namespace: z.string().min(1), // materialized: absence resolved to DEFAULT_NAMESPACE
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// The env config is the sandbox recipe — the immutable description of
// the world a session runs in.
export const CreateEnvConfigRequest = z.object({
  network: NetworkPolicy.optional(),
  // Presence is guaranteed at create() or creation fails — missing deps
  // surface at provision, not mid-session.
  packages: Packages.optional(),
  namespace: z.string().min(1).optional(),
  metadata: JsonValue.optional(),
});
export type CreateEnvConfigRequest = z.infer<typeof CreateEnvConfigRequest>;

export const EnvConfig = CreateEnvConfigRequest.extend({
  id: z.string(),
  // Materialized at create — resolved decisions, not restatable defaults:
  network: NetworkPolicy, // absence resolved to { type: "unrestricted" }
  packages: Packages, // absence resolved to {}
  namespace: z.string().min(1), // absence resolved to DEFAULT_NAMESPACE
  createdAt: z.iso.datetime(),
});
export type EnvConfig = z.infer<typeof EnvConfig>;

// --- sessions ---

export const CreateSessionRequest = z.object({
  agentConfigId: z.string(),
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
  // Materialized from the agent config's latest version at session create.
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
