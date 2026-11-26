// F-04-14 증거 저장소 Drizzle 판(ops DB, 마이그레이션 0039).
// 묶음+첫 관리 연속성 행, 내보내기+EXPORTED 행은 같은 트랜잭션에 쓴다.
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { IdempotencyStore, systemClock, type Database, type DbTransaction } from '@peaket/platform';
import type {
  CustodyRecord,
  EvidenceBundleRecord,
  EvidenceBundleStatus,
  EvidenceExportRecord,
  ExternalPostRecord,
} from '../../domain/fraud-evidence.js';
import { custodyRowHash, disposeAfterMs } from '../../domain/fraud-evidence.js';
import type { FraudCaseRecord } from '../../domain/investigation.js';
import type { FraudEvidenceStore, IdempotentLookup, IdempotentWrite } from '../../domain/ports.js';
import { DrizzleInvestigationStore } from './drizzle-investigation-store.js';
import { evidenceBundle, evidenceCustodyLog, evidenceExport, externalPost } from './schema.js';

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());
const date = (n: number | null): Date | null => (n === null ? null : new Date(n));
const parseStored = (ref: string): unknown => {
  try {
    return JSON.parse(ref);
  } catch {
    return ref;
  }
};

type BundleRow = typeof evidenceBundle.$inferSelect;
type CustodyRow = typeof evidenceCustodyLog.$inferSelect;
type PostRow = typeof externalPost.$inferSelect;

export class DrizzleFraudEvidenceStore implements FraudEvidenceStore {
  readonly auditsWrites = false;
  readonly #idem: IdempotencyStore;
  #cases?: DrizzleInvestigationStore;

  constructor(private readonly db: Database, cases?: DrizzleInvestigationStore) {
    this.#idem = new IdempotencyStore({ clock: systemClock });
    this.#cases = cases;
  }

  async findByIdempotent(i: IdempotentWrite): Promise<IdempotentLookup> {
    const rows = (
      await this.db.db.execute(sql`select request_hash, result_ref from idempotency_record
        where account_ref = ${i.accountRef} and operation = ${i.operation} and idempotency_key = ${i.key}`)
    ).rows as { request_hash: Buffer; result_ref: string | null }[];
    const row = rows[0];
    if (!row) return { kind: 'none' };
    if (!Buffer.from(row.request_hash).equals(Buffer.from(i.requestHash))) return { kind: 'reused' };
    if (row.result_ref === null) return { kind: 'in_progress' };
    return { kind: 'replay', result: parseStored(row.result_ref) };
  }

  async putBundle(b: EvidenceBundleRecord, c: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>, o?: { idem?: IdempotentWrite; result?: unknown }) {
    if (!o?.idem) {
      await this.db.transaction(async (tx) => {
        await this.#insertBundle(tx, b);
        await this.#appendCustodyIn(tx, b.bundleId, c);
      });
      return { replayed: false };
    }
    const resultRef = JSON.stringify(o.result ?? {});
    return this.db.transaction((tx) =>
      this.#idem.run<{ replayed: boolean; result?: unknown }>(tx, o.idem!, {
        execute: async () => {
          await this.#insertBundle(tx, b);
          await this.#appendCustodyIn(tx, b.bundleId, c);
          return { resultRef, value: { replayed: false } };
        },
        replay: async (ref) => ({ replayed: true, result: parseStored(ref) }),
      }),
    );
  }

  async getBundle(bundleId: string): Promise<EvidenceBundleRecord | null> {
    const rows = await this.db.db.select().from(evidenceBundle).where(eq(evidenceBundle.id, bundleId)).limit(1);
    return rows[0] ? bundleOf(rows[0]) : null;
  }

  async listBundles(q: { eventId: string; cursor?: string; limit: number }): Promise<{ items: EvidenceBundleRecord[]; nextCursor: string | null }> {
    const rows = await this.db.db
      .select()
      .from(evidenceBundle)
      .where(and(eq(evidenceBundle.eventId, q.eventId), ...(q.cursor ? [gt(evidenceBundle.id, q.cursor)] : [])))
      .orderBy(desc(evidenceBundle.createdAt), asc(evidenceBundle.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { items: page.map(bundleOf), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }

  async listAllBundles(limit: number): Promise<EvidenceBundleRecord[]> {
    const rows = await this.db.db.select().from(evidenceBundle).orderBy(desc(evidenceBundle.createdAt)).limit(limit);
    return rows.map(bundleOf);
  }

  async updateBundle(b: EvidenceBundleRecord, expectedStatus?: readonly EvidenceBundleStatus[]): Promise<boolean> {
    const current = await this.getBundle(b.bundleId);
    if (!current) return false;
    if (current.holdReason !== 'OBJECTION' && b.holdReason === 'OBJECTION') throw new Error('보존 이유를 OBJECTION으로 되돌릴 수 없습니다');
    const rows = await this.db.db
      .update(evidenceBundle)
      .set({
        status: b.status,
        manifestSha256: b.manifestSha256,
        queries: b.queries,
        holdReason: b.holdReason,
        holdEndRequestedBy: b.holdEndRequestedBy,
        holdEndRequestedAt: date(b.holdEndRequestedAtMs),
        holdEndBasis: b.holdEndBasis,
        holdEndConfirmedBy: b.holdEndConfirmedBy,
        holdEndedAt: date(b.holdEndedAtMs),
        files: b.files,
      })
      .where(and(eq(evidenceBundle.id, b.bundleId), ...(expectedStatus ? [inArray(evidenceBundle.status, [...expectedStatus])] : [])))
      .returning({ id: evidenceBundle.id });
    return rows.length > 0;
  }

  async updateBundleWithCustody(
    b: EvidenceBundleRecord,
    c: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>,
    expectedStatus?: readonly EvidenceBundleStatus[],
    o?: { idem?: IdempotentWrite; result?: unknown },
  ): Promise<boolean> {
    const current = await this.getBundle(b.bundleId);
    if (!current) return false;
    if (current.holdReason !== 'OBJECTION' && b.holdReason === 'OBJECTION') throw new Error('보존 이유를 OBJECTION으로 되돌릴 수 없습니다');
    const run = async (tx: DbTransaction): Promise<boolean> => {
      const rows = await tx
        .update(evidenceBundle)
        .set({
          status: b.status,
          manifestSha256: b.manifestSha256,
          queries: b.queries,
          holdReason: b.holdReason,
          holdEndRequestedBy: b.holdEndRequestedBy,
          holdEndRequestedAt: date(b.holdEndRequestedAtMs),
          holdEndBasis: b.holdEndBasis,
          holdEndConfirmedBy: b.holdEndConfirmedBy,
          holdEndedAt: date(b.holdEndedAtMs),
          files: b.files,
        })
        .where(and(eq(evidenceBundle.id, b.bundleId), ...(expectedStatus ? [inArray(evidenceBundle.status, [...expectedStatus])] : [])))
        .returning({ id: evidenceBundle.id });
      if (rows.length === 0) return false;
      await this.#appendCustodyIn(tx, b.bundleId, c);
      return true;
    };
    if (!o?.idem) return this.db.transaction(run);
    const resultRef = JSON.stringify(o.result ?? {});
    return this.db.transaction((tx) =>
      this.#idem.run<boolean>(tx, o.idem!, {
        execute: async () => {
          const ok = await run(tx);
          if (!ok) throw new Error('bundle-status-conflict');
          return { resultRef, value: true };
        },
        replay: async () => true,
      }),
    );
  }

  async appendCustody(bundleId: string, c: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>): Promise<CustodyRecord> {
    return this.db.transaction((tx) => this.#appendCustodyIn(tx, bundleId, c));
  }

  async listCustody(bundleId: string): Promise<CustodyRecord[]> {
    const rows = await this.db.db.select().from(evidenceCustodyLog).where(eq(evidenceCustodyLog.bundleId, bundleId)).orderBy(asc(evidenceCustodyLog.seq));
    return rows.map(custodyOf);
  }

  async listDueForBuild(_nowMs: number, limit: number): Promise<EvidenceBundleRecord[]> {
    const rows = await this.db.db.select().from(evidenceBundle).where(eq(evidenceBundle.status, 'BUILDING')).orderBy(asc(evidenceBundle.createdAt)).limit(limit);
    return rows.map(bundleOf);
  }

  async listDueForDispose(nowMs: number, limit: number): Promise<EvidenceBundleRecord[]> {
    const rows = await this.db.db.select().from(evidenceBundle).where(eq(evidenceBundle.status, 'SEALED')).orderBy(asc(evidenceBundle.createdAt)).limit(limit);
    return rows.map(bundleOf).filter((b) => {
      try {
        return disposeAfterMs({ createdAtMs: b.createdAtMs, holdReason: b.holdReason, holdEndedAtMs: b.holdEndedAtMs }) <= nowMs;
      } catch {
        return false;
      }
    });
  }

  async putExport(e: EvidenceExportRecord, custody: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>, o?: { idem?: IdempotentWrite; result?: unknown }): Promise<void> {
    const run = async (tx: DbTransaction) => {
      await tx.insert(evidenceExport).values({
        id: e.exportId,
        bundleId: e.bundleId,
        kind: e.kind,
        dataRequestId: e.dataRequestId,
        documentId: e.documentId,
        sha256: e.sha256,
        rows: e.rows,
        reason: e.reason,
        actorId: e.actorId,
        createdAt: new Date(e.createdAtMs),
      });
      await this.#appendCustodyIn(tx, e.bundleId, custody);
    };
    if (!o?.idem) {
      await this.db.transaction(run);
      return;
    }
    const resultRef = JSON.stringify(o.result ?? {});
    await this.db.transaction((tx) =>
      this.#idem.run<void>(tx, o.idem!, {
        execute: async () => {
          await run(tx);
          return { resultRef, value: undefined };
        },
        replay: async () => undefined,
      }),
    );
  }

  async exportCountSince(actorId: string, sinceMs: number): Promise<number> {
    const rows = (await this.db.db.execute(sql`select count(*)::int as n from evidence_export where actor_id = ${actorId} and created_at >= ${new Date(sinceMs)}`)).rows as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }

  async listClosedCases(eventId: string): Promise<FraudCaseRecord[]> {
    this.#cases ??= new DrizzleInvestigationStore(this.db);
    const out: FraudCaseRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#cases.listCases({ eventId, status: ['ACTIONED', 'CLEARED', 'REVERSED'], limit: 1000, ...(cursor ? { cursor } : {}) });
      out.push(...page.items);
      if (page.nextCursor === null) return out;
      cursor = page.nextCursor;
    }
  }

  async putPost(p: ExternalPostRecord, o?: { idem?: IdempotentWrite; result?: unknown }) {
    if (!o?.idem) {
      await this.db.db.insert(externalPost).values(postValues(p));
      return { replayed: false };
    }
    const resultRef = JSON.stringify(o.result ?? {});
    return this.db.transaction((tx) =>
      this.#idem.run<{ replayed: boolean; result?: unknown }>(tx, o.idem!, {
        execute: async () => {
          await tx.insert(externalPost).values(postValues(p));
          return { resultRef, value: { replayed: false } };
        },
        replay: async (ref) => ({ replayed: true, result: parseStored(ref) }),
      }),
    );
  }

  async getPost(postId: string): Promise<ExternalPostRecord | null> {
    const rows = await this.db.db.select().from(externalPost).where(eq(externalPost.id, postId)).limit(1);
    return rows[0] ? postOf(rows[0]) : null;
  }

  async listPosts(q: { eventId: string; cursor?: string; limit: number }): Promise<{ items: ExternalPostRecord[]; nextCursor: string | null }> {
    const rows = await this.db.db
      .select()
      .from(externalPost)
      .where(and(eq(externalPost.eventId, q.eventId), ...(q.cursor ? [gt(externalPost.id, q.cursor)] : [])))
      .orderBy(desc(externalPost.createdAt), asc(externalPost.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { items: page.map(postOf), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }

  async updatePost(p: ExternalPostRecord): Promise<boolean> {
    const rows = await this.db.db.update(externalPost).set(postValues(p)).where(eq(externalPost.id, p.postId)).returning({ id: externalPost.id });
    return rows.length > 0;
  }

  async listPendingScans(limit: number): Promise<ExternalPostRecord[]> {
    const rows = await this.db.db.select().from(externalPost).where(eq(externalPost.scanStatus, 'PENDING')).orderBy(asc(externalPost.createdAt)).limit(limit);
    return rows.map(postOf);
  }

  async listUnusedPostsForDisposal(beforeMs: number, limit: number): Promise<ExternalPostRecord[]> {
    const rows = await this.db.db.select().from(externalPost).orderBy(asc(externalPost.createdAt)).limit(limit);
    return rows.map(postOf).filter((p) => p.createdAtMs < beforeMs && (p.scanStatus === 'THREAT' || p.matchedTicketIds.length === 0));
  }

  async #insertBundle(tx: DbTransaction, b: EvidenceBundleRecord): Promise<void> {
    await tx.insert(evidenceBundle).values({
      id: b.bundleId,
      caseId: b.caseId,
      eventId: b.eventId,
      status: b.status,
      snapshotHash: b.snapshotHash,
      manifestSha256: b.manifestSha256,
      queries: b.queries,
      s3Prefix: b.s3Prefix,
      holdReason: b.holdReason,
      holdEndRequestedBy: b.holdEndRequestedBy,
      holdEndRequestedAt: date(b.holdEndRequestedAtMs),
      holdEndBasis: b.holdEndBasis,
      holdEndConfirmedBy: b.holdEndConfirmedBy,
      holdEndedAt: date(b.holdEndedAtMs),
      createdBy: b.createdBy,
      createdAt: new Date(b.createdAtMs),
      files: b.files,
    });
  }

  async #appendCustodyIn(tx: DbTransaction, bundleId: string, c: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>): Promise<CustodyRecord> {
    const last = await tx.select().from(evidenceCustodyLog).where(eq(evidenceCustodyLog.bundleId, bundleId)).orderBy(desc(evidenceCustodyLog.seq)).limit(1);
    const seq = (last[0]?.seq ?? 0) + 1;
    const prevHash = last[0]?.rowHash ?? null;
    const rowHash = custodyRowHash({ bundleId, seq, ...c, prevHash });
    await tx.insert(evidenceCustodyLog).values({
      bundleId,
      seq,
      action: c.action,
      actorId: c.actorId,
      reason: c.reason,
      exportKind: c.exportKind,
      dataRequestId: c.dataRequestId,
      prevHash,
      rowHash,
      occurredAt: new Date(c.occurredAtMs),
    });
    return { bundleId, seq, ...c, prevHash: prevHash === null ? null : Buffer.from(prevHash, 'hex'), rowHash: Buffer.from(rowHash, 'hex') };
  }
}

const bundleOf = (r: BundleRow): EvidenceBundleRecord => ({
  bundleId: r.id,
  caseId: r.caseId,
  eventId: r.eventId,
  status: r.status as EvidenceBundleRecord['status'],
  snapshotHash: r.snapshotHash,
  manifestSha256: r.manifestSha256,
  queries: r.queries,
  s3Prefix: r.s3Prefix,
  holdReason: r.holdReason as EvidenceBundleRecord['holdReason'],
  holdEndRequestedBy: r.holdEndRequestedBy,
  holdEndRequestedAtMs: ms(r.holdEndRequestedAt),
  holdEndBasis: r.holdEndBasis,
  holdEndConfirmedBy: r.holdEndConfirmedBy,
  holdEndedAtMs: ms(r.holdEndedAt),
  createdBy: r.createdBy,
  createdAtMs: r.createdAt.getTime(),
  files: r.files,
});

const custodyOf = (r: CustodyRow): CustodyRecord => ({
  bundleId: r.bundleId,
  seq: r.seq,
  action: r.action as CustodyRecord['action'],
  actorId: r.actorId,
  reason: r.reason,
  exportKind: r.exportKind as CustodyRecord['exportKind'],
  dataRequestId: r.dataRequestId,
  prevHash: r.prevHash === null ? null : Buffer.from(r.prevHash, 'hex'),
  rowHash: Buffer.from(r.rowHash, 'hex'),
  occurredAtMs: r.occurredAt.getTime(),
});

const postValues = (p: ExternalPostRecord) => ({
  id: p.postId,
  eventId: p.eventId,
  url: p.url,
  site: p.site,
  capturedAt: new Date(p.capturedAtMs),
  source: p.source,
  reportCaseId: p.reportCaseId,
  claimedSeats: p.claimedSeats,
  postedAt: date(p.postedAtMs),
  maskRegions: p.maskRegions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
  captureKey: p.captureKey,
  captureSha256: p.captureSha256,
  scanStatus: p.scanStatus,
  matchedTicketIds: [...p.matchedTicketIds],
  registeredBy: p.registeredBy,
  createdAt: new Date(p.createdAtMs),
});

const postOf = (r: PostRow): ExternalPostRecord => ({
  postId: r.id,
  eventId: r.eventId,
  url: r.url,
  site: r.site,
  capturedAtMs: r.capturedAt.getTime(),
  postedAtMs: ms(r.postedAt),
  source: r.source as ExternalPostRecord['source'],
  reportCaseId: r.reportCaseId,
  claimedSeats: r.claimedSeats,
  maskRegions: r.maskRegions,
  captureKey: r.captureKey,
  captureSha256: r.captureSha256,
  scanStatus: r.scanStatus as ExternalPostRecord['scanStatus'],
  matchedTicketIds: r.matchedTicketIds,
  registeredBy: r.registeredBy,
  createdAtMs: r.createdAt.getTime(),
});
