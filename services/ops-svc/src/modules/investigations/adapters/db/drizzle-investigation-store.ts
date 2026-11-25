// F-04-12 조사 저장소 Drizzle 판(ops DB, 마이그레이션 0035).
// 사건 쓰기·감사 기록·멱등 기록은 같은 트랜잭션에 넣는다(IR-10·IR-11).
import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { IdempotencyStore, systemClock, type Database, type DbTransaction } from '@peaket/platform';
import { appendAuditIn } from '../../../audit/index.js';
import type {
  FraudCaseRecord,
  FraudCaseStatus,
  FraudClusterMemberRecord,
  FraudClusterRecord,
  FraudRunFailure,
  FraudRunRecord,
  FraudRunStatus,
  FraudRunTrigger,
  FraudSnapshotRecord,
} from '../../domain/investigation.js';
import type {
  CaseUpdateOutcome,
  CaseWriteOptions,
  CaseWriteOutcome,
  IdempotentLookup,
  IdempotentWrite,
  InvestigationStore,
} from '../../domain/ports.js';
import { fraudCase, fraudCaseEvent, fraudCluster, fraudClusterMember, fraudClusterRun, fraudSnapshot } from './schema.js';

const OPEN: readonly FraudCaseStatus[] = ['INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'ACTIONED', 'OBJECTED'];
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const scoreRank = (b: FraudClusterRecord['scoreBand']): number => (b === 'HIGH' ? 0 : b === 'MEDIUM' ? 1 : 2);
const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());
const date = (n: number | null): Date | null => (n === null ? null : new Date(n));

type CaseRow = typeof fraudCase.$inferSelect;
type MemberRow = typeof fraudClusterMember.$inferSelect;

const memberOf = (r: MemberRow): FraudClusterMemberRecord => ({
  accountId: r.accountId,
  ticketCount: r.ticketCount,
  signals: r.signals as FraudClusterMemberRecord['signals'],
  addedBy: r.addedBy as FraudClusterMemberRecord['addedBy'],
  removedAtMs: ms(r.removedAt),
  appealResult: r.appealResult as FraudClusterMemberRecord['appealResult'],
  appealDueAtMs: ms(r.appealDueAt),
  lockExpiresAtMs: ms(r.lockExpiresAt),
  ...(r.appealReasonCategories ? { appealReasonCategories: r.appealReasonCategories as FraudClusterMemberRecord['appealReasonCategories'] } : {}),
  ...(r.appealRequestedAt ? { appealRequestedAtMs: r.appealRequestedAt.getTime() } : {}),
  objectionResult: r.objectionResult as FraudClusterMemberRecord['objectionResult'],
  ...(r.objectionReceivedAt ? { objectionReceivedAtMs: r.objectionReceivedAt.getTime() } : {}),
  ...(r.objectionDecidedAt ? { objectionDecidedAtMs: r.objectionDecidedAt.getTime() } : {}),
  objectionDecisionReason: r.objectionDecisionReason,
});

/** result_ref는 응답 JSON이다. 옛 행이 ID만 담았으면 그 문자열을 그대로 돌려준다 */
const parseStoredResult = (ref: string): unknown => {
  try {
    return JSON.parse(ref);
  } catch {
    return ref;
  }
};

const sameHash = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

class CaseVersionConflict extends Error {}

export class DrizzleInvestigationStore implements InvestigationStore {
  readonly auditsWrites = true;
  readonly #idem: IdempotencyStore;

  constructor(private readonly db: Database) {
    this.#idem = new IdempotencyStore({ clock: systemClock });
  }

  async putSnapshot(s: FraudSnapshotRecord): Promise<void> {
    await this.db.db.insert(fraudSnapshot).values({
      eventId: s.eventId,
      version: s.version,
      frozenAt: new Date(s.frozenAtMs),
      invHash: s.invHash,
      tableHashes: s.tableHashes,
      prevHash: s.prevHash,
      rowCounts: s.rowCounts,
      rangeFrom: date(s.rangeFromMs),
      late: s.late,
      verifyStatus: s.verifyStatus,
      verifiedAt: date(s.verifiedAtMs),
    });
  }
  async latestSnapshot(eventId: string): Promise<FraudSnapshotRecord | null> {
    const rows = await this.db.db.select().from(fraudSnapshot).where(eq(fraudSnapshot.eventId, eventId)).orderBy(desc(fraudSnapshot.version)).limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      eventId: r.eventId,
      version: r.version,
      frozenAtMs: r.frozenAt.getTime(),
      invHash: r.invHash,
      prevHash: r.prevHash,
      tableHashes: r.tableHashes,
      rowCounts: r.rowCounts,
      rangeFromMs: ms(r.rangeFrom),
      late: r.late,
      verifyStatus: r.verifyStatus,
      verifiedAtMs: ms(r.verifiedAt),
    };
  }
  async verifySnapshot(eventId: string, version: number, status: 'OK' | 'MISMATCH', nowMs: number): Promise<void> {
    await this.db.db.update(fraudSnapshot).set({ verifyStatus: status, verifiedAt: new Date(nowMs) }).where(and(eq(fraudSnapshot.eventId, eventId), eq(fraudSnapshot.version, version)));
  }
  async isSnapshotExportBlocked(eventId: string, version: number): Promise<boolean> {
    const rows = await this.db.db
      .select({ status: fraudSnapshot.verifyStatus })
      .from(fraudSnapshot)
      .where(and(eq(fraudSnapshot.eventId, eventId), eq(fraudSnapshot.version, version)))
      .limit(1);
    return rows[0]?.status === 'MISMATCH';
  }
  async putRun(run: FraudRunRecord): Promise<void> {
    await this.db.db.insert(fraudClusterRun).values({
      eventId: run.eventId,
      generation: run.generation,
      attempt: run.attempt,
      trigger: run.trigger,
      failureReason: run.failureReason,
      snapshotVersion: run.snapshotVersion,
      ruleVersion: run.ruleVersion,
      resultFingerprint: run.resultFingerprint,
      clusterCount: run.clusterCount,
      status: run.status,
      startedAt: new Date(run.startedAtMs),
      finishedAt: date(run.finishedAtMs),
    });
  }
  async latestRun(eventId: string): Promise<FraudRunRecord | null> {
    const rows = await this.db.db
      .select()
      .from(fraudClusterRun)
      .where(eq(fraudClusterRun.eventId, eventId))
      .orderBy(desc(fraudClusterRun.generation), desc(fraudClusterRun.attempt))
      .limit(1);
    return rows[0] ? runOf(rows[0]) : null;
  }
  async listRuns(eventId: string): Promise<FraudRunRecord[]> {
    const rows = await this.db.db
      .select()
      .from(fraudClusterRun)
      .where(eq(fraudClusterRun.eventId, eventId))
      .orderBy(asc(fraudClusterRun.generation), asc(fraudClusterRun.attempt));
    return rows.map(runOf);
  }
  async putClusters(eventId: string, generation: number, clusters: readonly FraudClusterRecord[], ruleVersion: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const seen = await tx.select({ id: fraudCluster.id }).from(fraudCluster).where(and(eq(fraudCluster.eventId, eventId), eq(fraudCluster.generation, generation))).limit(1);
      if (seen[0]) return;
      for (const c of clusters) {
        await tx.insert(fraudCluster).values({
          id: c.clusterId,
          eventId: c.eventId,
          generation: c.generation,
          ruleVersion,
          scoreBand: c.scoreBand,
          accountCount: c.accountCount,
          purchaseCount: c.purchaseCount,
          limitPerPerson: c.limitPerPerson,
          sharedAttributes: c.sharedAttributes,
          signals: c.signals,
          snapshotVersion: c.snapshotVersion,
          createdAt: new Date(c.createdAtMs),
        });
        if (c.members.length > 0) {
          await tx.insert(fraudClusterMember).values(c.members.map((m) => memberValues(c.clusterId, m))).onConflictDoNothing();
        }
      }
    });
  }
  async listClusters(q: {
    eventId: string;
    generation: number;
    sort: 'SCORE_DESC' | 'PURCHASE_RATIO_DESC' | 'LATEST';
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudClusterRecord[]; nextCursor: string | null }> {
    const order =
      q.sort === 'LATEST'
        ? [desc(fraudCluster.createdAt), asc(fraudCluster.id)]
        : [sql`case ${fraudCluster.scoreBand} when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`, desc(fraudCluster.purchaseCount), asc(fraudCluster.id)];
    const rows = await this.db.db
      .select()
      .from(fraudCluster)
      .where(and(eq(fraudCluster.eventId, q.eventId), eq(fraudCluster.generation, q.generation), ...(q.cursor ? [gt(fraudCluster.id, q.cursor)] : [])))
      .orderBy(...order)
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const items: FraudClusterRecord[] = [];
    for (const r of page) {
      const members = await this.db.db.select().from(fraudClusterMember).where(eq(fraudClusterMember.clusterId, r.id)).orderBy(asc(fraudClusterMember.accountId));
      items.push(clusterOf(r, members));
    }
    if (q.sort === 'PURCHASE_RATIO_DESC') items.sort((a, b) => b.purchaseCount / b.limitPerPerson - a.purchaseCount / a.limitPerPerson || scoreRank(a.scoreBand) - scoreRank(b.scoreBand) || cmp(a.clusterId, b.clusterId));
    return { items, nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }
  async getCluster(clusterId: string): Promise<FraudClusterRecord | null> {
    const rows = await this.db.db.select().from(fraudCluster).where(eq(fraudCluster.id, clusterId)).limit(1);
    const r = rows[0];
    if (!r) return null;
    const members = await this.db.db.select().from(fraudClusterMember).where(eq(fraudClusterMember.clusterId, clusterId)).orderBy(asc(fraudClusterMember.accountId));
    return clusterOf(r, members);
  }

  /** ticket-svc 잠금 판. 시퀀스라 사건 트랜잭션이 되돌아가도 값이 재사용되지 않는다 */
  async nextLockVersion(): Promise<number> {
    const rows = (await this.db.db.execute(sql`select nextval('fraud_lock_version_seq') as v`)).rows as { v: string | number }[];
    return Number(rows[0]!.v);
  }

  async findIdempotent(i: IdempotentWrite): Promise<IdempotentLookup> {
    const rows = (
      await this.db.db.execute(sql`select request_hash, result_ref from idempotency_record
        where account_ref = ${i.accountRef} and operation = ${i.operation} and idempotency_key = ${i.key}`)
    ).rows as { request_hash: Buffer; result_ref: string | null }[];
    const row = rows[0];
    if (!row) return { kind: 'none' };
    if (!sameHash(Buffer.from(row.request_hash), i.requestHash)) return { kind: 'reused' };
    if (row.result_ref === null) return { kind: 'in_progress' };
    return { kind: 'replay', result: parseStoredResult(row.result_ref) };
  }

  async putCase(c: FraudCaseRecord, o?: CaseWriteOptions): Promise<CaseWriteOutcome | undefined> {
    const idem = o?.idem;
    const audit = o?.audit;
    if (!idem) {
      await this.db.transaction((tx) => this.#insertCase(tx, c, audit));
      return undefined;
    }
    const resultRef = JSON.stringify(o?.result ?? c.caseId);
    return this.db.transaction((tx) =>
      this.#idem.run<CaseWriteOutcome>(tx, idem, {
        execute: async () => {
          await this.#insertCase(tx, c, audit);
          return { resultRef, value: { replayed: false } };
        },
        replay: async (ref) => ({ replayed: true, result: parseStoredResult(ref) }),
      }),
    );
  }

  async getCase(caseId: string): Promise<FraudCaseRecord | null> {
    const rows = await this.db.db.select().from(fraudCase).where(eq(fraudCase.id, caseId)).limit(1);
    const r = rows[0];
    if (!r) return null;
    const members = await this.db.db.select().from(fraudClusterMember).where(eq(fraudClusterMember.clusterId, r.clusterId)).orderBy(asc(fraudClusterMember.accountId));
    const events = await this.db.db.select().from(fraudCaseEvent).where(eq(fraudCaseEvent.caseId, caseId)).orderBy(asc(fraudCaseEvent.seq));
    return caseOf(r, members, events);
  }
  async findCaseByCluster(clusterId: string): Promise<FraudCaseRecord | null> {
    const rows = await this.db.db.select().from(fraudCase).where(eq(fraudCase.clusterId, clusterId)).limit(1);
    return rows[0] ? this.getCase(rows[0].id) : null;
  }
  async listCases(q: {
    eventId?: string;
    status?: readonly FraudCaseStatus[];
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudCaseRecord[]; nextCursor: string | null }> {
    const where = [
      ...(q.eventId ? [eq(fraudCase.eventId, q.eventId)] : []),
      ...(q.status && q.status.length > 0 ? [inArray(fraudCase.status, [...q.status])] : []),
      ...(q.cursor ? [gt(fraudCase.id, q.cursor)] : []),
    ];
    const rows = await this.db.db
      .select()
      .from(fraudCase)
      .where(where.length > 0 ? and(...where) : sql`true`)
      .orderBy(asc(fraudCase.createdAt), asc(fraudCase.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const items: FraudCaseRecord[] = [];
    for (const r of page) {
      const got = await this.getCase(r.id);
      if (got) items.push(got);
    }
    return { items, nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
  }
  async updateCase(c: FraudCaseRecord, expectedVersion: number, events: readonly FraudCaseRecord['events'][number][], o?: CaseWriteOptions): Promise<CaseUpdateOutcome> {
    const idem = o?.idem;
    const audit = o?.audit;
    if (!idem) {
      const ok = await this.db.transaction((tx) => this.#updateCaseIn(tx, c, expectedVersion, events, audit));
      return { ok };
    }
    const resultRef = JSON.stringify(o?.result ?? {});
    try {
      return await this.db.transaction((tx) =>
        this.#idem.run<CaseUpdateOutcome>(tx, idem, {
          execute: async () => {
            const ok = await this.#updateCaseIn(tx, c, expectedVersion, events, audit);
            if (!ok) throw new CaseVersionConflict();
            return { resultRef, value: { ok: true, replayed: false } };
          },
          replay: async (ref) => ({ ok: true, replayed: true, result: parseStoredResult(ref) }),
        }),
      );
    } catch (e) {
      if (e instanceof CaseVersionConflict) return { ok: false };
      throw e;
    }
  }
  async markAppealSubmitted(caseId: string, accountId: string, nowMs: number): Promise<boolean> {
    const c = await this.getCase(caseId);
    const m = c?.members.find((x) => x.accountId === accountId && x.removedAtMs === null);
    if (!c || !m || m.appealResult !== 'PENDING') return false;
    await this.db.db
      .update(fraudClusterMember)
      .set({ appealResult: 'SUBMITTED', appealRequestedAt: new Date(nowMs) })
      .where(and(eq(fraudClusterMember.clusterId, c.clusterId), eq(fraudClusterMember.accountId, accountId)));
    return true;
  }
  async countCases(eventId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
    const rows = await this.db.db.select({ status: fraudCase.status, n: count() }).from(fraudCase).where(eq(fraudCase.eventId, eventId)).groupBy(fraudCase.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = Number(r.n);
      total += Number(r.n);
    }
    return { total, byStatus };
  }
  async hasOpenCase(eventId: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: fraudCase.id })
      .from(fraudCase)
      .where(and(eq(fraudCase.eventId, eventId), isNull(fraudCase.closedAt), inArray(fraudCase.status, [...OPEN])))
      .limit(1);
    return rows.length > 0;
  }
  async openCaseEvents(): Promise<string[]> {
    const rows = await this.db.db
      .selectDistinct({ eventId: fraudCase.eventId })
      .from(fraudCase)
      .where(and(isNull(fraudCase.closedAt), inArray(fraudCase.status, [...OPEN])));
    return rows.map((r) => r.eventId);
  }

  async #insertCase(tx: DbTransaction, c: FraudCaseRecord, audit?: CaseWriteOptions['audit']): Promise<void> {
    await tx.insert(fraudCase).values(caseValues(c));
    if (c.members.length > 0) await tx.insert(fraudClusterMember).values(c.members.map((m) => memberValues(c.clusterId, m))).onConflictDoNothing();
    if (c.events.length > 0) await tx.insert(fraudCaseEvent).values(c.events.map((e) => eventValues(c.caseId, e)));
    if (audit) await appendAuditIn(tx, audit);
  }

  async #updateCaseIn(
    tx: DbTransaction,
    c: FraudCaseRecord,
    expectedVersion: number,
    events: readonly FraudCaseRecord['events'][number][],
    audit?: CaseWriteOptions['audit'],
  ): Promise<boolean> {
    const updated = await tx
      .update(fraudCase)
      .set({ ...caseValues(c), version: c.version })
      .where(and(eq(fraudCase.id, c.caseId), eq(fraudCase.version, expectedVersion)))
      .returning({ id: fraudCase.id });
    if (updated.length === 0) return false;
    for (const m of c.members) {
      await tx.insert(fraudClusterMember).values(memberValues(c.clusterId, m)).onConflictDoUpdate({
        target: [fraudClusterMember.clusterId, fraudClusterMember.accountId],
        set: memberValues(c.clusterId, m),
      });
    }
    if (events.length > 0) await tx.insert(fraudCaseEvent).values(events.map((e) => eventValues(c.caseId, e)));
    if (audit) await appendAuditIn(tx, audit);
    return true;
  }
}

const runOf = (r: typeof fraudClusterRun.$inferSelect): FraudRunRecord => ({
  eventId: r.eventId,
  generation: r.generation,
  attempt: r.attempt,
  trigger: r.trigger as FraudRunTrigger,
  snapshotVersion: r.snapshotVersion,
  ruleVersion: r.ruleVersion,
  status: r.status as FraudRunStatus,
  failureReason: r.failureReason as FraudRunFailure | null,
  resultFingerprint: r.resultFingerprint,
  clusterCount: r.clusterCount,
  startedAtMs: r.startedAt.getTime(),
  finishedAtMs: ms(r.finishedAt),
});

const clusterOf = (r: typeof fraudCluster.$inferSelect, members: readonly MemberRow[]): FraudClusterRecord => ({
  clusterId: r.id,
  eventId: r.eventId,
  generation: r.generation,
  scoreBand: r.scoreBand as FraudClusterRecord['scoreBand'],
  accountCount: r.accountCount,
  purchaseCount: r.purchaseCount,
  limitPerPerson: r.limitPerPerson,
  sharedAttributes: r.sharedAttributes,
  signals: r.signals as FraudClusterRecord['signals'],
  snapshotVersion: r.snapshotVersion,
  createdAtMs: r.createdAt.getTime(),
  members: members.map(memberOf),
});

const caseValues = (c: FraudCaseRecord) => ({
  id: c.caseId,
  eventId: c.eventId,
  clusterId: c.clusterId,
  status: c.status,
  reasonCategory: c.reasonCategory,
  assigneeId: c.assigneeId,
  appealDueAt: date(c.appealDueAtMs),
  cancelDeadlineAt: new Date(c.cancelDeadlineAtMs),
  approvalId: c.approvalId,
  investigatorOpinion: c.investigatorOpinion,
  outcomeLabel: c.outcomeLabel,
  version: c.version,
  createdAt: new Date(c.createdAtMs),
  closedAt: date(c.closedAtMs),
});

const memberValues = (clusterId: string, m: FraudClusterMemberRecord) => ({
  clusterId,
  accountId: m.accountId,
  signals: m.signals,
  ticketCount: m.ticketCount,
  addedBy: m.addedBy,
  removedAt: date(m.removedAtMs),
  appealReasonCategories: m.appealReasonCategories ?? null,
  appealRequestedAt: date(m.appealRequestedAtMs ?? null),
  appealDueAt: date(m.appealDueAtMs),
  lockExpiresAt: date(m.lockExpiresAtMs),
  appealResult: m.appealResult,
  objectionResult: m.objectionResult ?? 'NONE',
  objectionReceivedAt: date(m.objectionReceivedAtMs ?? null),
  objectionDecisionReason: m.objectionDecisionReason ?? null,
  objectionDecidedAt: date(m.objectionDecidedAtMs ?? null),
});

const eventValues = (caseId: string, e: FraudCaseRecord['events'][number]) => ({
  caseId,
  seq: e.seq,
  kind: e.kind,
  actorId: e.actorId,
  note: e.note,
  detail: e.detail,
  occurredAt: new Date(e.occurredAtMs),
});

const caseOf = (r: CaseRow, members: readonly MemberRow[], events: readonly (typeof fraudCaseEvent.$inferSelect)[]): FraudCaseRecord => ({
  caseId: r.id,
  eventId: r.eventId,
  clusterId: r.clusterId,
  status: r.status as FraudCaseRecord['status'],
  reasonCategory: r.reasonCategory as FraudCaseRecord['reasonCategory'],
  assigneeId: r.assigneeId,
  cancelDeadlineAtMs: r.cancelDeadlineAt.getTime(),
  appealDueAtMs: ms(r.appealDueAt),
  approvalId: r.approvalId,
  investigatorOpinion: r.investigatorOpinion,
  outcomeLabel: r.outcomeLabel as FraudCaseRecord['outcomeLabel'],
  version: Number(r.version),
  createdAtMs: r.createdAt.getTime(),
  closedAtMs: ms(r.closedAt),
  members: members.map(memberOf),
  events: events.map((e) => ({
    seq: e.seq,
    kind: e.kind,
    actorId: e.actorId,
    note: e.note,
    detail: e.detail ?? null,
    occurredAtMs: e.occurredAt.getTime(),
  })),
});
