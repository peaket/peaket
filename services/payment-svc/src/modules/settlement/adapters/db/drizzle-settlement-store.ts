// 정산·지급·KYC Drizzle 저장소(docs/data.md settlement_statement…payout).
// 정산서 상태 전이는 조건부 갱신(지금 상태가 출발 상태일 때만)이고, 상태·감사·딸린 행·trade.settlements Outbox를 한 트랜잭션에 쓴다(ADR-0368 결정 2·3).
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { type Clock, type Database, type DbTransaction, systemClock, writeOutbox } from '@peaket/platform';
import type { AdjustmentInsertResult, GuaranteeCollectionAtomicInput, PayoutBatchAtomicInput, StatementFilter, StatementNotification, StatementPage, SettlementStore, StatementTransition } from '../../domain/ports.js';
import type { AdjustmentRecord } from '../../domain/adjustment.js';
import {
  SettlementProblem,
  TRADE_SETTLEMENTS_TOPIC,
  type DisputeRecord,
  type GuaranteeCollectionRecord,
  type KycRecord,
  type PayoutAccountRecord,
  type PayoutBatchAuditRecord,
  type PayoutBatchRecord,
  type PayoutRecord,
  type Pg,
  type PgStore,
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type SettlementEventValue,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementSource,
} from '../../domain/settlement.js';
import {
  guaranteeCollection,
  partnerReceivable,
  payout,
  payoutAccount,
  payoutBatch,
  payoutBatchAudit,
  sellerKyc,
  settlementStatement,
  settlementStatementAudit,
  settlementWebhookReceipt,
  statementAdjustment,
  statementDispute,
  statementSource,
} from './schema.js';
// 표 이름 바꾸기 확장 단계라 옛 이름(뷰)으로 읽고 쓴다(receivable-move-compat.ts 머리 주석)
import { receivableMoveCompat } from './receivable-move-compat.js';

/** 조건이 맞지 않은 전이를 트랜잭션 밖으로 알리는 표시(롤백한 뒤 false로 바꾼다) */
class TransitionRejected extends Error {
  constructor() {
    super('정산서 전이 조건이 맞지 않는다');
    this.name = 'TransitionRejected';
  }
}

/** trade.settlements 값(asyncapi SettlementEvent). BAS-030 전까지 JSON 대역이다(trade.payments와 같은 방식) */
const settlementOutbox = (events: readonly SettlementEventValue[]) => events.map((e) => ({ topic: TRADE_SETTLEMENTS_TOPIC, key: e.promoterId, payload: Buffer.from(JSON.stringify(e), 'utf8') }));

const auditValues = (r: StatementAuditRecord) => ({ id: r.auditId, statementId: r.statementId, fromStatus: r.fromStatus, toStatus: r.toStatus, reason: r.reason, actor: r.actor, createdAt: r.createdAt });

const adjustmentRecord = (r: typeof statementAdjustment.$inferSelect): AdjustmentRecord => ({
  adjustmentId: r.id,
  statementId: r.statementId,
  approvalId: r.approvalId,
  reasonCode: r.reasonCode as AdjustmentRecord['reasonCode'],
  disputeId: r.disputeId,
  amount: r.amount,
  evidenceNote: r.evidenceNote,
  status: r.status as AdjustmentRecord['status'],
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  appliedAt: r.appliedAt,
});

const receivableRecord = (r: typeof partnerReceivable.$inferSelect): ReceivableRecord => ({
  receivableId: r.id,
  promoterId: r.promoterId,
  pg: r.pg as Pg | null,
  cause: r.cause as ReceivableRecord['cause'],
  eventId: r.eventId,
  sourceRef: r.sourceRef,
  amount: r.amount,
  remaining: r.remaining,
  status: r.status as ReceivableRecord['status'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const statementRecord = (r: typeof settlementStatement.$inferSelect): StatementRecord => ({
  statementId: r.id,
  promoterId: r.promoterId,
  kind: r.kind as StatementRecord['kind'],
  eventId: r.eventId,
  pg: r.pg as Pg,
  pgStore: r.pgStore as PgStore,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  grossAmount: r.grossAmount,
  refundAmount: r.refundAmount,
  commissionAmount: r.commissionAmount,
  commissionVat: r.commissionVat,
  offsetAmount: r.offsetAmount,
  payoutAmount: r.payoutAmount,
  revision: r.revision,
  supersedesId: r.supersedesId,
  excludedPayments: r.excludedPayments ?? [],
  status: r.status as StatementRecord['status'],
  holdReason: r.holdReason as StatementRecord['holdReason'],
  disputeDueAt: r.disputeDueAt,
  payoutDate: r.payoutDate,
  payoutBankCode: r.payoutBankCode,
  payoutAccountLast4: r.payoutAccountLast4,
  payoutBatchId: r.payoutBatchId,
  adjustmentAmount: r.adjustmentAmount,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const disputeRecord = (r: typeof statementDispute.$inferSelect): DisputeRecord => ({
  disputeId: r.id,
  statementId: r.statementId,
  reasonCode: r.reasonCode as DisputeRecord['reasonCode'],
  detail: r.detail,
  submittedBy: r.submittedBy,
  submittedAt: r.submittedAt,
  result: r.result as DisputeRecord['result'],
  resolvedAt: r.resolvedAt,
  resolvedBy: r.resolvedBy,
  resolutionNote: r.resolutionNote,
  caseRequestedAt: r.caseRequestedAt,
});

const batchRecord = (r: typeof payoutBatch.$inferSelect): PayoutBatchRecord => ({
  batchId: r.id,
  pg: r.pg as Pg,
  pgStore: r.pgStore as PgStore,
  payoutDate: r.payoutDate,
  totalAmount: r.totalAmount,
  statementCount: r.statementCount,
  approvalId: r.approvalId,
  portoneBulkPayoutId: r.portoneBulkPayoutId,
  pgBalanceKrw: r.pgBalanceKrw,
  pgBalanceSource: r.pgBalanceSource as PayoutBatchRecord['pgBalanceSource'],
  pgBalanceObservedAt: r.pgBalanceObservedAt,
  pgBalanceObservedBy: r.pgBalanceObservedBy,
  pgBalanceLedgerKrw: r.pgBalanceLedgerKrw,
  status: r.status as PayoutBatchRecord['status'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const payoutRecord = (r: typeof payout.$inferSelect): PayoutRecord => ({
  payoutId: r.id,
  batchId: r.batchId,
  statementId: r.statementId,
  seq: r.seq,
  amount: r.amount,
  refPayoutId: r.refPayoutId,
  pgPayoutId: r.pgPayoutId,
  status: r.status as PayoutRecord['status'],
  errorCode: r.errorCode,
  pgTransferId: r.pgTransferId,
  transferCheck: r.transferCheck as PayoutRecord['transferCheck'],
  transferCheckedAt: r.transferCheckedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const uniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === '23505';
};

const encodeCursor = (s: StatementRecord): string => Buffer.from(`${s.createdAt.getTime()}:${s.statementId}`).toString('base64url');
const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const n = Number(at);
    return Number.isSafeInteger(n) && id ? { at: n, id } : undefined;
  } catch {
    return undefined;
  }
};

export class DrizzleSettlementStore implements SettlementStore {
  constructor(
    private readonly db: Database,
    /** Outbox 행 ID(UUIDv7)의 시계 */
    private readonly clock: Clock = systemClock,
  ) {}

  async insertStatement(record: StatementRecord, sources: readonly StatementSource[], notify?: StatementNotification): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(settlementStatement)
        .values({
          id: record.statementId,
          promoterId: record.promoterId,
          kind: record.kind,
          eventId: record.eventId,
          pg: record.pg,
          pgStore: record.pgStore,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          grossAmount: record.grossAmount,
          refundAmount: record.refundAmount,
          commissionAmount: record.commissionAmount,
          commissionVat: record.commissionVat,
          offsetAmount: record.offsetAmount,
          payoutAmount: record.payoutAmount,
          revision: record.revision,
          supersedesId: record.supersedesId,
          excludedPayments: record.excludedPayments,
          status: record.status,
          holdReason: record.holdReason,
          disputeDueAt: record.disputeDueAt,
          payoutDate: record.payoutDate,
          payoutBankCode: record.payoutBankCode,
          payoutAccountLast4: record.payoutAccountLast4,
          payoutBatchId: record.payoutBatchId,
          adjustmentAmount: record.adjustmentAmount ?? 0,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .onConflictDoNothing()
        .returning({ id: settlementStatement.id });
      if (inserted.length === 0) return false;
      if (sources.length > 0)
        await tx.insert(statementSource).values(sources.map((s) => ({ statementId: s.statementId, sourceId: s.sourceId, kind: s.kind, paymentId: s.paymentId, amount: s.amount })));
      if (notify) {
        // 계산 = 통지(ADR-0368 결정 1): 같은 트랜잭션에서 CALCULATED → NOTIFIED, 감사 한 줄, 사건은 마지막 문장
        const notified = await tx
          .update(settlementStatement)
          .set({ status: 'NOTIFIED', disputeDueAt: notify.disputeDueAt, updatedAt: notify.audit.createdAt })
          .where(and(eq(settlementStatement.id, record.statementId), eq(settlementStatement.status, 'CALCULATED')))
          .returning({ id: settlementStatement.id });
        if (notified.length === 0) throw new Error('계산한 정산서를 통지 상태로 바꾸지 못했다');
        await tx.insert(settlementStatementAudit).values(auditValues(notify.audit));
        await writeOutbox(tx, this.clock, settlementOutbox([notify.event]));
      }
      return true;
    });
  }

  async transitionStatement(t: StatementTransition): Promise<boolean> {
    return this.transitionStatements([t]);
  }

  async transitionStatements(ts: readonly StatementTransition[]): Promise<boolean> {
    if (ts.length === 0) return true;
    try {
      await this.db.transaction(async (tx) => {
        const events: SettlementEventValue[] = [];
        for (const t of ts) events.push(...(await this.#transitionIn(tx, t)));
        // 사건은 트랜잭션의 마지막 문장(ADR-0116 결정 3)
        await writeOutbox(tx, this.clock, settlementOutbox(events));
      });
      return true;
    } catch (e) {
      if (e instanceof TransitionRejected) return false;
      throw e;
    }
  }

  /** 전이 한 건을 열린 트랜잭션에 쓰고 Outbox에 쓸 사건을 돌려준다. 조건이 맞지 않으면 TransitionRejected로 롤백한다 */
  async #transitionIn(tx: DbTransaction, t: StatementTransition): Promise<SettlementEventValue[]> {
    const conditions = [eq(settlementStatement.id, t.statementId), inArray(settlementStatement.status, [...t.from])];
    if (t.expect?.disputeDueAfter) conditions.push(gt(settlementStatement.disputeDueAt, t.expect.disputeDueAfter));
    if (t.expect?.disputeDueAtOrBefore) conditions.push(lte(settlementStatement.disputeDueAt, t.expect.disputeDueAtOrBefore));
    if (t.expect?.adjustmentAmount !== undefined) conditions.push(eq(settlementStatement.adjustmentAmount, t.expect.adjustmentAmount));
    if (t.expect?.offsetAmount !== undefined) conditions.push(eq(settlementStatement.offsetAmount, t.expect.offsetAmount));
    if (t.expect?.unbatched) conditions.push(isNull(settlementStatement.payoutBatchId));
    const set: Partial<typeof settlementStatement.$inferInsert> = { status: t.to, updatedAt: t.updatedAt };
    if (t.set?.holdReason !== undefined) set.holdReason = t.set.holdReason;
    if (t.set?.disputeDueAt !== undefined) set.disputeDueAt = t.set.disputeDueAt;
    if (t.set?.adjustmentAmount !== undefined) set.adjustmentAmount = t.set.adjustmentAmount;
    if (t.set?.payoutAmount !== undefined) set.payoutAmount = t.set.payoutAmount;
    if (t.set?.offsetAmount !== undefined) set.offsetAmount = t.set.offsetAmount;
    // 조건부 갱신이 정산서 행을 잠근다. 0행이면 다른 전이가 먼저 썼다
    const updated = await tx.update(settlementStatement).set(set).where(and(...conditions)).returning({ id: settlementStatement.id });
    if (updated.length === 0) throw new TransitionRejected();
    if (t.insertDispute) {
      const d = t.insertDispute;
      await tx.insert(statementDispute).values({ id: d.disputeId, statementId: d.statementId, reasonCode: d.reasonCode, detail: d.detail, submittedBy: d.submittedBy, submittedAt: d.submittedAt, result: null, resolvedAt: null });
    }
    if (t.resolveDispute) {
      const r = t.resolveDispute;
      const closed = await tx
        .update(statementDispute)
        .set({ result: r.result, resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote })
        .where(and(eq(statementDispute.id, r.disputeId), eq(statementDispute.statementId, t.statementId), isNull(statementDispute.result)))
        .returning({ id: statementDispute.id });
      if (closed.length === 0) throw new TransitionRejected();
    }
    if (t.applyAdjustment) {
      const a = t.applyAdjustment;
      const applied = await tx
        .update(statementAdjustment)
        .set({ status: 'APPLIED', appliedAt: a.appliedAt })
        .where(and(eq(statementAdjustment.approvalId, a.approvalId), eq(statementAdjustment.statementId, t.statementId), eq(statementAdjustment.status, 'PENDING')))
        .returning({ id: statementAdjustment.id });
      if (applied.length === 0) throw new TransitionRejected();
    }
    let receivableOpened = true;
    if (t.insertReceivable) {
      const r = t.insertReceivable;
      const rows = await tx
        .insert(partnerReceivable)
        .values({ id: r.receivableId, promoterId: r.promoterId, pg: r.pg, cause: r.cause, eventId: r.eventId ?? null, sourceRef: r.sourceRef ?? null, amount: r.amount, remaining: r.remaining, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt })
        // 같은 근거(negative-statement:{정산서 ID})의 미수금은 한 행이다(0024 부분 유일)
        .onConflictDoNothing()
        .returning({ id: partnerReceivable.id });
      receivableOpened = rows.length > 0;
    }
    if (t.audits.length > 0) await tx.insert(settlementStatementAudit).values(t.audits.map(auditValues));
    return t.events.filter((e) => receivableOpened || e.type !== 'RECEIVABLE_OPENED');
  }

  async findStatement(promoterId: string, statementId: string): Promise<StatementRecord | undefined> {
    const rows = await this.db.db.select().from(settlementStatement).where(and(eq(settlementStatement.id, statementId), eq(settlementStatement.promoterId, promoterId))).limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async findStatementById(statementId: string): Promise<StatementRecord | undefined> {
    const rows = await this.db.db.select().from(settlementStatement).where(eq(settlementStatement.id, statementId)).limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async findEventStatement(promoterId: string, eventId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord | undefined> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.promoterId, promoterId),
          eq(settlementStatement.kind, 'EVENT'),
          eq(settlementStatement.eventId, eventId),
          eq(settlementStatement.pg, pg),
          eq(settlementStatement.pgStore, pgStore),
          sql`${settlementStatement.status} <> 'SUPERSEDED'`,
        ),
      )
      .limit(1);
    return rows[0] ? statementRecord(rows[0]) : undefined;
  }

  async listEvent(promoterId: string, eventId: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.eventId, eventId), eq(settlementStatement.kind, 'EVENT')))
      .orderBy(desc(settlementStatement.createdAt));
    return rows.map(statementRecord);
  }

  async listProduct(promoterId: string, filter: StatementFilter): Promise<StatementPage> {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const conditions = [eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.kind, 'PRODUCT')];
    if (filter.from) conditions.push(gte(settlementStatement.periodStart, filter.from));
    if (filter.to) conditions.push(lte(settlementStatement.periodEnd, filter.to));
    if (filter.pgStore) conditions.push(eq(settlementStatement.pgStore, filter.pgStore));
    if (cursor) conditions.push(or(lt(settlementStatement.createdAt, new Date(cursor.at)), and(eq(settlementStatement.createdAt, new Date(cursor.at)), lt(settlementStatement.id, cursor.id)))!);
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(...conditions))
      .orderBy(desc(settlementStatement.createdAt), desc(settlementStatement.id))
      .limit(filter.limit + 1);
    const items = rows.slice(0, filter.limit).map(statementRecord);
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async saveStatement(record: StatementRecord): Promise<void> {
    await this.db.db
      .update(settlementStatement)
      .set({
        status: record.status,
        holdReason: record.holdReason,
        disputeDueAt: record.disputeDueAt,
        offsetAmount: record.offsetAmount,
        payoutAmount: record.payoutAmount,
        payoutDate: record.payoutDate,
        payoutBankCode: record.payoutBankCode,
        payoutAccountLast4: record.payoutAccountLast4,
        payoutBatchId: record.payoutBatchId,
        ...(record.adjustmentAmount !== undefined ? { adjustmentAmount: record.adjustmentAmount } : {}),
        updatedAt: record.updatedAt,
      })
      .where(eq(settlementStatement.id, record.statementId));
  }

  async hasEventStatementOfOther(promoterId: string, eventId: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: settlementStatement.id })
      .from(settlementStatement)
      .where(and(eq(settlementStatement.eventId, eventId), eq(settlementStatement.kind, 'EVENT'), ne(settlementStatement.promoterId, promoterId)))
      .limit(1);
    return rows.length > 0;
  }

  async listDisputes(statementId: string): Promise<DisputeRecord[]> {
    const rows = await this.db.db.select().from(statementDispute).where(eq(statementDispute.statementId, statementId)).orderBy(desc(statementDispute.submittedAt));
    return rows.map(disputeRecord);
  }

  async listDisputesAwaitingCase(limit: number): Promise<DisputeRecord[]> {
    const rows = await this.db.db
      .select()
      .from(statementDispute)
      .where(and(isNull(statementDispute.caseRequestedAt), isNull(statementDispute.result)))
      .orderBy(statementDispute.submittedAt, statementDispute.id)
      .limit(limit);
    return rows.map(disputeRecord);
  }

  async markDisputeCaseRequested(disputeId: string, at: Date): Promise<void> {
    await this.db.db.update(statementDispute).set({ caseRequestedAt: at }).where(and(eq(statementDispute.id, disputeId), isNull(statementDispute.caseRequestedAt)));
  }

  async insertAdjustment(record: AdjustmentRecord): Promise<AdjustmentInsertResult> {
    const existing = await this.findAdjustmentByApproval(record.approvalId);
    if (existing) return { record: existing, created: false };
    try {
      await this.db.db.insert(statementAdjustment).values({
        id: record.adjustmentId,
        statementId: record.statementId,
        approvalId: record.approvalId,
        reasonCode: record.reasonCode,
        disputeId: record.disputeId,
        amount: record.amount,
        evidenceNote: record.evidenceNote,
        status: record.status,
        requestedBy: record.requestedBy,
        requestedAt: record.requestedAt,
        appliedAt: record.appliedAt,
      });
      return { record, created: true };
    } catch (e) {
      if (!uniqueViolation(e)) throw e;
      // 같은 승인 ID가 먼저 들어갔으면 그 행, 아니면 그 정산서의 적용 전 조정(부분 유일)에 걸렸다
      const raced = await this.findAdjustmentByApproval(record.approvalId);
      return raced ? { record: raced, created: false } : 'pending';
    }
  }

  async findAdjustmentByApproval(approvalId: string): Promise<AdjustmentRecord | undefined> {
    const rows = await this.db.db.select().from(statementAdjustment).where(eq(statementAdjustment.approvalId, approvalId)).limit(1);
    return rows[0] ? adjustmentRecord(rows[0]) : undefined;
  }

  async voidAdjustment(approvalId: string, _at: Date): Promise<boolean> {
    const rows = await this.db.db
      .update(statementAdjustment)
      .set({ status: 'VOID' })
      .where(and(eq(statementAdjustment.approvalId, approvalId), eq(statementAdjustment.status, 'PENDING')))
      .returning({ id: statementAdjustment.id });
    return rows.length > 0;
  }

  async voidStalePendingAdjustments(before: Date, limit: number): Promise<number> {
    const stale = await this.db.db
      .select({ id: statementAdjustment.id })
      .from(statementAdjustment)
      .where(and(eq(statementAdjustment.status, 'PENDING'), lt(statementAdjustment.requestedAt, before)))
      .orderBy(statementAdjustment.requestedAt)
      .limit(limit);
    if (stale.length === 0) return 0;
    const rows = await this.db.db
      .update(statementAdjustment)
      .set({ status: 'VOID' })
      .where(and(inArray(statementAdjustment.id, stale.map((r) => r.id)), eq(statementAdjustment.status, 'PENDING')))
      .returning({ id: statementAdjustment.id });
    return rows.length;
  }

  async insertPayoutBatch(record: PayoutBatchRecord): Promise<void> {
    await this.db.db.insert(payoutBatch).values({
      id: record.batchId,
      pg: record.pg,
      pgStore: record.pgStore,
      payoutDate: record.payoutDate,
      totalAmount: record.totalAmount,
      statementCount: record.statementCount,
      approvalId: record.approvalId,
      portoneBulkPayoutId: record.portoneBulkPayoutId,
      pgBalanceKrw: record.pgBalanceKrw,
      pgBalanceSource: record.pgBalanceSource,
      pgBalanceObservedAt: record.pgBalanceObservedAt,
      pgBalanceObservedBy: record.pgBalanceObservedBy,
      pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(payoutBatch).values({
          id: record.batchId,
          pg: record.pg,
          pgStore: record.pgStore,
          payoutDate: record.payoutDate,
          totalAmount: record.totalAmount,
          statementCount: record.statementCount,
          approvalId: record.approvalId,
          portoneBulkPayoutId: record.portoneBulkPayoutId,
          pgBalanceKrw: record.pgBalanceKrw,
          pgBalanceSource: record.pgBalanceSource,
          pgBalanceObservedAt: record.pgBalanceObservedAt,
          pgBalanceObservedBy: record.pgBalanceObservedBy,
          pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
        if (statementIds.length > 0) {
          const updated = await tx
            .update(settlementStatement)
            .set({ payoutBatchId: record.batchId, status: 'SCHEDULED', updatedAt: record.updatedAt })
            .where(and(inArray(settlementStatement.id, [...statementIds]), eq(settlementStatement.status, 'CONFIRMED'), isNull(settlementStatement.payoutBatchId)))
            .returning({ id: settlementStatement.id });
          if (updated.length !== statementIds.length) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
        }
      });
    } catch (e) {
      if (e instanceof SettlementProblem) throw e;
      if (uniqueViolation(e)) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
      throw e;
    }
  }

  async createPayoutBatchAtomically(input: PayoutBatchAtomicInput): Promise<void> {
    const { batch: record } = input;
    try {
      await this.db.transaction(async (tx) => {
        const events: SettlementEventValue[] = [];
        for (const u of input.statementUpdates) {
          // 보류·상계는 출발 상태(기본 CONFIRMED)이고 묶음에 붙지 않은 정산서만 바꾼다. 조정 적용 등 다른 전이가 먼저 썼으면 묶음 전체를 롤백한다(ADR-0368 결정 2, J-T36 ⑥)
          const changed = await tx
            .update(settlementStatement)
            .set({ status: u.status, holdReason: u.holdReason, offsetAmount: u.offsetAmount, payoutAmount: u.payoutAmount, updatedAt: u.updatedAt })
            .where(and(eq(settlementStatement.id, u.statementId), inArray(settlementStatement.status, [...(u.from ?? ['CONFIRMED'])]), isNull(settlementStatement.payoutBatchId)))
            .returning({ id: settlementStatement.id });
          if (changed.length === 0) throw new SettlementProblem('payout-batch-statement-conflict', 409, '정산서 상태가 다른 처리와 겹쳤습니다');
          if (u.audits && u.audits.length > 0) await tx.insert(settlementStatementAudit).values(u.audits.map(auditValues));
          if (u.events) events.push(...u.events);
        }
        for (const u of input.receivableUpdates) {
          const moved = input.receivableMoves.filter((m) => m.receivableId === u.receivableId).reduce((sum, m) => sum + m.amount, 0);
          const locked = await tx.execute(sql`select remaining from partner_receivable where id = ${u.receivableId}::uuid for update`);
          const current = Number((locked.rows[0] as { remaining: number | string } | undefined)?.remaining);
          if (!Number.isSafeInteger(current) || current !== u.remaining + moved) throw new SettlementProblem('payout-batch-statement-conflict', 409, '미수금 잔액이 다른 지급 묶음과 겹쳤습니다');
          await tx.update(partnerReceivable).set({ remaining: u.remaining, status: u.status, updatedAt: u.updatedAt }).where(eq(partnerReceivable.id, u.receivableId));
        }
        if (input.receivableMoves.length > 0) {
          await tx.insert(receivableMoveCompat).values(
            input.receivableMoves.map((m) => ({
              ...(m.moveId ? { id: m.moveId } : {}),
              receivableId: m.receivableId,
              statementId: m.statementId,
              amount: m.amount,
              kind: m.kind ?? 'OFFSET',
              movedAt: m.movedAt,
            })),
          );
        }
        await tx.insert(payoutBatch).values({
          id: record.batchId,
          pg: record.pg,
          pgStore: record.pgStore,
          payoutDate: record.payoutDate,
          totalAmount: record.totalAmount,
          statementCount: record.statementCount,
          approvalId: record.approvalId,
          portoneBulkPayoutId: record.portoneBulkPayoutId,
          pgBalanceKrw: record.pgBalanceKrw,
          pgBalanceSource: record.pgBalanceSource,
          pgBalanceObservedAt: record.pgBalanceObservedAt,
          pgBalanceObservedBy: record.pgBalanceObservedBy,
          pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
        if (input.statementIds.length > 0) {
          const updated = await tx
            .update(settlementStatement)
            .set({ payoutBatchId: record.batchId, status: 'SCHEDULED', updatedAt: record.updatedAt })
            .where(and(inArray(settlementStatement.id, [...input.statementIds]), eq(settlementStatement.status, 'CONFIRMED'), isNull(settlementStatement.payoutBatchId)))
            .returning({ id: settlementStatement.id });
          if (updated.length !== input.statementIds.length) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
        }
        await writeOutbox(tx, this.clock, settlementOutbox(events));
      });
    } catch (e) {
      if (e instanceof SettlementProblem) throw e;
      if (uniqueViolation(e)) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
      throw e;
    }
  }

  async releasePayoutBatch(batchId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select({ status: payoutBatch.status }).from(payoutBatch).where(eq(payoutBatch.id, batchId)).limit(1);
      const status = rows[0]?.status;
      if (status !== 'PENDING_APPROVAL' && status !== 'APPROVED') return false;
      const payouts = await tx.select({ id: payout.id }).from(payout).where(eq(payout.batchId, batchId)).limit(1);
      if (payouts.length > 0) return false;
      await tx.update(settlementStatement).set({ payoutBatchId: null, status: 'CONFIRMED' }).where(and(eq(settlementStatement.payoutBatchId, batchId), eq(settlementStatement.status, 'SCHEDULED')));
      await tx.delete(payoutBatch).where(eq(payoutBatch.id, batchId));
      return true;
    });
  }

  async approvePayoutBatchAtomically(batch: PayoutBatchRecord, audit: PayoutBatchAuditRecord): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(payoutBatch)
          .set({ status: batch.status, approvalId: batch.approvalId, updatedAt: batch.updatedAt })
          .where(and(eq(payoutBatch.id, batch.batchId), eq(payoutBatch.status, 'PENDING_APPROVAL'), isNull(payoutBatch.approvalId)))
          .returning({ id: payoutBatch.id });
        if (updated.length === 0) return false;
        await tx.insert(payoutBatchAudit).values({
          id: audit.auditId,
          batchId: audit.batchId,
          approvalId: audit.approvalId,
          event: audit.event,
          reason: audit.reason,
          requesterId: audit.requesterId,
          approverId: audit.approverId,
          amount: audit.amount,
          currency: audit.currency,
          createdAt: audit.createdAt,
        });
        return true;
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new SettlementProblem('payout-approval-reused', 409, '다른 지급 묶음이 이미 쓴 승인 업무입니다');
      throw e;
    }
  }

  async insertPayoutBatchAudit(audit: PayoutBatchAuditRecord): Promise<void> {
    await this.db.db.insert(payoutBatchAudit).values({
      id: audit.auditId,
      batchId: audit.batchId,
      approvalId: audit.approvalId,
      event: audit.event,
      reason: audit.reason,
      requesterId: audit.requesterId,
      approverId: audit.approverId,
      amount: audit.amount,
      currency: audit.currency,
      createdAt: audit.createdAt,
    });
  }

  async findPayoutBatch(batchId: string): Promise<PayoutBatchRecord | undefined> {
    const rows = await this.db.db.select().from(payoutBatch).where(eq(payoutBatch.id, batchId)).limit(1);
    return rows[0] ? batchRecord(rows[0]) : undefined;
  }

  async listPayoutBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchRecord[]> {
    const conditions = [];
    if (filter.pg) conditions.push(eq(payoutBatch.pg, filter.pg));
    if (filter.pgStore) conditions.push(eq(payoutBatch.pgStore, filter.pgStore));
    if (filter.payoutDate) conditions.push(eq(payoutBatch.payoutDate, filter.payoutDate));
    if (filter.status && filter.status.length > 0) conditions.push(inArray(payoutBatch.status, [...filter.status]));
    const rows = await this.db.db
      .select()
      .from(payoutBatch)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(payoutBatch.payoutDate), desc(payoutBatch.createdAt))
      .limit(filter.limit);
    return rows.map(batchRecord);
  }

  async savePayoutBatch(record: PayoutBatchRecord): Promise<void> {
    await this.db.db
      .update(payoutBatch)
      .set({
        status: record.status,
        approvalId: record.approvalId,
        portoneBulkPayoutId: record.portoneBulkPayoutId,
        pgBalanceKrw: record.pgBalanceKrw,
        pgBalanceSource: record.pgBalanceSource,
        pgBalanceObservedAt: record.pgBalanceObservedAt,
        pgBalanceObservedBy: record.pgBalanceObservedBy,
        pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
        updatedAt: record.updatedAt,
      })
      .where(eq(payoutBatch.id, record.batchId));
  }

  async listConfirmed(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.status, 'CONFIRMED'),
          eq(settlementStatement.pg, pg),
          eq(settlementStatement.pgStore, pgStore),
          eq(settlementStatement.payoutDate, payoutDate),
          isNull(settlementStatement.payoutBatchId),
          // 지급액 0 이하는 확정 때 CARRIED_OVER로 끝나므로 묶음에 담지 않는다(ADR-0368 결정 10)
          gt(settlementStatement.payoutAmount, 0),
        ),
      )
      .orderBy(settlementStatement.promoterId, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async listStatementsByBatch(batchId: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(eq(settlementStatement.payoutBatchId, batchId))
      .orderBy(settlementStatement.promoterId, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async listDueConfirmation(now: Date, limit: number): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.status, 'NOTIFIED'), lte(settlementStatement.disputeDueAt, now)))
      .orderBy(settlementStatement.disputeDueAt, settlementStatement.id)
      .limit(limit);
    return rows.map(statementRecord);
  }

  async insertPayouts(records: readonly PayoutRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.db.insert(payout).values(
      records.map((r) => ({
        id: r.payoutId,
        batchId: r.batchId,
        statementId: r.statementId,
        seq: r.seq,
        amount: r.amount,
        refPayoutId: r.refPayoutId,
        pgPayoutId: r.pgPayoutId,
        status: r.status,
        errorCode: r.errorCode,
        pgTransferId: r.pgTransferId,
        transferCheck: r.transferCheck,
        transferCheckedAt: r.transferCheckedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  }

  async listPayouts(batchId: string): Promise<PayoutRecord[]> {
    const rows = await this.db.db.select().from(payout).where(eq(payout.batchId, batchId)).orderBy(payout.seq);
    return rows.map(payoutRecord);
  }

  async findPayout(payoutId: string): Promise<PayoutRecord | undefined> {
    const rows = await this.db.db.select().from(payout).where(eq(payout.id, payoutId)).limit(1);
    return rows[0] ? payoutRecord(rows[0]) : undefined;
  }

  async findPayoutByPgPayoutId(pgPayoutId: string): Promise<PayoutRecord | undefined> {
    const rows = await this.db.db.select().from(payout).where(eq(payout.pgPayoutId, pgPayoutId)).limit(1);
    return rows[0] ? payoutRecord(rows[0]) : undefined;
  }

  async savePayout(record: PayoutRecord): Promise<void> {
    await this.db.db
      .update(payout)
      .set({
        pgPayoutId: record.pgPayoutId,
        status: record.status,
        errorCode: record.errorCode,
        pgTransferId: record.pgTransferId,
        transferCheck: record.transferCheck,
        transferCheckedAt: record.transferCheckedAt,
        updatedAt: record.updatedAt,
      })
      .where(eq(payout.id, record.payoutId));
  }

  async findKyc(promoterId: string): Promise<KycRecord | undefined> {
    const rows = await this.db.db.select().from(sellerKyc).where(eq(sellerKyc.promoterId, promoterId)).limit(1);
    const r = rows[0];
    return r
      ? {
          promoterId: r.promoterId,
          status: r.status as KycRecord['status'],
          businessVerified: r.businessVerified,
          representativeVerified: r.representativeVerified,
          legalName: r.legalName,
          representative: r.representative,
          verifiedAt: r.verifiedAt,
          source: r.source,
          updatedAt: r.updatedAt,
          tossSellerId: r.tossSellerId,
          tossSellerStatus: r.tossSellerStatus as KycRecord['tossSellerStatus'],
        }
      : undefined;
  }

  async findKycByTossSellerId(tossSellerId: string): Promise<KycRecord | undefined> {
    const rows = await this.db.db.select().from(sellerKyc).where(eq(sellerKyc.tossSellerId, tossSellerId)).limit(1);
    const r = rows[0];
    return r
      ? {
          promoterId: r.promoterId,
          status: r.status as KycRecord['status'],
          businessVerified: r.businessVerified,
          representativeVerified: r.representativeVerified,
          legalName: r.legalName,
          representative: r.representative,
          verifiedAt: r.verifiedAt,
          source: r.source,
          updatedAt: r.updatedAt,
          tossSellerId: r.tossSellerId,
          tossSellerStatus: r.tossSellerStatus as KycRecord['tossSellerStatus'],
        }
      : undefined;
  }

  async saveKyc(record: KycRecord): Promise<void> {
    await this.db.db
      .insert(sellerKyc)
      .values({
        promoterId: record.promoterId,
        status: record.status,
        businessVerified: record.businessVerified,
        representativeVerified: record.representativeVerified,
        legalName: record.legalName ?? null,
        representative: record.representative ?? null,
        verifiedAt: record.verifiedAt,
        source: record.source,
        tossSellerId: record.tossSellerId ?? null,
        tossSellerStatus: record.tossSellerStatus ?? 'PENDING',
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: sellerKyc.promoterId,
        set: {
          status: record.status,
          businessVerified: record.businessVerified,
          representativeVerified: record.representativeVerified,
          legalName: record.legalName ?? null,
          representative: record.representative ?? null,
          verifiedAt: record.verifiedAt,
          source: record.source,
          tossSellerId: record.tossSellerId ?? null,
          tossSellerStatus: record.tossSellerStatus ?? 'PENDING',
          updatedAt: record.updatedAt,
        },
      });
  }

  async findPayoutAccount(promoterId: string): Promise<PayoutAccountRecord | undefined> {
    const rows = await this.db.db.select().from(payoutAccount).where(eq(payoutAccount.promoterId, promoterId)).limit(1);
    const r = rows[0];
    return r
      ? {
          promoterId: r.promoterId,
          bankCode: r.bankCode,
          accountLast4: r.accountLast4,
          version: r.version,
          changedAt: r.changedAt,
          holdUntil: r.holdUntil,
          holderVerified: r.holderVerified,
        }
      : undefined;
  }

  async savePayoutAccount(record: PayoutAccountRecord): Promise<void> {
    await this.db.db
      .insert(payoutAccount)
      .values({
        promoterId: record.promoterId,
        bankCode: record.bankCode,
        accountLast4: record.accountLast4,
        version: record.version,
        changedAt: record.changedAt,
        holdUntil: record.holdUntil,
        holderVerified: record.holderVerified,
      })
      .onConflictDoUpdate({
        target: payoutAccount.promoterId,
        set: {
          bankCode: record.bankCode,
          accountLast4: record.accountLast4,
          version: record.version,
          changedAt: record.changedAt,
          holdUntil: record.holdUntil,
          holderVerified: record.holderVerified,
        },
      });
  }

  async listStatements(filter: { kind?: 'EVENT' | 'PRODUCT' | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }): Promise<StatementRecord[]> {
    const conditions = [];
    if (filter.kind) conditions.push(eq(settlementStatement.kind, filter.kind));
    if (filter.status) conditions.push(eq(settlementStatement.status, filter.status));
    if (filter.pg) conditions.push(eq(settlementStatement.pg, filter.pg));
    if (filter.pgStore) conditions.push(eq(settlementStatement.pgStore, filter.pgStore));
    if (filter.payoutDate) conditions.push(eq(settlementStatement.payoutDate, filter.payoutDate));
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(settlementStatement.createdAt), desc(settlementStatement.id))
      .limit(filter.limit);
    return rows.map(statementRecord);
  }

  async listHeldStatements(pg: Pg, pgStore: PgStore, payoutDate: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.status, 'HELD'),
          eq(settlementStatement.pg, pg),
          eq(settlementStatement.pgStore, pgStore),
          eq(settlementStatement.payoutDate, payoutDate),
        ),
      )
      .orderBy(settlementStatement.promoterId, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async sumScheduledTossPayouts(promoterId: string, from: string, to: string): Promise<number> {
    const rows = await this.db.db
      .select({ amount: settlementStatement.payoutAmount })
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.promoterId, promoterId),
          eq(settlementStatement.pg, 'TOSS'),
          gte(settlementStatement.payoutDate, from),
          lte(settlementStatement.payoutDate, to),
          inArray(settlementStatement.status, ['NOTIFIED', 'CONFIRMED', 'SCHEDULED', 'HELD']),
        ),
      );
    return rows.reduce((sum, r) => sum + Number(r.amount), 0);
  }

  async findProductStatement(promoterId: string, pg: Pg, pgStore: PgStore, periodStart: string, periodEnd: string): Promise<StatementRecord | undefined> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.kind, 'PRODUCT'), eq(settlementStatement.pg, pg), eq(settlementStatement.pgStore, pgStore), eq(settlementStatement.periodStart, periodStart), eq(settlementStatement.periodEnd, periodEnd)))
      .limit(1);
    return rows[0] && rows[0].status !== 'SUPERSEDED' ? statementRecord(rows[0]) : undefined;
  }

  async insertReceivable(record: ReceivableRecord): Promise<void> {
    await this.db.db.insert(partnerReceivable).values({
      id: record.receivableId,
      promoterId: record.promoterId,
      pg: record.pg,
      cause: record.cause,
      eventId: record.eventId ?? null,
      sourceRef: record.sourceRef ?? null,
      amount: record.amount,
      remaining: record.remaining,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async insertReceivableIfAbsent(record: ReceivableRecord): Promise<boolean> {
    const rows = await this.db.db
      .insert(partnerReceivable)
      .values({
        id: record.receivableId,
        promoterId: record.promoterId,
        pg: record.pg,
        cause: record.cause,
        eventId: record.eventId ?? null,
        sourceRef: record.sourceRef ?? null,
        amount: record.amount,
        remaining: record.remaining,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      // source_ref 부분 유일(또는 기본 키)에 걸리면 아무것도 쓰지 않는다(0024)
      .onConflictDoNothing()
      .returning({ id: partnerReceivable.id });
    return rows.length > 0;
  }

  async findReceivableBySourceRef(sourceRef: string): Promise<ReceivableRecord | undefined> {
    const rows = await this.db.db.select().from(partnerReceivable).where(eq(partnerReceivable.sourceRef, sourceRef)).limit(1);
    return rows[0] === undefined ? undefined : receivableRecord(rows[0]);
  }

  async findReceivable(receivableId: string): Promise<ReceivableRecord | undefined> {
    const rows = await this.db.db.select().from(partnerReceivable).where(eq(partnerReceivable.id, receivableId)).limit(1);
    return rows[0] ? receivableRecord(rows[0]) : undefined;
  }

  async saveReceivable(record: ReceivableRecord): Promise<void> {
    await this.db.db
      .update(partnerReceivable)
      .set({ remaining: record.remaining, status: record.status, updatedAt: record.updatedAt })
      .where(eq(partnerReceivable.id, record.receivableId));
  }

  async listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableRecord['status'][] | undefined; limit: number }): Promise<ReceivableRecord[]> {
    const conditions = [];
    if (filter.promoterId) conditions.push(eq(partnerReceivable.promoterId, filter.promoterId));
    if (filter.pg) conditions.push(eq(partnerReceivable.pg, filter.pg));
    if (filter.status && filter.status.length > 0) conditions.push(inArray(partnerReceivable.status, [...filter.status]));
    const rows = await this.db.db
      .select()
      .from(partnerReceivable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(partnerReceivable.createdAt)
      .limit(filter.limit);
    return rows.map((r) => ({
      receivableId: r.id,
      promoterId: r.promoterId,
      pg: r.pg as Pg | null,
      cause: r.cause as ReceivableRecord['cause'],
      eventId: r.eventId,
      sourceRef: r.sourceRef,
      amount: r.amount,
      remaining: r.remaining,
      status: r.status as ReceivableRecord['status'],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async listOpenReceivables(promoterId: string, pg: Pg): Promise<ReceivableRecord[]> {
    const rows = await this.db.db
      .select()
      .from(partnerReceivable)
      .where(
        and(
          eq(partnerReceivable.promoterId, promoterId),
          eq(partnerReceivable.status, 'OPEN'),
          sql`${partnerReceivable.remaining} > 0`,
          or(eq(partnerReceivable.pg, pg), eq(partnerReceivable.cause, 'COMPENSATION_ADVANCE')),
        ),
      )
      .orderBy(partnerReceivable.createdAt)
      .limit(1000);
    return rows.map((r) => ({
      receivableId: r.id,
      promoterId: r.promoterId,
      pg: r.pg as Pg | null,
      cause: r.cause as ReceivableRecord['cause'],
      eventId: r.eventId,
      sourceRef: r.sourceRef,
      amount: r.amount,
      remaining: r.remaining,
      status: r.status as ReceivableRecord['status'],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async insertReceivableMove(record: ReceivableMoveRecord): Promise<void> {
    await this.db.db.insert(receivableMoveCompat).values({
      ...(record.moveId ? { id: record.moveId } : {}),
      receivableId: record.receivableId,
      statementId: record.statementId,
      amount: record.amount,
      kind: record.kind ?? 'OFFSET',
      movedAt: record.movedAt,
    });
  }

  async listReceivableMoves(statementId: string): Promise<ReceivableMoveRecord[]> {
    const rows = await this.db.db.select().from(receivableMoveCompat).where(eq(receivableMoveCompat.statementId, statementId));
    return rows.map((r) => ({ moveId: r.id, receivableId: r.receivableId, statementId: r.statementId, amount: r.amount, kind: r.kind as ReceivableMoveRecord['kind'], movedAt: r.movedAt }));
  }

  async listReceivableMovesForReceivable(receivableId: string): Promise<ReceivableMoveRecord[]> {
    const rows = await this.db.db.select().from(receivableMoveCompat).where(eq(receivableMoveCompat.receivableId, receivableId));
    return rows.map((r) => ({ moveId: r.id, receivableId: r.receivableId, statementId: r.statementId, amount: r.amount, kind: r.kind as ReceivableMoveRecord['kind'], movedAt: r.movedAt }));
  }

  async findGuaranteeCollection(idempotencyKey: string): Promise<GuaranteeCollectionRecord | undefined> {
    const rows = await this.db.db.select().from(guaranteeCollection).where(eq(guaranteeCollection.idempotencyKey, idempotencyKey)).limit(1);
    const r = rows[0];
    return r
      ? {
          collectionId: r.id,
          idempotencyKey: r.idempotencyKey,
          receivableId: r.receivableId,
          promoterId: r.promoterId,
          guaranteeKind: r.guaranteeKind as GuaranteeCollectionRecord['guaranteeKind'],
          amount: r.amount,
          basisAmount: r.basisAmount,
          guaranteeRateBp: r.guaranteeRateBp,
          actor: r.actor,
          reason: r.reason,
          createdAt: r.createdAt,
        }
      : undefined;
  }

  async collectGuaranteeAtomically(input: GuaranteeCollectionAtomicInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id, remaining, status from partner_receivable where id = ${input.collection.receivableId} for update`);
      const row = (locked.rows as { id: string; remaining: number | string; status: string }[])[0];
      if (!row) throw new SettlementProblem('guarantee-not-open', 409, '열린 미수금이 아닙니다');
      if (Number(row.remaining) !== input.receivable.remaining + input.move.amount) {
        throw new SettlementProblem('guarantee-conflict', 409, '미수금 잔액이 다른 처리와 겹쳤습니다');
      }
      await tx.insert(guaranteeCollection).values({
        id: input.collection.collectionId,
        idempotencyKey: input.collection.idempotencyKey,
        receivableId: input.collection.receivableId,
        promoterId: input.collection.promoterId,
        guaranteeKind: input.collection.guaranteeKind,
        amount: input.collection.amount,
        basisAmount: input.collection.basisAmount,
        guaranteeRateBp: input.collection.guaranteeRateBp,
        actor: input.collection.actor,
        reason: input.collection.reason,
        createdAt: input.collection.createdAt,
      });
      await tx.insert(receivableMoveCompat).values({
        ...(input.move.moveId ? { id: input.move.moveId } : {}),
        receivableId: input.move.receivableId,
        statementId: input.move.statementId,
        amount: input.move.amount,
        kind: 'GUARANTEE',
        movedAt: input.move.movedAt,
      });
      await tx
        .update(partnerReceivable)
        .set({ remaining: input.receivable.remaining, status: input.receivable.status, updatedAt: input.receivable.updatedAt })
        .where(eq(partnerReceivable.id, input.receivable.receivableId));
    });
  }

  async hasSettlementWebhookReceipt(transmissionId: string): Promise<boolean> {
    const rows = await this.db.db.select().from(settlementWebhookReceipt).where(eq(settlementWebhookReceipt.transmissionId, transmissionId)).limit(1);
    return rows.length > 0;
  }

  async recordSettlementWebhookReceipt(transmissionId: string, receivedAt: Date): Promise<void> {
    await this.db.db.insert(settlementWebhookReceipt).values({ transmissionId, receivedAt }).onConflictDoNothing();
  }
}
