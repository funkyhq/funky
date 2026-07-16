// packages/configs/src/envs-service.ts
// All business rules for the environments resource. Mirrors AgentsService minus
// versioning: envs are a single row, consumed once at sandbox provision, so
// update is a plain UPDATE (last-write-wins) and no transaction is needed.
// Every query is scoped by ctx.namespace.

import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "@funky/db";
import { envConfigs } from "@funky/db/schema";
import { ConflictError, NotFoundError } from "./errors";
import { isUniqueViolation, jsonEq } from "./util";
import type { CreateEnvInput, Environment, UpdateEnvInput } from "./envs-types";
import type { AuthContext, Page } from "./types";

const DEFAULT_EGRESS = { allow: [] as string[] }; // deny-all egress by default

type EnvRow = typeof envConfigs.$inferSelect;

export class EnvsService {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- create
  async create(
    ctx: AuthContext,
    input: CreateEnvInput,
  ): Promise<{ environment: Environment; created: boolean }> {
    const id = input.id ?? uuidv7();
    try {
      if (input.id) {
        const existing = await this.findRaw(ctx, input.id);
        if (existing) return this.resolveIdempotentCreate(existing, input);
      }
      const [row] = await this.db
        .insert(envConfigs)
        .values({
          id,
          namespace: ctx.namespace,
          name: input.name,
          description: input.description ?? null,
          metadata: input.metadata ?? {},
          egress: input.egress ?? DEFAULT_EGRESS,
        })
        .returning();
      return { environment: toEnvironment(row!), created: true };
    } catch (err) {
      // Two same-id creates raced: loser hits the PK. Re-resolve via idempotency.
      if (isUniqueViolation(err) && input.id) {
        const existing = await this.findRaw(ctx, input.id);
        if (existing) return this.resolveIdempotentCreate(existing, input);
      }
      throw err;
    }
  }

  private resolveIdempotentCreate(
    existing: EnvRow,
    input: CreateEnvInput,
  ): { environment: Environment; created: boolean } {
    const same =
      existing.name === input.name &&
      (existing.description ?? null) === (input.description ?? null) &&
      jsonEq(existing.metadata, input.metadata ?? {}) &&
      jsonEq(existing.egress, input.egress ?? DEFAULT_EGRESS);
    if (!same) {
      throw new ConflictError("an environment with this id exists with a different configuration");
    }
    return { environment: toEnvironment(existing), created: false };
  }

  // ------------------------------------------------------------------- get
  async get(ctx: AuthContext, id: string): Promise<Environment> {
    const row = await this.findRaw(ctx, id);
    if (!row) throw new NotFoundError("environment not found");
    return toEnvironment(row);
  }

  // ------------------------------------------------------------------ list
  async list(
    ctx: AuthContext,
    opts: { limit: number; afterId?: string; includeArchived: boolean },
  ): Promise<Page<Environment>> {
    const where = [eq(envConfigs.namespace, ctx.namespace)];
    if (opts.afterId) where.push(lt(envConfigs.id, opts.afterId));
    if (!opts.includeArchived) where.push(isNull(envConfigs.archivedAt));

    const rows = await this.db
      .select()
      .from(envConfigs)
      .where(and(...where))
      .orderBy(desc(envConfigs.id)) // uuidv7 ≈ newest first
      .limit(opts.limit + 1);

    const page = rows.slice(0, opts.limit);
    return {
      data: page.map(toEnvironment),
      has_more: rows.length > opts.limit,
      last_id: page.at(-1)?.id,
    };
  }

  // ---------------------------------------------------------------- update
  async update(ctx: AuthContext, id: string, patch: UpdateEnvInput): Promise<Environment> {
    const existing = await this.findRaw(ctx, id);
    if (!existing) throw new NotFoundError("environment not found");
    if (existing.archivedAt) throw new ConflictError("environment is archived and read-only");

    const [row] = await this.db
      .update(envConfigs)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.metadata !== undefined && { metadata: patch.metadata }), // replace, not merge
        ...(patch.egress !== undefined && { egress: patch.egress }),
        updatedAt: new Date(),
      })
      .where(and(eq(envConfigs.id, id), eq(envConfigs.namespace, ctx.namespace)))
      .returning();
    if (!row) throw new NotFoundError("environment not found");
    return toEnvironment(row);
  }

  // --------------------------------------------------------------- archive
  async archive(ctx: AuthContext, id: string): Promise<Environment> {
    // Idempotent: keeps the original archived_at if already set.
    await this.db
      .update(envConfigs)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(envConfigs.id, id),
          eq(envConfigs.namespace, ctx.namespace),
          isNull(envConfigs.archivedAt),
        ),
      );
    return this.get(ctx, id); // throws NotFound if it never existed in this ns
  }

  // ---------------------------------------------------------------- delete
  // TODO(sessions): once sessions reference envs, deletion of an in-use env
  // must be blocked (FK RESTRICT will handle it).
  async delete(ctx: AuthContext, id: string): Promise<void> {
    const rows = await this.db
      .delete(envConfigs)
      .where(and(eq(envConfigs.id, id), eq(envConfigs.namespace, ctx.namespace)))
      .returning({ id: envConfigs.id });
    if (rows.length === 0) throw new NotFoundError("environment not found");
  }

  // --------------------------------------------------------------- helpers
  private async findRaw(ctx: AuthContext, id: string): Promise<EnvRow | undefined> {
    const [row] = await this.db
      .select()
      .from(envConfigs)
      .where(and(eq(envConfigs.id, id), eq(envConfigs.namespace, ctx.namespace)));
    return row;
  }
}

// ------------------------------------------------------------ pure helpers

function toEnvironment(row: EnvRow): Environment {
  return {
    type: "environment",
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: row.metadata,
    egress: row.egress,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}
