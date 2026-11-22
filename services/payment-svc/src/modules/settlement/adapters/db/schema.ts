// 정산·지급·KYC Drizzle 스키마(docs/data.md settlement_statement…payout, seller_kyc·payout_account 보조).
// 표의 정본은 migrations/0015_settlement.sql이다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });
const STATEMENT_STATUS = sql.raw("'CALCULATED', 'NOTIFIED', 'DISPUTED', 'CONFIRMED', 'HELD', 'SCHEDULED', 'FAILED', 'PAID', 'CARRIED_OVER', 'SUPERSEDED'");
const HOLD_REASON = sql.raw("'KYC', 'ACCOUNT_CHANGE', 'BALANCE', 'ACCOUNT_MISMATCH', 'SALE_SUSPENDED'");
const PG = sql.raw("'TOSS', 'PORTONE'");
const PG_STORE = sql.raw("'STANDARD', 'ESCROW'");

export const settlementStatement = pgTable(
  'settlement_statement',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    kind: text('kind').notNull(),
    eventId: uuid('event_id'),
    pg: text('pg').notNull(),
    pgStore: text('pg_store').notNull(),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    grossAmount: amount('gross_amount').notNull(),
    refundAmount: amount('refund_amount').notNull(),
    commissionAmount: amount('commission_amount').notNull(),
    commissionVat: amount('commission_vat').notNull(),
    offsetAmount: amount('offset_amount').notNull().default(0),
    payoutAmount: amount('payout_amount').notNull(),
    revision: integer('revision').notNull().default(1),
    supersedesId: uuid('supersedes_id'),
    excludedPayments: jsonb('excluded_payments').$type<string[]>().notNull().default([]),
    status: text('status').notNull(),
    holdReason: text('hold_reason'),
    disputeDueAt: at('dispute_due_at'),
    payoutDate: date('payout_date', { mode: 'string' }),
    payoutBankCode: text('payout_bank_code'),
    payoutAccountLast4: text('payout_account_last4'),
    payoutBatchId: uuid('payout_batch_id').references(() => payoutBatch.id),
    // 적용한 수기 조정의 합계(0027, settlement §4.3). 지급액 = 판매 대금 − 환급 − 수수료 − 부가세 − 상계 + 조정 합계
    adjustmentAmount: amount('adjustment_amount').notNull().default(0),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('settlement_statement_kind_check', sql`${t.kind} in ('EVENT', 'PRODUCT')`),
    check('settlement_statement_pg_check', sql`${t.pg} in (${PG})`),
    check('settlement_statement_pg_store_check', sql`${t.pgStore} in (${PG_STORE})`),
    check('settlement_statement_status_check', sql`${t.status} in (${STATEMENT_STATUS})`),
    check('settlement_statement_hold_reason_check', sql`${t.holdReason} is null or ${t.holdReason} in (${HOLD_REASON})`),
    check('settlement_statement_amounts_check', sql`${t.grossAmount} >= 0 and ${t.refundAmount} >= 0 and ${t.commissionAmount} >= 0 and ${t.commissionVat} >= 0 and ${t.offsetAmount} >= 0`),
    check('settlement_statement_revision_check', sql`${t.revision} >= 1`),
    uniqueIndex('settlement_statement_event_key')
      .on(t.promoterId, t.eventId, t.pg, t.pgStore)
      .where(sql`${t.kind} = 'EVENT' and ${t.status} <> 'SUPERSEDED'`),
    uniqueIndex('settlement_statement_product_key')
      .on(t.promoterId, t.pg, t.pgStore, t.periodStart, t.periodEnd)
      .where(sql`${t.kind} = 'PRODUCT' and ${t.status} <> 'SUPERSEDED'`),
    index('settlement_statement_partner_idx').on(t.promoterId, t.kind, t.createdAt, t.id),
    index('settlement_statement_event_idx').on(t.promoterId, t.eventId, t.createdAt),
    index('settlement_statement_payout_idx').on(t.pg, t.pgStore, t.payoutDate, t.status),
    index('settlement_statement_batch_idx').on(t.payoutBatchId),
  ],
);

export const statementSource = pgTable(
  'statement_source',
  {
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull(),
    kind: text('kind').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amount: amount('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.statementId, t.sourceId, t.kind] }),
    check('statement_source_kind_check', sql`${t.kind} in ('GROSS', 'REFUND')`),
    check('statement_source_amount_check', sql`${t.amount} >= 0`),
  ],
);

export const settlementStatementAudit = pgTable(
  'settlement_statement_audit',
  {
    id: uuid('id').primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('settlement_statement_audit_statement_idx').on(t.statementId, t.createdAt)],
);

export const statementDispute = pgTable(
  'statement_dispute',
  {
    id: uuid('id').primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id, { onDelete: 'cascade' }),
    reasonCode: text('reason_code').notNull(),
    detail: text('detail').notNull().default(''),
    submittedBy: uuid('submitted_by').notNull(),
    submittedAt: at('submitted_at').notNull(),
    result: text('result'),
    resolvedAt: at('resolved_at'),
    // 0027: 기각·인정한 관리 계정, 기각 사유(1~2,000자), CS 처리함 건을 연 시각(비면 정산 일꾼이 다시 보낸다, ADR-0368 결정 5·6)
    resolvedBy: uuid('resolved_by'),
    resolutionNote: text('resolution_note'),
    caseRequestedAt: at('case_requested_at'),
  },
  (t) => [
    check('statement_dispute_reason_check', sql`${t.reasonCode} in ('GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER')`),
    check('statement_dispute_result_check', sql`${t.result} is null or ${t.result} in ('ADJUSTED', 'DISMISSED')`),
    check('statement_dispute_resolution_note_check', sql`${t.resolutionNote} is null or char_length(${t.resolutionNote}) between 1 and 2000`),
    index('statement_dispute_statement_idx').on(t.statementId, t.submittedAt),
    index('statement_dispute_case_pending_idx').on(t.submittedAt).where(sql`${t.caseRequestedAt} is null and ${t.result} is null`),
  ],
);

/**
 * 정산서 수기 조정 행(0027, settlement §4.3, ADR-0368 결정 7·8). 원래 계산 칸은 고치지 않고 이 행과 정산서의 조정 합계로 더한다.
 * 승인 업무 하나에 행 하나(approval_id 유일), 한 정산서에 적용 전(PENDING) 조정은 하나(부분 유일)다.
 */
export const statementAdjustment = pgTable(
  'statement_adjustment',
  {
    id: uuid('id').primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id),
    approvalId: uuid('approval_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    disputeId: uuid('dispute_id').references(() => statementDispute.id),
    amount: amount('amount').notNull(),
    evidenceNote: text('evidence_note'),
    status: text('status').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: at('requested_at').notNull(),
    appliedAt: at('applied_at'),
  },
  (t) => [
    check(
      'statement_adjustment_reason_check',
      sql`${t.reasonCode} in ('GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER', 'LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION')`,
    ),
    check('statement_adjustment_amount_check', sql`${t.amount} <> 0`),
    check('statement_adjustment_status_check', sql`${t.status} in ('PENDING', 'APPLIED', 'VOID')`),
    check('statement_adjustment_note_check', sql`${t.evidenceNote} is null or char_length(${t.evidenceNote}) <= 2000`),
    check('statement_adjustment_applied_check', sql`(${t.status} = 'APPLIED') = (${t.appliedAt} is not null)`),
    uniqueIndex('statement_adjustment_approval_uidx').on(t.approvalId),
    uniqueIndex('statement_adjustment_pending_uidx').on(t.statementId).where(sql`${t.status} = 'PENDING'`),
    index('statement_adjustment_statement_idx').on(t.statementId, t.requestedAt),
  ],
);

export const payoutBatch = pgTable(
  'payout_batch',
  {
    id: uuid('id').primaryKey(),
    pg: text('pg').notNull(),
    pgStore: text('pg_store').notNull(),
    payoutDate: date('payout_date', { mode: 'string' }).notNull(),
    totalAmount: amount('total_amount').notNull(),
    statementCount: integer('statement_count').notNull(),
    approvalId: uuid('approval_id'),
    portoneBulkPayoutId: text('portone_bulk_payout_id'),
    pgBalanceKrw: amount('pg_balance_krw'),
    pgBalanceSource: text('pg_balance_source'),
    pgBalanceObservedAt: at('pg_balance_observed_at'),
    pgBalanceObservedBy: uuid('pg_balance_observed_by'),
    pgBalanceLedgerKrw: amount('pg_balance_ledger_krw'),
    status: text('status').notNull(),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('payout_batch_pg_check', sql`${t.pg} in (${PG})`),
    check('payout_batch_pg_store_check', sql`${t.pgStore} in (${PG_STORE})`),
    check('payout_batch_status_check', sql`${t.status} in ('PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'PARTIAL_FAILED')`),
    check('payout_batch_balance_source_check', sql`${t.pgBalanceSource} is null or ${t.pgBalanceSource} in ('PG_API', 'OPERATOR_CONSOLE')`),
    check('payout_batch_total_check', sql`${t.totalAmount} >= 0 and ${t.statementCount} >= 0`),
    uniqueIndex('payout_batch_key').on(t.pg, t.pgStore, t.payoutDate).where(sql`${t.status} not in ('COMPLETED', 'PARTIAL_FAILED')`),
    uniqueIndex('payout_batch_approval_uq').on(t.approvalId).where(sql`${t.approvalId} is not null`),
    index('payout_batch_list_idx').on(t.payoutDate, t.pg, t.pgStore, t.status),
  ],
);

/** 지급 묶음 승인 감사(0025). 성공은 배치 상태와 같은 트랜잭션, 거절은 상태를 바꾸지 않고 따로 쓴다. */
export const payoutBatchAudit = pgTable(
  'payout_batch_audit',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payoutBatch.id, { onDelete: 'cascade' }),
    approvalId: text('approval_id').notNull(),
    event: text('event').notNull(),
    reason: text('reason').notNull(),
    requesterId: text('requester_id'),
    approverId: text('approver_id'),
    amount: amount('amount'),
    currency: text('currency').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('payout_batch_audit_event_check', sql`${t.event} in ('APPROVED', 'REJECTED')`),
    check('payout_batch_audit_currency_check', sql`${t.currency} = 'KRW'`),
    index('payout_batch_audit_batch_idx').on(t.batchId, t.createdAt),
  ],
);

export const payout = pgTable(
  'payout',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => payoutBatch.id, { onDelete: 'cascade' }),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id),
    seq: integer('seq').notNull(),
    amount: amount('amount').notNull(),
    refPayoutId: text('ref_payout_id').notNull(),
    pgPayoutId: text('pg_payout_id'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    pgTransferId: text('pg_transfer_id'),
    transferCheck: text('transfer_check'),
    transferCheckedAt: at('transfer_checked_at'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('payout_ref_key').on(t.refPayoutId),
    uniqueIndex('payout_batch_statement_seq_key').on(t.batchId, t.statementId, t.seq),
    check('payout_status_check', sql`${t.status} in ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELED')`),
    check('payout_amount_check', sql`${t.amount} > 0`),
    check('payout_seq_check', sql`${t.seq} >= 1`),
    check('payout_transfer_check_check', sql`${t.transferCheck} is null or ${t.transferCheck} in ('MATCHED', 'MISMATCH', 'MISSING')`),
    index('payout_batch_idx').on(t.batchId, t.seq),
  ],
);

export const sellerKyc = pgTable(
  'seller_kyc',
  {
    promoterId: uuid('promoter_id').primaryKey(),
    status: text('status').notNull(),
    businessVerified: boolean('business_verified').notNull().default(false),
    representativeVerified: boolean('representative_verified').notNull().default(false),
    legalName: text('legal_name'),
    representative: text('representative'),
    verifiedAt: at('verified_at'),
    source: text('source').notNull().default('MANUAL'),
    /** 토스 셀러 ID·상태(0026). seller.changed가 바꾸고 KYC 예고가 본다 */
    tossSellerId: text('toss_seller_id'),
    tossSellerStatus: text('toss_seller_status').notNull().default('PENDING'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('seller_kyc_status_check', sql`${t.status} in ('PENDING', 'VERIFIED', 'REJECTED')`),
    check('seller_kyc_source_check', sql`${t.source} in ('MANUAL', 'TOSS', 'PORTONE')`),
    check('seller_kyc_toss_seller_status_check', sql`${t.tossSellerStatus} in ('PENDING', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED')`),
    uniqueIndex('seller_kyc_toss_seller_id_uidx').on(t.tossSellerId).where(sql`${t.tossSellerId} is not null`),
  ],
);

export const payoutAccount = pgTable(
  'payout_account',
  {
    promoterId: uuid('promoter_id').primaryKey(),
    bankCode: text('bank_code').notNull(),
    accountLast4: text('account_last4').notNull(),
    version: integer('version').notNull().default(1),
    changedAt: at('changed_at').notNull(),
    holdUntil: at('hold_until').notNull(),
    holderVerified: boolean('holder_verified').notNull().default(false),
  },
  (t) => [check('payout_account_version_check', sql`${t.version} >= 1`)],
);

export const partnerReceivable = pgTable(
  'partner_receivable',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    // 배상금 미리 지급(COMPENSATION_ADVANCE)은 결제사 무관이라 null이다(ADR-0317)
    pg: text('pg'),
    cause: text('cause').notNull(),
    eventId: uuid('event_id'),
    sourceRef: text('source_ref'),
    amount: amount('amount').notNull(),
    remaining: amount('remaining').notNull(),
    status: text('status').notNull().default('OPEN'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('partner_receivable_pg_check', sql`${t.pg} is null or ${t.pg} in (${PG})`),
    check('partner_receivable_cause_check', sql`${t.cause} in ('REFUND_AFTER_PAYOUT', 'CHARGEBACK', 'COMPENSATION_ADVANCE', 'NEGATIVE_STATEMENT')`),
    check('partner_receivable_status_check', sql`${t.status} in ('OPEN', 'OFFSET', 'GUARANTEE', 'BILLED', 'CLOSED', 'WRITTEN_OFF')`),
    check('partner_receivable_amount_check', sql`${t.amount} >= 0 and ${t.remaining} >= 0 and ${t.remaining} <= ${t.amount}`),
    index('partner_receivable_open_idx').on(t.promoterId, t.pg, t.status, t.createdAt),
    // 배상 미수금 하나에 source_ref 하나(0024). 다른 원천은 null이라 걸리지 않는다
    uniqueIndex('partner_receivable_source_ref_uidx').on(t.sourceRef).where(sql`${t.sourceRef} is not null`),
  ],
);

export const receivableMove = pgTable(
  'receivable_move',
  {
    /** 0026: 한 정산서에 상계·보증 충당이 함께 붙을 수 있어 (미수금, 정산서) 대신 이동 ID를 기본 키로 쓴다 */
    id: uuid('id').defaultRandom().primaryKey(),
    receivableId: uuid('receivable_id')
      .notNull()
      .references(() => partnerReceivable.id),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatement.id),
    amount: amount('amount').notNull(),
    kind: text('kind').notNull().default('OFFSET'),
    movedAt: at('moved_at').notNull(),
  },
  (t) => [
    index('receivable_move_receivable_idx').on(t.receivableId, t.movedAt),
    check('receivable_move_amount_check', sql`${t.amount} > 0`),
    check('receivable_move_kind_check', sql`${t.kind} in ('OFFSET', 'GUARANTEE', 'COLLECTED', 'WRITE_OFF', 'REVERSAL')`),
  ],
);

export const guaranteeCollection = pgTable(
  'guarantee_collection',
  {
    id: uuid('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    receivableId: uuid('receivable_id')
      .notNull()
      .references(() => partnerReceivable.id),
    promoterId: uuid('promoter_id').notNull(),
    guaranteeKind: text('guarantee_kind').notNull(),
    amount: amount('amount').notNull(),
    basisAmount: amount('basis_amount').notNull(),
    guaranteeRateBp: integer('guarantee_rate_bp').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('guarantee_collection_key_uidx').on(t.idempotencyKey),
    check('guarantee_collection_kind_check', sql`${t.guaranteeKind} in ('DEPOSIT', 'PERFORMANCE_BOND')`),
    check('guarantee_collection_amount_check', sql`${t.amount} > 0 and ${t.basisAmount} >= 0 and ${t.guaranteeRateBp} between 0 and 10000`),
  ],
);

export const settlementWebhookReceipt = pgTable('settlement_webhook_receipt', {
  transmissionId: text('transmission_id').primaryKey(),
  receivedAt: at('received_at').notNull(),
});
