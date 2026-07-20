// packages/configs/src/service.ts
// All business rules for the agents resource. The ONLY file (besides @funky/db
// itself) that touches Drizzle. Every query is scoped by ctx.namespace.

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "@funky/db";
import { agentConfigs, agentConfigVersions } from "@funky/db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { isUniqueViolation, jsonEq } from "./util";
import type {
  Agent,
  AgentVersion,
  AuthContext,
  CreateAgentInput,
  Page,
  UpdateAgentInput,
} from "./types";

const LABEL_FIELDS = ["name", "description", "metadata"] as const;
const BEHAVIOR_FIELDS = ["system_prompt", "model", "tool_policy", "runtime"] as const;

type IdentityRow = typeof agentConfigs.$inferSelect;
type VersionRow = typeof agentConfigVersions.$inferSelect;

export class AgentsService {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- create
  async create(
    ctx: AuthContext,
    input: CreateAgentInput,
  ): Promise<{ agent: Agent; created: boolean }> {
    const id = input.id ?? uuidv7();
    try {
      return await this.db.transaction(async (tx) => {
        if (input.id) {
          const existing = await this.findRaw(tx, ctx, input.id);
          if (existing) return this.resolveIdempotentCreate(existing, input);
        }
        await tx.insert(agentConfigs).values({
          id,
          namespace: ctx.namespace,
          name: input.name,
          description: input.description ?? null,
          metadata: input.metadata ?? {},
          latestVersion: 1,
        });
        await tx.insert(agentConfigVersions).values({
          agentConfigId: id,
          version: 1,
          namespace: ctx.namespace,
          systemPrompt: input.system_prompt,
          model: input.model,
          toolPolicy: input.tool_policy ?? {},
          runtime: input.runtime ?? null,
          createdBy: ctx.principal,
        });
        const created = await this.findRaw(tx, ctx, id);
        return { agent: toAgent(created!), created: true };
      });
    } catch (err) {
      // Two same-id creates raced: loser hits the PK. Re-resolve via idempotency.
      if (isUniqueViolation(err) && input.id) {
        const existing = await this.findRaw(this.db, ctx, input.id);
        if (existing) return this.resolveIdempotentCreate(existing, input);
      }
      throw err;
    }
  }

  private resolveIdempotentCreate(
    existing: { a: IdentityRow; v: VersionRow },
    input: CreateAgentInput,
  ): { agent: Agent; created: boolean } {
    const same =
      existing.a.name === input.name &&
      (existing.a.description ?? null) === (input.description ?? null) &&
      jsonEq(existing.a.metadata, input.metadata ?? {}) &&
      existing.v.systemPrompt === input.system_prompt &&
      jsonEq(existing.v.model, input.model) &&
      jsonEq(existing.v.toolPolicy, input.tool_policy ?? {}) &&
      jsonEq(existing.v.runtime ?? null, input.runtime ?? null);
    if (!same) {
      throw new ConflictError("an agent with this id exists with a different configuration");
    }
    return { agent: toAgent(existing), created: false };
  }

  // ------------------------------------------------------------------- get
  async get(ctx: AuthContext, id: string): Promise<Agent> {
    const row = await this.findRaw(this.db, ctx, id);
    if (!row) throw new NotFoundError("agent not found");
    return toAgent(row);
  }

  // ------------------------------------------------------------------ list
  async list(
    ctx: AuthContext,
    opts: { limit: number; afterId?: string; includeArchived: boolean },
  ): Promise<Page<Agent>> {
    const where = [eq(agentConfigs.namespace, ctx.namespace)];
    if (opts.afterId) where.push(lt(agentConfigs.id, opts.afterId));
    if (!opts.includeArchived) where.push(isNullArchived());

    const rows = await this.db
      .select({ a: agentConfigs, v: agentConfigVersions })
      .from(agentConfigs)
      .innerJoin(agentConfigVersions, latestVersionJoin()) // no N+1
      .where(and(...where))
      .orderBy(desc(agentConfigs.id)) // uuidv7 ≈ newest first
      .limit(opts.limit + 1);

    const page = rows.slice(0, opts.limit);
    return {
      data: page.map(toAgent),
      has_more: rows.length > opts.limit,
      last_id: page.at(-1)?.a.id,
    };
  }

  // ---------------------------------------------------------------- update
  async update(ctx: AuthContext, id: string, patch: UpdateAgentInput): Promise<Agent> {
    return this.db.transaction(async (tx) => {
      // FOR UPDATE serializes concurrent updates: two racers mint N+1 then N+2.
      const [ident] = await tx
        .select()
        .from(agentConfigs)
        .where(and(eq(agentConfigs.id, id), eq(agentConfigs.namespace, ctx.namespace)))
        .for("update");
      if (!ident) throw new NotFoundError("agent not found");
      if (ident.archivedAt) throw new ConflictError("agent is archived and read-only");

      const touchesLabels = LABEL_FIELDS.some((f) => patch[f] !== undefined);
      const touchesBehavior = BEHAVIOR_FIELDS.some((f) => patch[f] !== undefined);
      let latestVersion = ident.latestVersion;

      if (touchesBehavior) {
        const [cur] = await tx
          .select()
          .from(agentConfigVersions)
          .where(
            and(
              eq(agentConfigVersions.agentConfigId, id),
              eq(agentConfigVersions.version, ident.latestVersion),
            ),
          );
        latestVersion = ident.latestVersion + 1;
        await tx.insert(agentConfigVersions).values({
          agentConfigId: id,
          version: latestVersion,
          namespace: ctx.namespace,
          // omitted behavior fields carry forward from the current version
          systemPrompt: patch.system_prompt ?? cur!.systemPrompt,
          model: patch.model ?? cur!.model,
          toolPolicy: patch.tool_policy ?? cur!.toolPolicy,
          // `?? ` would swallow an explicit null (= reset to native); check presence.
          runtime: patch.runtime !== undefined ? patch.runtime : (cur!.runtime ?? null),
          createdBy: ctx.principal,
        });
      }

      if (touchesLabels || touchesBehavior) {
        await tx
          .update(agentConfigs)
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.metadata !== undefined && { metadata: patch.metadata }), // replace, not merge
            latestVersion,
            updatedAt: new Date(),
          })
          .where(eq(agentConfigs.id, id));
      }

      const row = await this.findRaw(tx, ctx, id);
      return toAgent(row!);
    });
  }

  // --------------------------------------------------------------- archive
  async archive(ctx: AuthContext, id: string): Promise<Agent> {
    // Idempotent: keeps the original archived_at if already set.
    const res = await this.db
      .update(agentConfigs)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentConfigs.id, id),
          eq(agentConfigs.namespace, ctx.namespace),
          isNullArchived(),
        ),
      );
    void res;
    return this.get(ctx, id); // throws NotFound if it never existed in this ns
  }

  // -------------------------------------------------------------- versions
  async listVersions(
    ctx: AuthContext,
    id: string,
    opts: { limit: number; afterVersion?: number },
  ): Promise<{ data: AgentVersion[]; has_more: boolean }> {
    await this.get(ctx, id); // 404 if the agent itself is missing

    const where = [
      eq(agentConfigVersions.agentConfigId, id),
      eq(agentConfigVersions.namespace, ctx.namespace),
    ];
    if (opts.afterVersion !== undefined) {
      where.push(lt(agentConfigVersions.version, opts.afterVersion));
    }
    const rows = await this.db
      .select()
      .from(agentConfigVersions)
      .where(and(...where))
      .orderBy(desc(agentConfigVersions.version))
      .limit(opts.limit + 1);

    return {
      data: rows.slice(0, opts.limit).map(toAgentVersion),
      has_more: rows.length > opts.limit,
    };
  }

  async getVersion(ctx: AuthContext, id: string, version: number): Promise<AgentVersion> {
    const [row] = await this.db
      .select()
      .from(agentConfigVersions)
      .where(
        and(
          eq(agentConfigVersions.agentConfigId, id),
          eq(agentConfigVersions.namespace, ctx.namespace),
          eq(agentConfigVersions.version, version),
        ),
      );
    if (!row) throw new NotFoundError("agent version not found");
    return toAgentVersion(row);
  }

  // --------------------------------------------------------------- helpers
  private async findRaw(
    db: Pick<Db, "select">,
    ctx: AuthContext,
    id: string,
  ): Promise<{ a: IdentityRow; v: VersionRow } | undefined> {
    const [row] = await db
      .select({ a: agentConfigs, v: agentConfigVersions })
      .from(agentConfigs)
      .innerJoin(agentConfigVersions, latestVersionJoin())
      .where(and(eq(agentConfigs.id, id), eq(agentConfigs.namespace, ctx.namespace)));
    return row;
  }
}

// ------------------------------------------------------------ pure helpers

function latestVersionJoin() {
  return and(
    eq(agentConfigVersions.agentConfigId, agentConfigs.id),
    eq(agentConfigVersions.version, agentConfigs.latestVersion),
  );
}

function isNullArchived() {
  return isNull(agentConfigs.archivedAt);
}

function toAgent(row: { a: IdentityRow; v: VersionRow }): Agent {
  return {
    type: "agent",
    id: row.a.id,
    name: row.a.name,
    description: row.a.description,
    metadata: row.a.metadata,
    version: row.a.latestVersion,
    system_prompt: row.v.systemPrompt,
    model: row.v.model,
    tool_policy: row.v.toolPolicy,
    runtime: row.v.runtime ?? null,
    created_at: row.a.createdAt.toISOString(),
    updated_at: row.a.updatedAt.toISOString(),
    archived_at: row.a.archivedAt?.toISOString() ?? null,
  };
}

function toAgentVersion(v: VersionRow): AgentVersion {
  return {
    type: "agent_version",
    agent_id: v.agentConfigId,
    version: v.version,
    system_prompt: v.systemPrompt,
    model: v.model,
    tool_policy: v.toolPolicy,
    runtime: v.runtime ?? null,
    created_at: v.createdAt.toISOString(),
    created_by: v.createdBy,
  };
}
