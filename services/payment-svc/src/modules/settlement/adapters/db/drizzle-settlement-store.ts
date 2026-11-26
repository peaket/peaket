// 정산·지급·KYC Drizzle 저장소(docs/data.md settlement_statement…payout).
// 정산서 상태 전이는 조건부 갱신(지금 상태가 출발 상태일 때만)이고, 상태·감사·딸린 행·trade.settlements Outbox를 한 트랜잭션에 쓴다(ADR-0368 결정 2·3).
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { nextBankBusinessDay } from '../../domain/payout-failure.js';
import { type Clock, type Database, type DbTransaction, systemClock, writeOutbox } from '@peaket/platform';
import type {
  AdjustmentInsertResult,
  GuaranteeCollectionAtomicInput,
  ReceivableActionAtomicInput,
  OpsIntakeRow,
  PayoutBatchAtomicInput,
  PayoutWrite,
  PayoutWriteResult,
  ReverseOffset,
  StatementFilter,
  StatementSupersede,
  StatementNotification,
  StatementPage,
  SettlementStore,
  StatementTransition,
} from '../../domain/ports.js';
import type { AdjustmentRecord } from '../../domain/adjustment.js';
import {
  ReceivableBalanceConflict,
  SettlementProblem,
  TRADE_SETTLEMENTS_TOPIC,
  type DisputeRecord,
  type GuaranteeCollectionRecord,
  type KycRecord,
  type OpsRefusal,
  type PayoutAccountChangeRecord,
  type PayoutAccountRecord,
  type PortoneLedgerSyncName,
  type PortoneLedgerSyncRecord,
  type PortonePartnerRecord,
  type PortoneTransferRecord,
  type SettlementAlertRequestRecord,
  type StatementStatus,
  type PayoutBatchAuditRecord,
  type PayoutBatchRecord,
  type PayoutRecord,
  type Pg,
  type PgBalanceReconciliationRecord,
  type PgStore,
  type SettlementCaseRequestRecord,
  type TossSellerRecord,
  type TossSellerStatus,
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type RefundScanRecord,
  type SettlementRecalculationRecord,
  type EventRecalculationView,
  type SettlementEventValue,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementSource,
} from '../../domain/settlement.js';
import {
  guaranteeCollection,
  partnerReceivable,
  receivableAction,
  payout,
  payoutAccount,
  payoutAccountChange,
  payoutBatch,
  payoutBatchAudit,
  payoutRetryAudit,
  pgBalanceReconciliation,
  portoneLedgerSync,
  portonePartner,
  portoneTransfer,
  sellerKyc,
  settlementAlertRequest,
  settlementCaseRequest,
  settlementRecalculation,
  settlementRefundScan,
  settlementStatement,
  settlementStatementAudit,
  settlementWebhookReceipt,
  statementAdjustment,
  statementDispute,
  statementSource,
  tossSeller,
} from './schema.js';
// 표 이름 바꾸기 확장 단계라 옛 이름(뷰)으로 읽고 쓴다(receivable-move-compat.ts 머리 주석)
import { receivableMoveCompat } from './receivable-move-compat.js';
// 0033의 손으로 쓴 미수금 칸(receivable-refund-columns.ts 머리 주석)
import { partnerReceivableFull } from './receivable-refund-columns.js';

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

const receivableRecord = (r: typeof partnerReceivableFull.$inferSelect): ReceivableRecord => ({
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
  // 계산 뒤 환급 미수금의 칸(0033). 다른 원인은 비어 있어 싣지 않는다(옛 답 모양 그대로)
  ...(r.statementId === null ? {} : { statementId: r.statementId }),
  ...(r.commissionRateBp === null ? {} : { commissionRateBp: r.commissionRateBp }),
  ...(r.refundAmount === null ? {} : { refundAmount: r.refundAmount }),
  ...(r.commissionShare === null ? {} : { commissionShare: r.commissionShare }),
  ...(r.commissionVatShare === null ? {} : { commissionVatShare: r.commissionVatShare }),
});

/** 미수금 한 행의 넣을 값(0033 칸 포함) */
const receivableValues = (r: ReceivableRecord) => ({
  id: r.receivableId,
  promoterId: r.promoterId,
  pg: r.pg,
  cause: r.cause,
  eventId: r.eventId ?? null,
  sourceRef: r.sourceRef ?? null,
  amount: r.amount,
  remaining: r.remaining,
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  statementId: r.statementId ?? null,
  commissionRateBp: r.commissionRateBp ?? null,
  refundAmount: r.refundAmount ?? null,
  commissionShare: r.commissionShare ?? null,
  commissionVatShare: r.commissionVatShare ?? null,
});

const recalculationRecord = (r: typeof settlementRecalculation.$inferSelect): SettlementRecalculationRecord => ({
  requestId: r.requestId,
  eventId: r.eventId,
  kind: r.kind as SettlementRecalculationRecord['kind'],
  state: r.state as SettlementRecalculationRecord['state'],
  confirmedAt: r.confirmedAt,
  openedAt: r.openedAt,
  completedAt: r.completedAt,
  partial: r.partial,
  heldStatementIds: r.heldStatementIds ?? [],
  skippedStatementIds: r.skippedStatementIds ?? [],
  retryStatementIds: r.retryStatementIds ?? [],
  result: (r.result as EventRecalculationView | null) ?? null,
  updatedAt: r.updatedAt,
});

const recalculationValues = (r: SettlementRecalculationRecord) => ({
  requestId: r.requestId,
  eventId: r.eventId,
  kind: r.kind,
  state: r.state,
  confirmedAt: r.confirmedAt,
  openedAt: r.openedAt,
  completedAt: r.completedAt,
  partial: r.partial,
  heldStatementIds: [...r.heldStatementIds],
  skippedStatementIds: [...r.skippedStatementIds],
  retryStatementIds: [...r.retryStatementIds],
  result: r.result,
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
  ...(r.commissionRateBp === null ? {} : { commissionRateBp: r.commissionRateBp }),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** 정산서 한 행의 넣을 값 */
const statementValues = (record: StatementRecord) => ({
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
  commissionRateBp: record.commissionRateBp ?? null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/** 이동 기록 한 줄(되돌림이면 되돌린 이동 ID까지) */
const moveRecord = (r: typeof receivableMoveCompat.$inferSelect): ReceivableMoveRecord => ({
  moveId: r.id,
  receivableId: r.receivableId,
  statementId: r.statementId,
  amount: r.amount,
  kind: r.kind as ReceivableMoveRecord['kind'],
  movedAt: r.movedAt,
  ...(r.reversesId === null ? {} : { reversesId: r.reversesId }),
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
  caseRefusedCount: r.caseRefusedCount,
  caseFailedAt: r.caseFailedAt,
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
  submitAttempts: r.submitAttempts,
  nextSubmitAt: r.nextSubmitAt,
  submitDeadlineAt: r.submitDeadlineAt,
  lastSubmitError: r.lastSubmitError,
  dateRetryUsed: r.dateRetryUsed,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** 묶음 행 값(넣기) */
const batchValues = (record: PayoutBatchRecord) => ({
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
  submitAttempts: record.submitAttempts ?? 0,
  nextSubmitAt: record.nextSubmitAt ?? null,
  submitDeadlineAt: record.submitDeadlineAt ?? null,
  lastSubmitError: record.lastSubmitError ?? null,
  dateRetryUsed: record.dateRetryUsed ?? false,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const payoutValues = (r: PayoutRecord) => ({
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
  payoutDate: r.payoutDate,
  failureClass: r.failureClass ?? null,
  retryOfPayoutId: r.retryOfPayoutId ?? null,
  autoRetryCount: r.autoRetryCount ?? 0,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const tossSellerRecord = (r: typeof tossSeller.$inferSelect): TossSellerRecord => ({
  promoterId: r.promoterId,
  pgStore: r.pgStore as PgStore,
  tossSellerId: r.tossSellerId,
  refSellerId: r.refSellerId,
  status: r.status as TossSellerStatus,
  businessType: r.businessType as TossSellerRecord['businessType'],
  registeredAt: r.registeredAt,
  statusCheckedAt: r.statusCheckedAt,
  updatedAt: r.updatedAt,
});

const caseRequestRecord = (r: typeof settlementCaseRequest.$inferSelect): SettlementCaseRequestRecord => ({
  eventKey: r.eventKey,
  kind: r.kind as SettlementCaseRequestRecord['kind'],
  sourceId: r.sourceId,
  createdAt: r.createdAt,
  requestedAt: r.requestedAt,
  detail: r.detail,
  refusedCount: r.refusedCount,
  failedAt: r.failedAt,
  lastRefusal: r.lastRefusal as OpsRefusal | null,
});

// ---- F-07-7 행 ↔ 레코드(payment 0030·0032). 계좌번호·예금주명 칸은 없다 ----
const portonePartnerRecord = (r: typeof portonePartner.$inferSelect): PortonePartnerRecord => ({
  promoterId: r.promoterId,
  portonePartnerId: r.portonePartnerId,
  contractId: r.contractId,
  registeredAt: r.registeredAt,
  accountUpdatedAt: r.accountUpdatedAt,
  lastAccountCheck: r.lastAccountCheck as PortonePartnerRecord['lastAccountCheck'],
  lastAccountCheckedAt: r.lastAccountCheckedAt,
  updatedAt: r.updatedAt,
});
const portonePartnerSet = (r: PortonePartnerRecord) => ({
  portonePartnerId: r.portonePartnerId,
  contractId: r.contractId,
  registeredAt: r.registeredAt,
  accountUpdatedAt: r.accountUpdatedAt,
  lastAccountCheck: r.lastAccountCheck ?? null,
  lastAccountCheckedAt: r.lastAccountCheckedAt ?? null,
  updatedAt: r.updatedAt,
});
const portonePartnerValues = (r: PortonePartnerRecord) => ({ promoterId: r.promoterId, ...portonePartnerSet(r) });

const payoutAccountChangeRecord = (r: typeof payoutAccountChange.$inferSelect): PayoutAccountChangeRecord => ({
  id: r.id,
  promoterId: r.promoterId,
  actorAccountId: r.actorAccountId,
  reauthJti: r.reauthJti,
  result: r.result as PayoutAccountChangeRecord['result'],
  bankCode: r.bankCode,
  accountLast4: r.accountLast4,
  holdUntil: r.holdUntil,
  agencyResults: r.agencyResults as PayoutAccountChangeRecord['agencyResults'],
  reauthFactors: r.reauthFactors,
  createdAt: r.createdAt,
  auditSentAt: r.auditSentAt,
  auditRefusedCount: r.auditRefusedCount,
  auditFailedAt: r.auditFailedAt,
});
const payoutAccountChangeValues = (r: PayoutAccountChangeRecord) => ({
  id: r.id,
  promoterId: r.promoterId,
  actorAccountId: r.actorAccountId,
  reauthJti: r.reauthJti,
  reauthFactors: [...(r.reauthFactors ?? [])],
  result: r.result,
  bankCode: r.bankCode,
  accountLast4: r.accountLast4,
  holdUntil: r.holdUntil,
  agencyResults: r.agencyResults,
  createdAt: r.createdAt,
  auditSentAt: r.auditSentAt,
  auditRefusedCount: r.auditRefusedCount ?? 0,
  auditFailedAt: r.auditFailedAt ?? null,
});

const portoneTransferValues = (r: PortoneTransferRecord) => ({
  transferId: r.transferId,
  withdrawalType: r.withdrawalType,
  payoutId: r.payoutId,
  amount: r.amount,
  bankCode: r.bankCode,
  accountLast4: r.accountLast4,
  holderMatched: r.holderMatched,
  checkResult: r.checkResult,
  transferredAt: r.transferredAt,
  checkedAt: r.checkedAt,
});

const ledgerSyncRecord = (r: typeof portoneLedgerSync.$inferSelect): PortoneLedgerSyncRecord => ({
  name: r.name as PortoneLedgerSyncName,
  lastSuccessAt: r.lastSuccessAt,
  readThrough: r.readThrough,
  haltedOn: r.haltedOn,
  updatedAt: r.updatedAt,
});
const ledgerSyncSet = (r: PortoneLedgerSyncRecord) => ({ lastSuccessAt: r.lastSuccessAt, readThrough: r.readThrough, haltedOn: r.haltedOn, updatedAt: r.updatedAt });
const ledgerSyncValues = (r: PortoneLedgerSyncRecord) => ({ name: r.name, ...ledgerSyncSet(r) });

const alertRequestRecord = (r: typeof settlementAlertRequest.$inferSelect): SettlementAlertRequestRecord => ({
  eventKey: r.eventKey,
  kind: r.kind,
  severity: r.severity as SettlementAlertRequestRecord['severity'],
  sourceId: r.sourceId,
  createdAt: r.createdAt,
  requestedAt: r.requestedAt,
  refusedCount: r.refusedCount,
  failedAt: r.failedAt,
  lastRefusal: r.lastRefusal as OpsRefusal | null,
});
const alertRequestValues = (r: SettlementAlertRequestRecord) => ({
  eventKey: r.eventKey,
  kind: r.kind,
  severity: r.severity,
  sourceId: r.sourceId,
  createdAt: r.createdAt,
  requestedAt: r.requestedAt,
  refusedCount: r.refusedCount ?? 0,
  failedAt: r.failedAt ?? null,
  lastRefusal: r.lastRefusal ?? null,
});
const caseRequestValues = (c: SettlementCaseRequestRecord) => ({
  eventKey: c.eventKey,
  kind: c.kind,
  sourceId: c.sourceId,
  createdAt: c.createdAt,
  requestedAt: c.requestedAt,
  detail: c.detail ?? null,
  refusedCount: c.refusedCount ?? 0,
  failedAt: c.failedAt ?? null,
  lastRefusal: c.lastRefusal ?? null,
});

const reconciliationRecord = (r: typeof pgBalanceReconciliation.$inferSelect): PgBalanceReconciliationRecord => ({
  reconciliationId: r.id,
  pg: r.pg as Pg,
  pgStore: r.pgStore as PgStore,
  kind: r.kind as PgBalanceReconciliationRecord['kind'],
  periodMonth: r.periodMonth,
  batchId: r.batchId,
  cutoffAt: r.cutoffAt,
  approvedAmount: r.approvedAmount,
  refundedAmount: r.refundedAmount,
  pgFeeAmount: r.pgFeeAmount,
  paidOutAmount: r.paidOutAmount,
  peaketWithdrawnAmount: r.peaketWithdrawnAmount,
  expectedAmount: r.expectedAmount,
  observedAmount: r.observedAmount,
  diffAmount: r.diffAmount,
  severity: r.severity as PgBalanceReconciliationRecord['severity'],
  createdAt: r.createdAt,
});

/** 지급 쓰기 묶음의 조건이 맞지 않았다(롤백한 뒤 ok=false로 바꾼다) */
class WriteRejected extends Error {
  constructor() {
    super('지급 쓰기 조건이 맞지 않는다');
    this.name = 'WriteRejected';
  }
}
/** 결과 반영의 지급 건 조건부 갱신이 0행이었다 */
class FactNotApplied extends Error {
  constructor() {
    super('지급 결과를 반영하지 않았다');
    this.name = 'FactNotApplied';
  }
}
const UNFINISHED_PAYOUT = ['REQUESTED', 'IN_PROGRESS'] as const;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

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
  payoutDate: r.payoutDate,
  failureClass: r.failureClass as PayoutRecord['failureClass'],
  retryOfPayoutId: r.retryOfPayoutId,
  autoRetryCount: r.autoRetryCount,
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
      const inserted = await this.#insertStatementIn(tx, record, sources, notify);
      if (!inserted) return false;
      if (notify) await writeOutbox(tx, this.clock, settlementOutbox([notify.event]));
      return true;
    });
  }

  /** 정산서 한 판·원본 목록·(있으면) CALCULATED → NOTIFIED 통지와 감사를 열린 트랜잭션에 쓴다. 부분 유일에 걸리면 false(사건은 부르는 쪽이 쓴다) */
  async #insertStatementIn(tx: DbTransaction, record: StatementRecord, sources: readonly StatementSource[], notify?: StatementNotification): Promise<boolean> {
    const inserted = await tx.insert(settlementStatement).values(statementValues(record)).onConflictDoNothing().returning({ id: settlementStatement.id });
    if (inserted.length === 0) return false;
    if (sources.length > 0)
      await tx.insert(statementSource).values(sources.map((x) => ({ statementId: x.statementId, sourceId: x.sourceId, kind: x.kind, paymentId: x.paymentId, amount: x.amount })));
    if (notify) {
      // 계산 = 통지(ADR-0368 결정 1): 같은 트랜잭션에서 CALCULATED → NOTIFIED, 감사 한 줄, 사건은 마지막 문장
      const notified = await tx
        .update(settlementStatement)
        .set({ status: 'NOTIFIED', disputeDueAt: notify.disputeDueAt, updatedAt: notify.audit.createdAt })
        .where(and(eq(settlementStatement.id, record.statementId), eq(settlementStatement.status, 'CALCULATED')))
        .returning({ id: settlementStatement.id });
      if (notified.length === 0) throw new Error('계산한 정산서를 통지 상태로 바꾸지 못했다');
      await tx.insert(settlementStatementAudit).values(auditValues(notify.audit));
    }
    return true;
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
    if (t.expect?.payoutBatchId !== undefined) conditions.push(eq(settlementStatement.payoutBatchId, t.expect.payoutBatchId));
    const set: Partial<typeof settlementStatement.$inferInsert> = { status: t.to, updatedAt: t.updatedAt };
    if (t.set?.holdReason !== undefined) set.holdReason = t.set.holdReason;
    if (t.set?.disputeDueAt !== undefined) set.disputeDueAt = t.set.disputeDueAt;
    if (t.set?.adjustmentAmount !== undefined) set.adjustmentAmount = t.set.adjustmentAmount;
    if (t.set?.payoutAmount !== undefined) set.payoutAmount = t.set.payoutAmount;
    if (t.set?.offsetAmount !== undefined) set.offsetAmount = t.set.offsetAmount;
    if (t.set?.payoutDate !== undefined) set.payoutDate = t.set.payoutDate;
    // 묶음 빼기(F-07-8 ADR-0380 결정 4): 그 묶음에 붙어 있을 때만 비운다
    if (t.unbatch) {
      conditions.push(eq(settlementStatement.payoutBatchId, t.unbatch.batchId));
      set.payoutBatchId = null;
    }
    // 조건부 갱신이 정산서 행을 잠근다. 0행이면 다른 전이가 먼저 썼다(optional이면 이 전이만 건너뛴다)
    const updated = await tx.update(settlementStatement).set(set).where(and(...conditions)).returning({ id: settlementStatement.id });
    if (updated.length === 0) {
      if (t.optional) return [];
      throw new TransitionRejected();
    }
    if (t.unbatch) {
      const u = t.unbatch;
      const batched = await tx
        .update(payoutBatch)
        .set({ totalAmount: sql`${payoutBatch.totalAmount} - ${u.amount}`, statementCount: sql`${payoutBatch.statementCount} - 1`, updatedAt: t.updatedAt })
        .where(eq(payoutBatch.id, u.batchId))
        .returning({ id: payoutBatch.id });
      if (batched.length === 0) throw new TransitionRejected();
    }
    for (const r of t.reverseOffsets ?? []) await this.#reverseOffsetIn(tx, t.statementId, r);
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
    // 메모리 저장소와 같은 뜻: 행이 없으면 넣고(원본 목록·감사·사건 없이), 있으면 아래 칸을 덮어쓴다. 시험 자료 맞추기 전용(F-07-7 통합 시험)
    await this.db.db
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
      .onConflictDoNothing();
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
      .where(and(isNull(statementDispute.caseRequestedAt), isNull(statementDispute.result), isNull(statementDispute.caseFailedAt)))
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
    await this.db.db.insert(payoutBatch).values(batchValues(record));
  }

  async createPayoutBatchWithStatements(record: PayoutBatchRecord, statementIds: readonly string[]): Promise<void> {
    await this.createPayoutBatchAtomically({ batch: record, statementIds, statementUpdates: [], receivableUpdates: [], receivableMoves: [] });
  }

  async createPayoutBatchAtomically(input: PayoutBatchAtomicInput): Promise<void> {
    const { batch: record } = input;
    try {
      await this.db.transaction(async (tx) => {
        // 09시 PREPARED 묶음은 트랜잭션 첫 문장으로 그 행이 아직 PREPARED일 때만 바꾼다. 겹친 둘째 요청은 이 행에서 줄을 선 뒤 0행이라 409다(ADR-0369 결정 13)
        if (input.promotePrepared) {
          const promoted = await tx
            .update(payoutBatch)
            .set({
              status: record.status,
              totalAmount: record.totalAmount,
              statementCount: record.statementCount,
              pgBalanceKrw: record.pgBalanceKrw,
              pgBalanceSource: record.pgBalanceSource,
              pgBalanceObservedAt: record.pgBalanceObservedAt,
              pgBalanceObservedBy: record.pgBalanceObservedBy,
              pgBalanceLedgerKrw: record.pgBalanceLedgerKrw,
              updatedAt: record.updatedAt,
            })
            .where(and(eq(payoutBatch.id, record.batchId), eq(payoutBatch.status, 'PREPARED')))
            .returning({ id: payoutBatch.id });
          if (promoted.length === 0) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
        }
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
          if (!Number.isSafeInteger(current) || current !== u.remaining + moved) throw new ReceivableBalanceConflict();
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
        if (!input.promotePrepared) await tx.insert(payoutBatch).values(batchValues(record));
        if (input.statementIds.length > 0) {
          // 묶을 때는 payout_batch_id만 채우고 상태는 CONFIRMED 그대로다. SCHEDULED는 결제사 접수 때(T9, ADR-0369 결정 14 ①)
          const updated = await tx
            .update(settlementStatement)
            .set({ payoutBatchId: record.batchId, updatedAt: record.updatedAt })
            .where(and(inArray(settlementStatement.id, [...input.statementIds]), eq(settlementStatement.status, 'CONFIRMED'), isNull(settlementStatement.payoutBatchId)))
            .returning({ id: settlementStatement.id });
          if (updated.length !== input.statementIds.length) throw new SettlementProblem('payout-batch-statement-conflict', 409, '확정 정산서가 아닌 건이 지급 묶음에 섞였습니다');
        }
        events.push(...(input.events ?? []));
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
      // 묶음만 푼다. 정산서 상태는 그대로(CONFIRMED)다(ADR-0369 결정 14 ①)
      await tx.update(settlementStatement).set({ payoutBatchId: null }).where(eq(settlementStatement.payoutBatchId, batchId));
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
        payoutDate: record.payoutDate,
        submitAttempts: record.submitAttempts,
        nextSubmitAt: record.nextSubmitAt,
        submitDeadlineAt: record.submitDeadlineAt,
        lastSubmitError: record.lastSubmitError,
        dateRetryUsed: record.dateRetryUsed,
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
    await this.db.db.insert(payout).values(records.map(payoutValues));
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
        payoutDate: record.payoutDate,
        failureClass: record.failureClass ?? null,
        autoRetryCount: record.autoRetryCount ?? 0,
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
          agencySyncPending: r.agencySyncPending,
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
        agencySyncPending: record.agencySyncPending ?? false,
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
          agencySyncPending: record.agencySyncPending ?? false,
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
    await this.db.db.insert(partnerReceivableFull).values(receivableValues(record));
  }

  async insertReceivableIfAbsent(record: ReceivableRecord): Promise<boolean> {
    const rows = await this.db.db
      .insert(partnerReceivableFull)
      .values(receivableValues(record))
      // source_ref 부분 유일(또는 기본 키)에 걸리면 아무것도 쓰지 않는다(0024)
      .onConflictDoNothing()
      .returning({ id: partnerReceivableFull.id });
    return rows.length > 0;
  }

  async findReceivableBySourceRef(sourceRef: string): Promise<ReceivableRecord | undefined> {
    const rows = await this.db.db.select().from(partnerReceivableFull).where(eq(partnerReceivableFull.sourceRef, sourceRef)).limit(1);
    return rows[0] === undefined ? undefined : receivableRecord(rows[0]);
  }

  async findReceivable(receivableId: string): Promise<ReceivableRecord | undefined> {
    const rows = await this.db.db.select().from(partnerReceivableFull).where(eq(partnerReceivableFull.id, receivableId)).limit(1);
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
      ...(record.reversesId ? { reversesId: record.reversesId } : {}),
    });
  }

  async listReceivableMoves(statementId: string): Promise<ReceivableMoveRecord[]> {
    const rows = await this.db.db.select().from(receivableMoveCompat).where(eq(receivableMoveCompat.statementId, statementId));
    return rows.map(moveRecord);
  }

  async listReceivableMovesForReceivable(receivableId: string): Promise<ReceivableMoveRecord[]> {
    const rows = await this.db.db.select().from(receivableMoveCompat).where(eq(receivableMoveCompat.receivableId, receivableId));
    return rows.map(moveRecord);
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

  async hasWebhookEvent(eventId: string): Promise<boolean> {
    const rows = await this.db.db.select({ id: settlementWebhookReceipt.transmissionId }).from(settlementWebhookReceipt).where(eq(settlementWebhookReceipt.eventId, eventId)).limit(1);
    return rows.length > 0;
  }

  async findReceivableAction(idempotencyKey: string) {
    const rows = await this.db.db.select().from(receivableAction).where(eq(receivableAction.idempotencyKey, idempotencyKey)).limit(1);
    const r = rows[0];
    return r
      ? {
          actionId: r.id,
          idempotencyKey: r.idempotencyKey,
          receivableId: r.receivableId,
          promoterId: r.promoterId,
          kind: r.kind as 'BILLED' | 'COLLECTED' | 'WRITE_OFF',
          amount: r.amount,
          remainingAfter: r.remainingAfter,
          actor: r.actor,
          reason: r.reason,
          createdAt: r.createdAt,
        }
      : undefined;
  }

  async applyReceivableActionAtomically(input: ReceivableActionAtomicInput) {
    let written = false;
    await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id, remaining, status from partner_receivable where id = ${input.action.receivableId} for update`);
      const row = (locked.rows as { id: string; remaining: number | string; status: string }[])[0];
      if (!row || row.status !== input.expectedStatus || Number(row.remaining) !== input.expectedRemaining) return;
      const already = await tx.select({ id: receivableAction.id }).from(receivableAction).where(eq(receivableAction.idempotencyKey, input.action.idempotencyKey)).limit(1);
      if (already.length > 0) return;
      await tx.insert(receivableAction).values({
        id: input.action.actionId,
        idempotencyKey: input.action.idempotencyKey,
        receivableId: input.action.receivableId,
        promoterId: input.action.promoterId,
        kind: input.action.kind,
        amount: input.action.amount,
        remainingAfter: input.action.remainingAfter,
        actor: input.action.actor,
        reason: input.action.reason,
        createdAt: input.action.createdAt,
      });
      if (input.movement) {
        await tx.insert(receivableMoveCompat).values({
          ...(input.movement.moveId ? { id: input.movement.moveId } : {}),
          receivableId: input.movement.receivableId,
          statementId: input.movement.statementId,
          amount: input.movement.amount,
          kind: input.movement.kind ?? 'OFFSET',
          movedAt: input.movement.movedAt,
        });
      }
      await tx
        .update(partnerReceivable)
        .set({ remaining: input.nextRemaining, status: input.nextStatus, updatedAt: input.updatedAt })
        .where(eq(partnerReceivable.id, input.action.receivableId));
      written = true;
    });
    if (!written) return undefined;
    const receivable = await this.findReceivable(input.action.receivableId);
    if (!receivable) return undefined;
    return { receivable, action: input.action };
  }

  async recordWebhookEvent(o: { eventId: string; transmissionId: string; receivedAt: Date }): Promise<void> {
    // 같은 eventId는 한 행이다. 전송 ID(기본 키)가 겹치면(같은 전송 ID·새 eventId) 전송 ID 뒤에 eventId를 붙여 기록한다(J-T16, 시험 리뷰 남은 것 3)
    const inserted = await this.db.db.insert(settlementWebhookReceipt).values({ transmissionId: o.transmissionId, eventId: o.eventId, receivedAt: o.receivedAt }).onConflictDoNothing().returning({ id: settlementWebhookReceipt.transmissionId });
    if (inserted.length > 0 || (await this.hasWebhookEvent(o.eventId))) return;
    await this.db.db.insert(settlementWebhookReceipt).values({ transmissionId: `${o.transmissionId}#${o.eventId}`.slice(0, 512), eventId: o.eventId, receivedAt: o.receivedAt }).onConflictDoNothing();
  }

  // ---- 토스 지급대행(payment 0029, F-07-6 ADR-0369) ----

  async findTossSeller(promoterId: string, pgStore: PgStore): Promise<TossSellerRecord | undefined> {
    const rows = await this.db.db.select().from(tossSeller).where(and(eq(tossSeller.promoterId, promoterId), eq(tossSeller.pgStore, pgStore))).limit(1);
    return rows[0] ? tossSellerRecord(rows[0]) : undefined;
  }

  async findTossSellerById(tossSellerId: string): Promise<TossSellerRecord | undefined> {
    const rows = await this.db.db.select().from(tossSeller).where(eq(tossSeller.tossSellerId, tossSellerId)).limit(1);
    return rows[0] ? tossSellerRecord(rows[0]) : undefined;
  }

  async saveTossSeller(record: TossSellerRecord): Promise<void> {
    const values = {
      promoterId: record.promoterId,
      pgStore: record.pgStore,
      tossSellerId: record.tossSellerId,
      refSellerId: record.refSellerId,
      status: record.status,
      businessType: record.businessType,
      registeredAt: record.registeredAt,
      statusCheckedAt: record.statusCheckedAt,
      updatedAt: record.updatedAt,
    };
    await this.db.db
      .insert(tossSeller)
      .values(values)
      .onConflictDoUpdate({ target: [tossSeller.promoterId, tossSeller.pgStore], set: { tossSellerId: values.tossSellerId, refSellerId: values.refSellerId, status: values.status, businessType: values.businessType, statusCheckedAt: values.statusCheckedAt, updatedAt: values.updatedAt } });
  }

  async countTossSellers(status: TossSellerStatus): Promise<number> {
    const rows = await this.db.db.select({ n: sql<number>`count(*)::int` }).from(tossSeller).where(eq(tossSeller.status, status));
    return Number(rows[0]?.n ?? 0);
  }

  async listHeldStatementsOf(promoterId: string, pg: Pg, pgStore: PgStore): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.status, 'HELD'), eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.pg, pg), eq(settlementStatement.pgStore, pgStore)))
      .orderBy(settlementStatement.createdAt, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async listUnretriedFailedPayouts(o: { promoterId: string; pgStore: PgStore; failureClass: NonNullable<PayoutRecord['failureClass']> }): Promise<PayoutRecord[]> {
    const rows = await this.db.db
      .select({ p: payout })
      .from(payout)
      .innerJoin(settlementStatement, eq(settlementStatement.id, payout.statementId))
      .where(
        and(
          eq(settlementStatement.promoterId, o.promoterId),
          eq(settlementStatement.pg, 'TOSS'),
          eq(settlementStatement.pgStore, o.pgStore),
          eq(payout.status, 'FAILED'),
          eq(payout.failureClass, o.failureClass),
          sql`not exists (select 1 from payout q where q.retry_of_payout_id = ${payout.id})`,
        ),
      )
      .orderBy(payout.createdAt, payout.seq);
    return rows.map((r) => payoutRecord(r.p));
  }

  async writePayoutChanges(w: PayoutWrite): Promise<PayoutWriteResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const { retried, events } = await this.#writeIn(tx, w);
        await writeOutbox(tx, this.clock, settlementOutbox(events));
        return { ok: true, retried };
      });
    } catch (e) {
      if (e instanceof WriteRejected || e instanceof TransitionRejected) return { ok: false, retried: [] };
      throw e;
    }
  }

  async applyPayoutFact(o: Parameters<SettlementStore['applyPayoutFact']>[0]): Promise<PayoutWriteResult | undefined> {
    try {
      return await this.db.transaction(async (tx) => {
        // 지급 건 조건부 갱신이 그 행을 잠근다. 겹친 둘째 반영은 여기서 줄을 선 뒤 0행이다(J-T38 ②)
        const changed = await tx
          .update(payout)
          .set({ status: o.set.status, errorCode: o.set.errorCode, failureClass: o.set.failureClass, updatedAt: o.set.updatedAt })
          .where(and(eq(payout.id, o.payoutId), inArray(payout.status, [...o.from])))
          .returning();
        const row = changed[0];
        if (!row) throw new FactNotApplied();
        const updated = payoutRecord(row);
        // 같은 정산서·묶음의 다른 반영과 줄을 세운다(지급 건 → 정산서 → 묶음 차례)
        const statementRow = (await tx.select().from(settlementStatement).where(eq(settlementStatement.id, updated.statementId)).for('update'))[0];
        const batchRow = (await tx.select().from(payoutBatch).where(eq(payoutBatch.id, updated.batchId)).for('update'))[0];
        if (!statementRow || !batchRow) throw new FactNotApplied();
        const statementPayouts = (await tx.select().from(payout).where(eq(payout.statementId, updated.statementId)).orderBy(payout.seq)).map(payoutRecord);
        const batchPayouts = (await tx.select().from(payout).where(eq(payout.batchId, updated.batchId)).orderBy(payout.seq)).map(payoutRecord);
        const write = o.decide({ payout: updated, statement: statementRecord(statementRow), statementPayouts, batch: batchRecord(batchRow), batchPayouts });
        const { retried, events } = await this.#writeIn(tx, write);
        await writeOutbox(tx, this.clock, settlementOutbox(events));
        return { ok: true, retried };
      });
    } catch (e) {
      if (e instanceof FactNotApplied || e instanceof WriteRejected || e instanceof TransitionRejected) return undefined;
      throw e;
    }
  }

  /** PayoutWrite 한 묶음을 열린 트랜잭션에 쓰고 Outbox에 쓸 사건을 돌려준다(차례: 지급 건 → 재요청 → 정산서 → 묶음 → CS 건 요청) */
  async #writeIn(tx: DbTransaction, w: PayoutWrite): Promise<{ retried: PayoutRecord[]; events: SettlementEventValue[] }> {
    // 포트원 이체는 맨 앞에 넣는다: 두 연결이 같은 이체를 겹쳐 넣으면 둘째는 기본 키에서 첫째의 커밋을 기다린 뒤 0행이고 전체를 되돌린다(J-T20 ②, data.md §5)
    if (w.portoneTransfer) {
      const rows = await tx.insert(portoneTransfer).values(portoneTransferValues(w.portoneTransfer)).onConflictDoNothing().returning({ id: portoneTransfer.transferId });
      if (rows.length === 0) throw new WriteRejected();
    }
    if (w.payoutAccount) {
      const { record, expectedVersion } = w.payoutAccount;
      const values = {
        bankCode: record.bankCode,
        accountLast4: record.accountLast4,
        version: record.version,
        changedAt: record.changedAt,
        holdUntil: record.holdUntil,
        holderVerified: record.holderVerified,
        agencySyncPending: record.agencySyncPending ?? false,
      };
      // If-Match 판을 조건으로 한 갱신(WHERE version = 판). 판 0은 행이 없을 때만 넣는다(data.md §5 '정산 계좌 변경 두 번이 겹침')
      const rows =
        expectedVersion === 0
          ? await tx.insert(payoutAccount).values({ promoterId: record.promoterId, ...values }).onConflictDoNothing().returning({ id: payoutAccount.promoterId })
          : await tx
              .update(payoutAccount)
              .set(values)
              .where(and(eq(payoutAccount.promoterId, record.promoterId), eq(payoutAccount.version, expectedVersion)))
              .returning({ id: payoutAccount.promoterId });
      if (rows.length === 0) throw new WriteRejected();
    }
    if (w.payoutAccountChange) {
      // reauth_jti 유일 인덱스가 같은 재인증 토큰의 두 번째 시도를 막는다(한 번 쓰기 저장소와 두 겹)
      const rows = await tx.insert(payoutAccountChange).values(payoutAccountChangeValues(w.payoutAccountChange)).onConflictDoNothing().returning({ id: payoutAccountChange.id });
      if (rows.length === 0) throw new WriteRejected();
    }
    for (const u of w.payoutUpdates ?? []) {
      const set: Partial<typeof payout.$inferInsert> = { updatedAt: u.set.updatedAt };
      if (u.set.pgPayoutId !== undefined) set.pgPayoutId = u.set.pgPayoutId;
      if (u.set.status !== undefined) set.status = u.set.status;
      if (u.set.errorCode !== undefined) set.errorCode = u.set.errorCode;
      if (u.set.failureClass !== undefined) set.failureClass = u.set.failureClass;
      if (u.set.payoutDate !== undefined) set.payoutDate = u.set.payoutDate;
      if (u.set.pgTransferId !== undefined) set.pgTransferId = u.set.pgTransferId;
      if (u.set.transferCheck !== undefined) set.transferCheck = u.set.transferCheck;
      if (u.set.transferCheckedAt !== undefined) set.transferCheckedAt = u.set.transferCheckedAt;
      const conditions = [eq(payout.id, u.payoutId)];
      if (u.from) conditions.push(inArray(payout.status, [...u.from]));
      const rows = await tx.update(payout).set(set).where(and(...conditions)).returning({ id: payout.id });
      if (rows.length === 0) throw new WriteRejected();
    }
    if (w.insertPayouts && w.insertPayouts.length > 0) {
      // 기본 키·payout_ref_key·(batch, statement, seq) 가운데 하나라도 겹치면 넣지 않은 행이 생기고 전체를 되돌린다
      const rows = await tx.insert(payout).values(w.insertPayouts.map(payoutValues)).onConflictDoNothing().returning({ id: payout.id });
      if (rows.length !== w.insertPayouts.length) throw new WriteRejected();
    }
    const retried: PayoutRecord[] = [];
    for (const r of w.retries ?? []) {
      // 정산서 행을 잠근 채 그 정산서의 가장 큰 순번 + 1(ADR-0369 결정 8). 옛 건이 FAILED가 아니거나 이미 대신한 건이 있으면 전체 롤백
      const oldRow = (await tx.select().from(payout).where(eq(payout.id, r.oldPayoutId)).for('update'))[0];
      if (!oldRow || oldRow.status !== 'FAILED') throw new WriteRejected();
      await tx.execute(sql`select id from settlement_statement where id = ${oldRow.statementId}::uuid for update`);
      const replaced = await tx.select({ id: payout.id }).from(payout).where(eq(payout.retryOfPayoutId, r.oldPayoutId)).limit(1);
      if (replaced.length > 0) throw new WriteRejected();
      const max = await tx.select({ seq: sql<number>`coalesce(max(${payout.seq}), 0)::int` }).from(payout).where(eq(payout.statementId, oldRow.statementId));
      const seq = Number(max[0]?.seq ?? 0) + 1;
      const old = payoutRecord(oldRow);
      const next: PayoutRecord = {
        ...old,
        payoutId: r.newPayoutId,
        seq,
        refPayoutId: `${old.statementId}-${seq}`,
        pgPayoutId: null,
        status: 'REQUESTED',
        errorCode: null,
        pgTransferId: null,
        transferCheck: null,
        transferCheckedAt: null,
        payoutDate: r.payoutDate,
        failureClass: null,
        retryOfPayoutId: old.payoutId,
        autoRetryCount: r.autoRetryCount,
        createdAt: r.at,
        updatedAt: r.at,
      };
      await tx.insert(payout).values(payoutValues(next));
      await tx.insert(payoutRetryAudit).values({ id: r.auditId, payoutId: old.payoutId, newPayoutId: next.payoutId, oldSeq: old.seq, newSeq: seq, actor: r.actor, reason: r.reason, createdAt: r.at });
      retried.push(next);
    }
    const events: SettlementEventValue[] = [];
    for (const t of w.transitions ?? []) events.push(...(await this.#transitionIn(tx, t)));
    if (w.batch) {
      const set: Partial<typeof payoutBatch.$inferInsert> = { updatedAt: w.batch.set.updatedAt };
      const b = w.batch.set;
      if (b.status !== undefined) set.status = b.status;
      if (b.payoutDate !== undefined) set.payoutDate = b.payoutDate;
      if (b.submitAttempts !== undefined) set.submitAttempts = b.submitAttempts;
      if (b.nextSubmitAt !== undefined) set.nextSubmitAt = b.nextSubmitAt;
      if (b.submitDeadlineAt !== undefined) set.submitDeadlineAt = b.submitDeadlineAt;
      if (b.lastSubmitError !== undefined) set.lastSubmitError = b.lastSubmitError;
      if (b.dateRetryUsed !== undefined) set.dateRetryUsed = b.dateRetryUsed;
      const conditions = [eq(payoutBatch.id, w.batch.batchId)];
      if (w.batch.expectStatus) conditions.push(inArray(payoutBatch.status, [...w.batch.expectStatus]));
      const rows = await tx.update(payoutBatch).set(set).where(and(...conditions)).returning({ id: payoutBatch.id });
      if (rows.length === 0) throw new WriteRejected();
    }
    if (w.caseRequests && w.caseRequests.length > 0) {
      await tx.insert(settlementCaseRequest).values(w.caseRequests.map(caseRequestValues)).onConflictDoNothing();
    }
    if (w.alertRequests && w.alertRequests.length > 0) {
      await tx.insert(settlementAlertRequest).values(w.alertRequests.map(alertRequestValues)).onConflictDoNothing();
    }
    if (w.ledgerSync) {
      await tx.insert(portoneLedgerSync).values(ledgerSyncValues(w.ledgerSync)).onConflictDoUpdate({ target: portoneLedgerSync.name, set: ledgerSyncSet(w.ledgerSync) });
    }
    if (w.portonePartner) {
      await tx.insert(portonePartner).values(portonePartnerValues(w.portonePartner)).onConflictDoUpdate({ target: portonePartner.promoterId, set: portonePartnerSet(w.portonePartner) });
    }
    return { retried, events };
  }

  async insertCaseRequests(records: readonly SettlementCaseRequestRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const rows = await this.db.db
      .insert(settlementCaseRequest)
      .values(records.map(caseRequestValues))
      .onConflictDoNothing()
      .returning({ eventKey: settlementCaseRequest.eventKey });
    return rows.length;
  }

  async listUnsentCaseRequests(limit: number): Promise<SettlementCaseRequestRecord[]> {
    const rows = await this.db.db.select().from(settlementCaseRequest).where(and(isNull(settlementCaseRequest.requestedAt), isNull(settlementCaseRequest.failedAt))).orderBy(settlementCaseRequest.createdAt, settlementCaseRequest.eventKey).limit(limit);
    return rows.map(caseRequestRecord);
  }

  async markCaseRequestSent(eventKey: string, at: Date): Promise<void> {
    await this.db.db.update(settlementCaseRequest).set({ requestedAt: at }).where(and(eq(settlementCaseRequest.eventKey, eventKey), isNull(settlementCaseRequest.requestedAt)));
  }

  async insertPgBalanceReconciliation(record: PgBalanceReconciliationRecord, caseRequest?: SettlementCaseRequestRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // 같은 달(MONTHLY)·같은 묶음(BATCH) 부분 유일에 걸리면 넣지 않는다. 겹친 둘째는 첫째가 끝날 때까지 줄을 선 뒤 0행이다(J-T25, TR-17)
      const inserted = await tx
        .insert(pgBalanceReconciliation)
        .values({
          id: record.reconciliationId,
          pg: record.pg,
          pgStore: record.pgStore,
          kind: record.kind,
          periodMonth: record.periodMonth,
          batchId: record.batchId,
          cutoffAt: record.cutoffAt,
          approvedAmount: record.approvedAmount,
          refundedAmount: record.refundedAmount,
          pgFeeAmount: record.pgFeeAmount,
          paidOutAmount: record.paidOutAmount,
          peaketWithdrawnAmount: record.peaketWithdrawnAmount,
          expectedAmount: record.expectedAmount,
          observedAmount: record.observedAmount,
          diffAmount: record.diffAmount,
          severity: record.severity,
          createdAt: record.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: pgBalanceReconciliation.id });
      if (inserted.length === 0) return false;
      if (caseRequest) {
        await tx
          .insert(settlementCaseRequest)
          .values({ eventKey: caseRequest.eventKey, kind: caseRequest.kind, sourceId: caseRequest.sourceId, createdAt: caseRequest.createdAt, requestedAt: caseRequest.requestedAt })
          .onConflictDoNothing();
      }
      return true;
    });
  }

  async lastPgBalanceReconciliation(pg: Pg, pgStore: PgStore): Promise<PgBalanceReconciliationRecord | undefined> {
    const rows = await this.db.db
      .select()
      .from(pgBalanceReconciliation)
      .where(and(eq(pgBalanceReconciliation.pg, pg), eq(pgBalanceReconciliation.pgStore, pgStore)))
      .orderBy(desc(pgBalanceReconciliation.cutoffAt), desc(pgBalanceReconciliation.createdAt))
      .limit(1);
    return rows[0] ? reconciliationRecord(rows[0]) : undefined;
  }

  async listBatchesAwaitingReconciliation(since: Date, limit: number): Promise<PayoutBatchRecord[]> {
    const rows = await this.db.db
      .select()
      .from(payoutBatch)
      .where(
        and(
          eq(payoutBatch.pg, 'TOSS'),
          gte(payoutBatch.createdAt, since),
          sql`not exists (select 1 from pg_balance_reconciliation r where r.kind = 'BATCH' and r.batch_id = ${payoutBatch.id})`,
        ),
      )
      .orderBy(payoutBatch.createdAt)
      .limit(limit);
    return rows.map(batchRecord);
  }

  async sumUnfinishedTossPayouts(pgStore: PgStore, excludeBatchId?: string): Promise<number> {
    const conditions = [eq(payoutBatch.pg, 'TOSS'), eq(payoutBatch.pgStore, pgStore), inArray(payout.status, [...UNFINISHED_PAYOUT])];
    if (excludeBatchId) conditions.push(ne(payout.batchId, excludeBatchId));
    const rows = await this.db.db
      .select({ amount: sql<string>`coalesce(sum(${payout.amount}), 0)` })
      .from(payout)
      .innerJoin(payoutBatch, eq(payoutBatch.id, payout.batchId))
      .where(and(...conditions));
    return Number(rows[0]?.amount ?? 0);
  }

  async claimBatchSubmit(batchId: string, expectedNextSubmitAt: Date | null, next: Date | null): Promise<boolean> {
    // 읽은 next_submit_at 그대로일 때만 바꾼다. 겹친 둘째 파드는 이 행에서 줄을 선 뒤 0행이다(J-T5)
    const rows = await this.db.db
      .update(payoutBatch)
      .set({ nextSubmitAt: next })
      .where(and(eq(payoutBatch.id, batchId), expectedNextSubmitAt === null ? isNull(payoutBatch.nextSubmitAt) : eq(payoutBatch.nextSubmitAt, expectedNextSubmitAt)))
      .returning({ id: payoutBatch.id });
    return rows.length > 0;
  }

  async listDueSubmitBatches(now: Date, limit: number): Promise<PayoutBatchRecord[]> {
    const rows = await this.db.db
      .select()
      .from(payoutBatch)
      .where(and(eq(payoutBatch.pg, 'TOSS'), inArray(payoutBatch.status, ['APPROVED', 'SUBMITTED', 'PARTIAL_FAILED']), lte(payoutBatch.nextSubmitAt, now)))
      .orderBy(payoutBatch.nextSubmitAt, payoutBatch.id)
      .limit(limit);
    return rows.map(batchRecord);
  }

  async listOverduePayouts(now: Date, limit: number): Promise<PayoutRecord[]> {
    // 지급일 다음 은행 영업일 12:00 KST가 지났는지는 응용 규칙(주말만 뺀다)으로 거른다. 그날 KST 날짜 전의 지급일만 후보다
    const today = new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
    const rows = await this.db.db
      .select({ p: payout })
      .from(payout)
      .innerJoin(payoutBatch, eq(payoutBatch.id, payout.batchId))
      .where(and(eq(payoutBatch.pg, 'TOSS'), inArray(payout.status, [...UNFINISHED_PAYOUT]), sql`${payout.pgPayoutId} is not null`, lt(payout.payoutDate, today)))
      .orderBy(payout.payoutDate, payout.id)
      .limit(limit * 4);
    return rows
      .map((r) => payoutRecord(r.p))
      .filter((p) => Date.parse(`${nextBankBusinessDay(p.payoutDate)}T12:00:00+09:00`) <= now.getTime())
      .slice(0, limit);
  }

  // ---- F-07-7 포트원 지급대행·계좌 변경·사후 대사(payment 0030·0032, ADR-0370) ----
  async findPortonePartner(promoterId: string): Promise<PortonePartnerRecord | undefined> {
    const rows = await this.db.db.select().from(portonePartner).where(eq(portonePartner.promoterId, promoterId)).limit(1);
    return rows[0] ? portonePartnerRecord(rows[0]) : undefined;
  }

  async savePortonePartner(record: PortonePartnerRecord): Promise<void> {
    await this.db.db.insert(portonePartner).values(portonePartnerValues(record)).onConflictDoUpdate({ target: portonePartner.promoterId, set: portonePartnerSet(record) });
  }

  async listPortonePartners(limit: number): Promise<PortonePartnerRecord[]> {
    const rows = await this.db.db.select().from(portonePartner).orderBy(portonePartner.promoterId).limit(limit);
    return rows.map(portonePartnerRecord);
  }

  async insertPayoutAccountChange(record: PayoutAccountChangeRecord): Promise<boolean> {
    const rows = await this.db.db.insert(payoutAccountChange).values(payoutAccountChangeValues(record)).onConflictDoNothing().returning({ id: payoutAccountChange.id });
    return rows.length > 0;
  }

  async listUnsentPayoutAccountChanges(limit: number): Promise<PayoutAccountChangeRecord[]> {
    const rows = await this.db.db
      .select()
      .from(payoutAccountChange)
      .where(and(isNull(payoutAccountChange.auditSentAt), isNull(payoutAccountChange.auditFailedAt)))
      .orderBy(payoutAccountChange.createdAt, payoutAccountChange.id)
      .limit(limit);
    return rows.map(payoutAccountChangeRecord);
  }

  async markPayoutAccountChangeSent(id: string, at: Date): Promise<void> {
    await this.db.db.update(payoutAccountChange).set({ auditSentAt: at }).where(and(eq(payoutAccountChange.id, id), isNull(payoutAccountChange.auditSentAt)));
  }

  async countAgencySyncPending(): Promise<number> {
    const rows = await this.db.db.select({ n: sql<number>`count(*)::int` }).from(payoutAccount).where(eq(payoutAccount.agencySyncPending, true));
    return Number(rows[0]?.n ?? 0);
  }

  async findLedgerSync(name: PortoneLedgerSyncName): Promise<PortoneLedgerSyncRecord | undefined> {
    const rows = await this.db.db.select().from(portoneLedgerSync).where(eq(portoneLedgerSync.name, name)).limit(1);
    return rows[0] ? ledgerSyncRecord(rows[0]) : undefined;
  }

  async saveLedgerSync(record: PortoneLedgerSyncRecord): Promise<void> {
    await this.db.db.insert(portoneLedgerSync).values(ledgerSyncValues(record)).onConflictDoUpdate({ target: portoneLedgerSync.name, set: ledgerSyncSet(record) });
  }

  async insertAlertRequests(records: readonly SettlementAlertRequestRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const rows = await this.db.db.insert(settlementAlertRequest).values(records.map(alertRequestValues)).onConflictDoNothing().returning({ eventKey: settlementAlertRequest.eventKey });
    return rows.length;
  }

  async listUnsentAlertRequests(limit: number): Promise<SettlementAlertRequestRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementAlertRequest)
      .where(and(isNull(settlementAlertRequest.requestedAt), isNull(settlementAlertRequest.failedAt)))
      .orderBy(settlementAlertRequest.createdAt, settlementAlertRequest.eventKey)
      .limit(limit);
    return rows.map(alertRequestRecord);
  }

  async markAlertRequestSent(eventKey: string, at: Date): Promise<void> {
    await this.db.db.update(settlementAlertRequest).set({ requestedAt: at }).where(and(eq(settlementAlertRequest.eventKey, eventKey), isNull(settlementAlertRequest.requestedAt)));
  }

  async findAlertRequest(eventKey: string): Promise<SettlementAlertRequestRecord | undefined> {
    const rows = await this.db.db.select().from(settlementAlertRequest).where(eq(settlementAlertRequest.eventKey, eventKey)).limit(1);
    return rows[0] ? alertRequestRecord(rows[0]) : undefined;
  }

  async findCaseRequest(eventKey: string): Promise<SettlementCaseRequestRecord | undefined> {
    const rows = await this.db.db.select().from(settlementCaseRequest).where(eq(settlementCaseRequest.eventKey, eventKey)).limit(1);
    return rows[0] ? caseRequestRecord(rows[0]) : undefined;
  }

  /**
   * 거절 한 번(F-07-7 계획 §5.1 (파) (마)). 읽은 거절 수를 조건으로 올리므로(WHERE failed_at IS NULL AND refused_count = 읽은 값) 겹친 두 tick 가운데 하나만 센다.
   * 졌거나 행이 없거나 이미 영구 실패면 undefined
   */
  async markRefused(row: OpsIntakeRow, key: string, refusal: OpsRefusal, at: Date, limit: number): Promise<{ refusedCount: number; failed: boolean } | undefined> {
    const next = (read: number) => {
      const refusedCount = read + 1;
      return { refusedCount, failed: refusedCount >= limit };
    };
    if (row === 'case-request') {
      const r = (await this.db.db.select().from(settlementCaseRequest).where(eq(settlementCaseRequest.eventKey, key)).limit(1))[0];
      if (!r || r.requestedAt !== null || r.failedAt !== null) return undefined;
      const out = next(r.refusedCount);
      const done = await this.db.db
        .update(settlementCaseRequest)
        .set({ refusedCount: out.refusedCount, lastRefusal: refusal, failedAt: out.failed ? at : null })
        .where(and(eq(settlementCaseRequest.eventKey, key), isNull(settlementCaseRequest.requestedAt), isNull(settlementCaseRequest.failedAt), eq(settlementCaseRequest.refusedCount, r.refusedCount)))
        .returning({ k: settlementCaseRequest.eventKey });
      return done.length > 0 ? out : undefined;
    }
    if (row === 'alert-request') {
      const r = (await this.db.db.select().from(settlementAlertRequest).where(eq(settlementAlertRequest.eventKey, key)).limit(1))[0];
      if (!r || r.requestedAt !== null || r.failedAt !== null) return undefined;
      const out = next(r.refusedCount);
      const done = await this.db.db
        .update(settlementAlertRequest)
        .set({ refusedCount: out.refusedCount, lastRefusal: refusal, failedAt: out.failed ? at : null })
        .where(and(eq(settlementAlertRequest.eventKey, key), isNull(settlementAlertRequest.requestedAt), isNull(settlementAlertRequest.failedAt), eq(settlementAlertRequest.refusedCount, r.refusedCount)))
        .returning({ k: settlementAlertRequest.eventKey });
      return done.length > 0 ? out : undefined;
    }
    if (row === 'payout-account-change') {
      const r = (await this.db.db.select().from(payoutAccountChange).where(eq(payoutAccountChange.id, key)).limit(1))[0];
      if (!r || r.auditSentAt !== null || r.auditFailedAt !== null) return undefined;
      const out = next(r.auditRefusedCount);
      const done = await this.db.db
        .update(payoutAccountChange)
        .set({ auditRefusedCount: out.refusedCount, auditFailedAt: out.failed ? at : null })
        .where(and(eq(payoutAccountChange.id, key), isNull(payoutAccountChange.auditSentAt), isNull(payoutAccountChange.auditFailedAt), eq(payoutAccountChange.auditRefusedCount, r.auditRefusedCount)))
        .returning({ id: payoutAccountChange.id });
      return done.length > 0 ? out : undefined;
    }
    const d = (await this.db.db.select().from(statementDispute).where(eq(statementDispute.id, key)).limit(1))[0];
    if (!d || d.caseRequestedAt !== null || d.caseFailedAt !== null) return undefined;
    const out = next(d.caseRefusedCount);
    const done = await this.db.db
      .update(statementDispute)
      .set({ caseRefusedCount: out.refusedCount, caseFailedAt: out.failed ? at : null })
      .where(and(eq(statementDispute.id, key), isNull(statementDispute.caseRequestedAt), isNull(statementDispute.caseFailedAt), eq(statementDispute.caseRefusedCount, d.caseRefusedCount)))
      .returning({ id: statementDispute.id });
    return done.length > 0 ? out : undefined;
  }

  async countIntakeFailed(row: OpsIntakeRow): Promise<number> {
    const count = sql<number>`count(*)::int`;
    const rows =
      row === 'case-request'
        ? await this.db.db.select({ n: count }).from(settlementCaseRequest).where(isNotNull(settlementCaseRequest.failedAt))
        : row === 'alert-request'
          ? await this.db.db.select({ n: count }).from(settlementAlertRequest).where(isNotNull(settlementAlertRequest.failedAt))
          : row === 'payout-account-change'
            ? await this.db.db.select({ n: count }).from(payoutAccountChange).where(isNotNull(payoutAccountChange.auditFailedAt))
            : await this.db.db.select({ n: count }).from(statementDispute).where(isNotNull(statementDispute.caseFailedAt));
    return Number(rows[0]?.n ?? 0);
  }

  async listPortonePayoutsForTransferCheck(limit: number): Promise<PayoutRecord[]> {
    const rows = await this.db.db
      .select({ p: payout })
      .from(payout)
      .innerJoin(payoutBatch, eq(payoutBatch.id, payout.batchId))
      .where(and(eq(payoutBatch.pg, 'PORTONE'), inArray(payout.status, ['COMPLETED', 'IN_PROGRESS']), isNull(payout.transferCheck)))
      .orderBy(payout.createdAt, payout.id)
      .limit(limit);
    return rows.map((r) => payoutRecord(r.p));
  }

  async listStatementsOfPromoter(promoterId: string, pg: Pg, statuses: readonly StatementStatus[]): Promise<StatementRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.promoterId, promoterId), eq(settlementStatement.pg, pg), inArray(settlementStatement.status, [...statuses])))
      .orderBy(settlementStatement.createdAt, settlementStatement.id);
    return rows.map(statementRecord);
  }

  // ---- F-07-8 회차 취소 다시 계산·계산 뒤 환급·대사 미완 결제 풀림(payment 0033, ADR-0380) ----

  /**
   * 상계 되돌림 한 줄(ADR-0380 결정 4·8). 이미 되돌린 OFFSET이면 전이 전체를 롤백한다. 미수금 행을 잠근 채 남은 금액을 되살린다(상계와 같은 잠금 차례:
   * 정산서 행 → 미수금 행). 정산서 행을 먼저 조건부로 바꿨으므로 같은 정산서를 겹쳐 되돌리는 두 트랜잭션은 줄을 서고 뒤의 것은 조건에서 진다
   */
  async #reverseOffsetIn(tx: DbTransaction, statementId: string, r: ReverseOffset): Promise<void> {
    const done = await tx.execute(sql`select 1 from receivable_move where kind = 'REVERSAL' and reverses_id = ${r.moveId}::uuid limit 1`);
    if (done.rows.length > 0) throw new TransitionRejected();
    const offset = await tx.execute(sql`select 1 from receivable_move where id = ${r.moveId}::uuid and kind = 'OFFSET' and statement_id = ${statementId}::uuid and receivable_id = ${r.receivableId}::uuid and amount = ${r.amount}`);
    if (offset.rows.length === 0) throw new TransitionRejected();
    const locked = await tx.execute(sql`select amount, remaining from partner_receivable where id = ${r.receivableId}::uuid for update`);
    const row = locked.rows[0] as { amount: number | string; remaining: number | string } | undefined;
    if (!row || Number(row.remaining) + r.amount > Number(row.amount)) throw new TransitionRejected();
    await tx.insert(receivableMoveCompat).values({ id: r.reversalId, receivableId: r.receivableId, statementId, amount: r.amount, kind: 'REVERSAL', movedAt: r.at, reversesId: r.moveId });
    await tx
      .update(partnerReceivable)
      .set({ remaining: sql`${partnerReceivable.remaining} + ${r.amount}`, status: 'OPEN', updatedAt: r.at })
      .where(eq(partnerReceivable.id, r.receivableId));
  }

  async supersedeStatement(x: StatementSupersede): Promise<boolean> {
    try {
      await this.db.transaction(async (tx) => {
        // ① 옛 판 조건부 전이가 정산서 행을 잠근다. 겹친 다른 완료는 여기서 줄을 선 뒤 0행이라 진다
        const events = await this.#transitionIn(tx, x.old);
        // ② 옛 판 음수 미수금을 행 잠금으로 읽는다(상계 묶음과 같은 잠금. 묶음이 먼저 상계했으면 그 남은 금액을 본다)
        let negative: { receivableId: string; amount: number; remaining: number } | undefined;
        if (x.negativeSourceRef) {
          const locked = await tx.execute(sql`select id, amount, remaining from partner_receivable where source_ref = ${x.negativeSourceRef} for update`);
          const row = locked.rows[0] as { id: string; amount: number | string; remaining: number | string } | undefined;
          if (row) negative = { receivableId: row.id, amount: Number(row.amount), remaining: Number(row.remaining) };
        }
        const plan = x.decide(negative ? { negative } : {});
        // ③ 옛 판의 열린 이의는 SUPERSEDED, 적용 전 조정은 VOID(ADR-0380 결정 6)
        await tx
          .update(statementDispute)
          .set({ result: 'SUPERSEDED', resolvedAt: x.closedAt })
          .where(and(eq(statementDispute.statementId, x.old.statementId), isNull(statementDispute.result)));
        await tx
          .update(statementAdjustment)
          .set({ status: 'VOID' })
          .where(and(eq(statementAdjustment.statementId, x.old.statementId), eq(statementAdjustment.status, 'PENDING')));
        // ④ 새 판·원본 목록·통지·감사(옛 판이 SUPERSEDED라 회차 부분 유일에 걸리지 않는다)
        if (!(await this.#insertStatementIn(tx, plan.record, plan.sources, plan.notify))) throw new TransitionRejected();
        if (plan.audits.length > 0) await tx.insert(settlementStatementAudit).values(plan.audits.map(auditValues));
        // ⑤ 옛 판 음수 미수금을 남은 금액만큼 닫는다(이동 SUPERSEDED 한 줄·남은 0·CLOSED)
        const close = plan.closeNegative;
        if (close && close.amount > 0) {
          await tx.insert(receivableMoveCompat).values({ id: close.moveId, receivableId: close.receivableId, statementId: x.old.statementId, amount: close.amount, kind: 'SUPERSEDED', movedAt: close.at });
          const closed = await tx
            .update(partnerReceivable)
            .set({ remaining: 0, status: 'CLOSED', updatedAt: close.at })
            .where(and(eq(partnerReceivable.id, close.receivableId), eq(partnerReceivable.remaining, close.amount)))
            .returning({ id: partnerReceivable.id });
          if (closed.length === 0) throw new TransitionRejected();
        }
        // 사건은 트랜잭션의 마지막 문장
        await writeOutbox(tx, this.clock, settlementOutbox([...events, plan.notify.event]));
      });
      return true;
    } catch (e) {
      if (e instanceof TransitionRejected) return false;
      throw e;
    }
  }

  async insertRecalculation(record: SettlementRecalculationRecord): Promise<{ created: boolean; record: SettlementRecalculationRecord }> {
    const rows = await this.db.db.insert(settlementRecalculation).values(recalculationValues(record)).onConflictDoNothing().returning({ requestId: settlementRecalculation.requestId });
    if (rows.length > 0) return { created: true, record };
    const existing = await this.findRecalculation(record.requestId);
    if (!existing) throw new Error('다시 계산 요청을 쓰지 못했다');
    return { created: false, record: existing };
  }

  async findRecalculation(requestId: string): Promise<SettlementRecalculationRecord | undefined> {
    const rows = await this.db.db.select().from(settlementRecalculation).where(eq(settlementRecalculation.requestId, requestId)).limit(1);
    return rows[0] ? recalculationRecord(rows[0]) : undefined;
  }

  async findPendingRecalculation(eventId: string): Promise<SettlementRecalculationRecord | undefined> {
    const rows = await this.db.db
      .select()
      .from(settlementRecalculation)
      .where(and(eq(settlementRecalculation.eventId, eventId), eq(settlementRecalculation.state, 'PENDING')))
      .orderBy(settlementRecalculation.openedAt, settlementRecalculation.requestId)
      .limit(1);
    return rows[0] ? recalculationRecord(rows[0]) : undefined;
  }

  async listPendingRecalculations(limit: number): Promise<SettlementRecalculationRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementRecalculation)
      .where(eq(settlementRecalculation.state, 'PENDING'))
      .orderBy(settlementRecalculation.openedAt, settlementRecalculation.requestId)
      .limit(limit);
    return rows.map(recalculationRecord);
  }

  async saveRecalculation(record: SettlementRecalculationRecord): Promise<boolean> {
    const { requestId: _id, ...values } = recalculationValues(record);
    void _id;
    const rows = await this.db.db
      .update(settlementRecalculation)
      .set(values)
      .where(and(eq(settlementRecalculation.requestId, record.requestId), eq(settlementRecalculation.state, 'PENDING')))
      .returning({ requestId: settlementRecalculation.requestId });
    return rows.length > 0;
  }

  async listLiveEventStatements(eventId: string): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(and(eq(settlementStatement.kind, 'EVENT'), eq(settlementStatement.eventId, eventId), ne(settlementStatement.status, 'SUPERSEDED')))
      .orderBy(settlementStatement.createdAt, settlementStatement.id);
    return rows.map(statementRecord);
  }

  async listOffsetMovements(statementId: string): Promise<ReceivableMoveRecord[]> {
    const rows = await this.db.db
      .select()
      .from(receivableMoveCompat)
      .where(
        and(
          eq(receivableMoveCompat.statementId, statementId),
          eq(receivableMoveCompat.kind, 'OFFSET'),
          sql`not exists (select 1 from receivable_move r where r.kind = 'REVERSAL' and r.reverses_id = ${receivableMoveCompat.id})`,
        ),
      )
      .orderBy(receivableMoveCompat.movedAt, receivableMoveCompat.id);
    return rows.map(moveRecord);
  }

  async listStatementSources(statementId: string): Promise<StatementSource[]> {
    const rows = await this.db.db.select().from(statementSource).where(eq(statementSource.statementId, statementId));
    return rows.map((r) => ({ statementId: r.statementId, sourceId: r.sourceId, kind: r.kind as StatementSource['kind'], paymentId: r.paymentId, amount: r.amount }));
  }

  async findRefundScan(name: RefundScanRecord['name']): Promise<RefundScanRecord | undefined> {
    const rows = await this.db.db.select().from(settlementRefundScan).where(eq(settlementRefundScan.name, name)).limit(1);
    const r = rows[0];
    return r ? { name: r.name as RefundScanRecord['name'], readThrough: r.readThrough, readThroughPaymentId: r.readThroughPaymentId, updatedAt: r.updatedAt } : undefined;
  }

  async saveRefundScan(record: RefundScanRecord): Promise<void> {
    const values = { readThrough: record.readThrough, readThroughPaymentId: record.readThroughPaymentId ?? '', updatedAt: record.updatedAt ?? record.readThrough };
    await this.db.db
      .insert(settlementRefundScan)
      .values({ name: record.name, ...values })
      .onConflictDoUpdate({ target: settlementRefundScan.name, set: values });
  }

  async sumRefundReceivables(statementId: string, paymentId: string): Promise<number> {
    const rows = await this.db.db
      .select({ total: sql<string | null>`coalesce(sum(${partnerReceivableFull.refundAmount}), 0)` })
      .from(partnerReceivableFull)
      .where(
        and(
          eq(partnerReceivableFull.cause, 'REFUND_AFTER_PAYOUT'),
          eq(partnerReceivableFull.statementId, statementId),
          sql`${partnerReceivableFull.sourceRef} like ${`refund:${statementId}:${paymentId}:%`}`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async listStatementsWithOpenExclusions(limit: number): Promise<StatementRecord[]> {
    const rows = await this.db.db
      .select()
      .from(settlementStatement)
      .where(
        and(
          eq(settlementStatement.kind, 'EVENT'),
          ne(settlementStatement.status, 'SUPERSEDED'),
          sql`exists (select 1 from jsonb_array_elements_text(${settlementStatement.excludedPayments}) e where e like '%:RECONCILIATION_OPEN')`,
        ),
      )
      .orderBy(settlementStatement.createdAt, settlementStatement.id)
      .limit(limit);
    return rows.map(statementRecord);
  }

  async resolveExcludedPayment(o: { statementId: string; entry: string; resolvedEntry: string; caseRequest: SettlementCaseRequestRecord; at: Date }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // 그 항목이 아직 있을 때만 풀림 표시로 바꾼다(겹친 두 tick은 하나만 이긴다)
      const updated = await tx
        .update(settlementStatement)
        .set({
          excludedPayments: sql`(select coalesce(jsonb_agg(case when e = ${o.entry} then ${o.resolvedEntry} else e end), '[]'::jsonb) from jsonb_array_elements_text(${settlementStatement.excludedPayments}) e)`,
        })
        .where(and(eq(settlementStatement.id, o.statementId), sql`${settlementStatement.excludedPayments} @> ${JSON.stringify([o.entry])}::jsonb`))
        .returning({ id: settlementStatement.id });
      if (updated.length === 0) return false;
      await tx.insert(settlementCaseRequest).values(caseRequestValues(o.caseRequest)).onConflictDoNothing();
      return true;
    });
  }
}
