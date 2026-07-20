// packages/ports/harness/src/drivers/claude-code-store.ts — the fenced SessionStore.
//
// The Agent SDK mirrors every transcript entry (JSONL line) to this adapter; entries
// are persisted VERBATIM in harness_transcript_entries and replayed by load() on
// resume. This is what makes the worker stateless: the binary's local JSONL lives on
// a per-attempt RAM disk and dies with the attempt; Postgres holds the trajectory.
//
// The append is WRITE-FENCED — the harness twin of the event log's conditional
// append. The check is fused into the INSERT (single statement, no TOCTOU): rows land
// only while sessions.harness_attempt still equals this attempt's token. A zombie
// worker's batches affect zero rows; the adapter then re-reads the fence to
// distinguish "I was fenced out" (HarnessFencedError → stand down) from "every entry
// was a duplicate" (fine — mirror retries re-deliver batches; the partial unique
// index on entry_uuid makes re-delivery a no-op).

import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@funky/db";
import { harnessTranscriptEntries, sessions } from "@funky/db/schema";
import { HarnessFencedError } from "../port";

export type DrizzleSessionStoreOptions = {
  db: Db;
  namespace: string;
  /** The Funky session id — scopes every row; NOT the vendor session id. */
  funkySessionId: string;
  /** This attempt's fence token (sessions.harness_attempt). */
  attempt: string;
};

export class DrizzleSessionStore implements SessionStore {
  private readonly db: Db;
  private readonly ns: string;
  private readonly sid: string;
  private readonly attempt: string;
  /** Set once this adapter observes it has been fenced out; the driver reads it to
   *  classify the SDK's mirror_error message. */
  fenced = false;

  constructor(opts: DrizzleSessionStoreOptions) {
    this.db = opts.db;
    this.ns = opts.namespace;
    this.sid = opts.funkySessionId;
    this.attempt = opts.attempt;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // One guarded statement: the fence subquery gates every row; WITH ORDINALITY keeps
    // the batch's order for the bigserial; ON CONFLICT eats re-delivered entries.
    const result = await this.db.execute(sql`
      insert into ${harnessTranscriptEntries}
        (project_key, sdk_session_id, subpath, entry_uuid, entry, namespace, funky_session_id)
      select ${key.projectKey}, ${key.sessionId}, ${key.subpath ?? ""},
             t.e->>'uuid', t.e, ${this.ns}, ${this.sid}
      from jsonb_array_elements(${JSON.stringify(entries)}::jsonb) with ordinality as t(e, i)
      where (select harness_attempt from ${sessions}
             where ${sessions.id} = ${this.sid} and ${sessions.namespace} = ${this.ns}) = ${this.attempt}
      order by t.i
      on conflict (sdk_session_id, subpath, entry_uuid) where entry_uuid is not null
      do nothing
    `);
    const inserted = result.rowCount ?? 0;
    if (inserted === entries.length) return;
    // Fewer rows than entries: either duplicates (benign) or the fence flipped. Only
    // now pay a read to find out — and if the fence flips between the insert and this
    // check, "fenced" is the correct answer anyway.
    const [row] = await this.db
      .select({ attempt: sessions.harnessAttempt })
      .from(sessions)
      .where(and(eq(sessions.id, this.sid), eq(sessions.namespace, this.ns)))
      .limit(1);
    if (row?.attempt !== this.attempt) {
      this.fenced = true;
      throw new HarnessFencedError(
        `attempt ${this.attempt} lost the write fence (current: ${row?.attempt ?? "none"})`,
      );
    }
    // Same fence, short row count → duplicates from a retried batch (only rows WITH a
    // uuid can hit the partial unique index; uuid-less rows always insert). Benign.
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = await this.db
      .select({ entry: harnessTranscriptEntries.entry })
      .from(harnessTranscriptEntries)
      .where(keyWhere(key))
      .orderBy(harnessTranscriptEntries.ord);
    if (rows.length === 0) return null;
    return rows.map((r) => r.entry as SessionStoreEntry);
  }

  /** Subagent transcript discovery on resume. */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ subpath: harnessTranscriptEntries.subpath })
      .from(harnessTranscriptEntries)
      .where(
        and(
          eq(harnessTranscriptEntries.projectKey, key.projectKey),
          eq(harnessTranscriptEntries.sdkSessionId, key.sessionId),
        ),
      );
    return rows.map((r) => r.subpath).filter((s) => s !== "");
  }

  /** Main key (no subpath) cascades to all subkeys, per the SessionStore contract. */
  async delete(key: SessionKey): Promise<void> {
    await this.db
      .delete(harnessTranscriptEntries)
      .where(
        key.subpath === undefined
          ? and(
              eq(harnessTranscriptEntries.projectKey, key.projectKey),
              eq(harnessTranscriptEntries.sdkSessionId, key.sessionId),
            )
          : keyWhere(key),
      );
  }
}

function keyWhere(key: SessionKey) {
  return and(
    eq(harnessTranscriptEntries.projectKey, key.projectKey),
    eq(harnessTranscriptEntries.sdkSessionId, key.sessionId),
    eq(harnessTranscriptEntries.subpath, key.subpath ?? ""),
  );
}

/** The resume tip: the vendor session id of the newest main-transcript row for a
 *  Funky session. Authoritative because fenced writes never land — every row belongs
 *  to a legitimate attempt (DESIGN.md §5.2). Null = the session has no transcript
 *  yet (first turn). */
export async function latestSdkSessionId(
  db: Db,
  namespace: string,
  funkySessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sdkSessionId: harnessTranscriptEntries.sdkSessionId })
    .from(harnessTranscriptEntries)
    .where(
      and(
        eq(harnessTranscriptEntries.namespace, namespace),
        eq(harnessTranscriptEntries.funkySessionId, funkySessionId),
        eq(harnessTranscriptEntries.subpath, ""),
      ),
    )
    .orderBy(sql`${harnessTranscriptEntries.ord} desc`)
    .limit(1);
  return row?.sdkSessionId ?? null;
}
