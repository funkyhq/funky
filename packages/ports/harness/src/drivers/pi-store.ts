// packages/ports/harness/src/drivers/pi-store.ts — the fenced pi transcript mirror.
//
// pi's SessionManager has no pluggable store: it owns a local JSONL session file
// (header line + tree-structured entries). The driver keeps that file on per-attempt
// scratch and mirrors every FileEntry — the header included, so the file is
// byte-reconstructible — into harness_transcript_entries. On resume the driver
// materializes the file from Postgres and SessionManager.open()s it; the worker
// stays stateless.
//
// The flush is WRITE-FENCED with the same guarded INSERT as the claude-code store:
// rows land only while sessions.harness_attempt still equals this attempt's token
// (check fused into the INSERT — no TOCTOU). Unlike the claude-code SDK's opaque
// batched mirror, flushes here are driver-driven and awaited, so a fence loss
// surfaces as a thrown HarnessFencedError at the flush site, not a vendor
// "mirror_error" message. Entries dedupe on their pi entry id (entry_uuid), so
// re-flushing after a partial failure is a no-op.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@funky/db";
import { harnessTranscriptEntries, sessions } from "@funky/db/schema";
import { HarnessFencedError } from "../port";

/** harness_transcript_entries.project_key for every pi row. pi has no projectKey
 *  concept (the claude-code SDK derives one from the cwd); a constant keeps the
 *  table's (project_key, sdk_session_id, subpath) key shape meaningful. */
export const PI_PROJECT_KEY = "pi";

/** One line of a pi session file: the header ({type:"session", id, ...}) or a
 *  session entry ({id, parentId, type, ...}). Persisted verbatim, opaque here. */
export type PiFileEntry = { id: string; type: string } & Record<string, unknown>;

export type PiTranscriptStoreOptions = {
  db: Db;
  namespace: string;
  /** The Funky session id — scopes every row; NOT pi's session id. */
  funkySessionId: string;
  /** This attempt's fence token (sessions.harness_attempt). */
  attempt: string;
};

export class PiTranscriptStore {
  private readonly db: Db;
  private readonly ns: string;
  private readonly sid: string;
  private readonly attempt: string;
  /** Entry ids already durably mirrored (or materialized from Postgres) — flush
   *  inserts only what this set lacks. */
  private readonly seen = new Set<string>();
  /** Serializes flushes: concurrent entry_appended events must not interleave
   *  batches, or ord would stop reflecting file order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: PiTranscriptStoreOptions) {
    this.db = opts.db;
    this.ns = opts.namespace;
    this.sid = opts.funkySessionId;
    this.attempt = opts.attempt;
  }

  /** Mark entries as already mirrored (the materialized prefix on resume). */
  preload(entries: PiFileEntry[]): void {
    for (const e of entries) this.seen.add(e.id);
  }

  /** Mirror every not-yet-seen entry, in file order, behind the fence. Rejects with
   *  HarnessFencedError if the attempt lost the fence — the caller must abort. */
  flush(sdkSessionId: string, fileEntries: PiFileEntry[]): Promise<void> {
    const next = this.chain.then(() => this.flushNow(sdkSessionId, fileEntries));
    this.chain = next.catch(() => {});
    return next;
  }

  private async flushNow(sdkSessionId: string, fileEntries: PiFileEntry[]): Promise<void> {
    const fresh = fileEntries.filter((e) => !this.seen.has(e.id));
    if (fresh.length === 0) return;
    // One guarded statement: the fence subquery gates every row; WITH ORDINALITY
    // keeps file order for the bigserial; ON CONFLICT eats re-delivered entries.
    const result = await this.db.execute(sql`
      insert into ${harnessTranscriptEntries}
        (project_key, sdk_session_id, subpath, entry_uuid, entry, namespace, funky_session_id)
      select ${PI_PROJECT_KEY}, ${sdkSessionId}, '',
             t.e->>'id', t.e, ${this.ns}, ${this.sid}
      from jsonb_array_elements(${JSON.stringify(fresh)}::jsonb) with ordinality as t(e, i)
      where (select harness_attempt from ${sessions}
             where ${sessions.id} = ${this.sid} and ${sessions.namespace} = ${this.ns}) = ${this.attempt}
      order by t.i
      on conflict (sdk_session_id, subpath, entry_uuid) where entry_uuid is not null
      do nothing
    `);
    const inserted = result.rowCount ?? 0;
    if (inserted < fresh.length) {
      // Fewer rows than entries: either duplicates (benign — e.g. rows another
      // attempt already mirrored) or the fence flipped. Only now pay a read to find
      // out — and if the fence flips between the insert and this check, "fenced" is
      // the correct answer anyway.
      const [row] = await this.db
        .select({ attempt: sessions.harnessAttempt })
        .from(sessions)
        .where(and(eq(sessions.id, this.sid), eq(sessions.namespace, this.ns)))
        .limit(1);
      if (row?.attempt !== this.attempt) {
        throw new HarnessFencedError(
          `attempt ${this.attempt} lost the write fence (current: ${row?.attempt ?? "none"})`,
        );
      }
    }
    for (const e of fresh) this.seen.add(e.id);
  }
}

/** The stored transcript for one pi session id, in file order — materialize this to
 *  a JSONL file (one entry per line, header first) and SessionManager.open() it. */
export async function loadPiTranscript(
  db: Db,
  namespace: string,
  funkySessionId: string,
  sdkSessionId: string,
): Promise<PiFileEntry[]> {
  const rows = await db
    .select({ entry: harnessTranscriptEntries.entry })
    .from(harnessTranscriptEntries)
    .where(
      and(
        eq(harnessTranscriptEntries.namespace, namespace),
        eq(harnessTranscriptEntries.funkySessionId, funkySessionId),
        eq(harnessTranscriptEntries.sdkSessionId, sdkSessionId),
        eq(harnessTranscriptEntries.subpath, ""),
      ),
    )
    .orderBy(harnessTranscriptEntries.ord);
  return rows.map((r) => r.entry as PiFileEntry);
}
