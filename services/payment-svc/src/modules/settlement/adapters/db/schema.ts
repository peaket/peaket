// 정산·지급·KYC Drizzle 스키마(docs/data.md settlement_statement…payout, seller_kyc·payout_account 보조).
// 표의 정본은 migrations/0015_settlement.sql이다.
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });
const STATEMENT_STATUS = sql.raw("'CALCULATED', 'NOTIFIED', 'DISPUTED', 'CONFIRMED', 'HELD', 'SCHEDULED', 'FAILED', 'PAID', 'CARRIED_OVER', 'SUPERSEDED'");
// RECALCULATION: 회차 취소·연기 환급의 다시 계산 대기(0033, ADR-0380 결정 4)
const HOLD_REASON = sql.raw("'KYC', 'ACCOUNT_CHANGE', 'BALANCE', 'ACCOUNT_MISMATCH', 'SALE_SUSPENDED', 'RECALCULATION'");
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
    // 계산 때 쓴 고정 수수료율(만분율, 0033). 0033 이전 행은 null. 다시 계산·계산 뒤 환급 미수금이 쓴다(F-07-8, ADR-0380 결정 5·6)
    commissionRateBp: integer('commission_rate_bp'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('settlement_statement_commission_rate_check', sql`${t.commissionRateBp} is null or ${t.commissionRateBp} between 0 and 10000`),
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
    // 0030: ops CS 건 받기 거절 수와 영구 실패 시각(거절 3번 [가정]째, F-07-7 계획 §5.1 (파) (마)). 일시 실패는 세지 않는다
    caseRefusedCount: integer('case_refused_count').notNull().default(0),
    caseFailedAt: at('case_failed_at'),
  },
  (t) => [
    check('statement_dispute_reason_check', sql`${t.reasonCode} in ('GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER')`),
    // SUPERSEDED: 다시 계산으로 옛 판이 바뀌어 닫힘(0033, ADR-0380 결정 6)
    check('statement_dispute_result_check', sql`${t.result} is null or ${t.result} in ('ADJUSTED', 'DISMISSED', 'SUPERSEDED')`),
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
    /** 정산서별 지급 대상 지문(0040, settlement §5.1). 옛 행은 null */
    payeeDigest: text('payee_digest'),
    /** 토스 전송 시도 수·다음 전송 시각·자동 전송 마감·마지막 전송 결과 이름표·날짜 오류 한 번 재요청(0029, ADR-0369 결정 7) */
    submitAttempts: integer('submit_attempts').notNull().default(0),
    nextSubmitAt: at('next_submit_at'),
    submitDeadlineAt: at('submit_deadline_at'),
    lastSubmitError: text('last_submit_error'),
    dateRetryUsed: boolean('date_retry_used').notNull().default(false),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('payout_batch_pg_check', sql`${t.pg} in (${PG})`),
    check('payout_batch_submit_attempts_check', sql`${t.submitAttempts} >= 0`),
    check('payout_batch_last_submit_error_check', sql`${t.lastSubmitError} is null or char_length(${t.lastSubmitError}) <= 200`),
    index('payout_batch_next_submit_idx').on(t.nextSubmitAt).where(sql`${t.nextSubmitAt} is not null`),
    check('payout_batch_pg_store_check', sql`${t.pgStore} in (${PG_STORE})`),
    check('payout_batch_status_check', sql`${t.status} in ('PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'PARTIAL_FAILED', 'EXPIRED')`),
    check('payout_batch_payee_digest_check', sql`${t.payeeDigest} is null or ${t.payeeDigest} ~ '^[0-9a-f]{64}$'`),
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
    /** 승인 시점의 지급 대상 지문(F-06-3, 0040). 옛 행은 null */
    payeeDigest: text('payee_digest'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('payout_batch_audit_event_check', sql`${t.event} in ('APPROVED', 'REJECTED', 'EXPIRED')`),
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
    /** 예약 지급일·실패 갈래·대신한 실패 지급 건·자동 재요청 수(0029, ADR-0369 결정 8) */
    payoutDate: date('payout_date', { mode: 'string' }).notNull(),
    failureClass: text('failure_class'),
    retryOfPayoutId: uuid('retry_of_payout_id').references((): AnyPgColumn => payout.id),
    autoRetryCount: integer('auto_retry_count').notNull().default(0),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('payout_failure_class_check', sql`${t.failureClass} is null or ${t.failureClass} in ('ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN')`),
    check('payout_auto_retry_count_check', sql`${t.autoRetryCount} >= 0`),
    index('payout_unfinished_idx').on(t.status).where(sql`${t.status} in ('REQUESTED', 'IN_PROGRESS')`),
    index('payout_retry_of_idx').on(t.retryOfPayoutId).where(sql`${t.retryOfPayoutId} is not null`),
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
    /** 결제사 수정 대기(0030, ADR-0370 결정 5). 계좌 변경에서 한 곳이라도 실패하면 true이고 보류가 끝나도 지급하지 않는다 */
    agencySyncPending: boolean('agency_sync_pending').notNull().default(false),
  },
  (t) => [check('payout_account_version_check', sql`${t.version} >= 1`)],
);

/** 정산 계좌 변경 시도 한 번(0030, ADR-0370 결정 5). 덧붙이기만 하고 계좌번호·예금주명은 없다 */
export const payoutAccountChange = pgTable(
  'payout_account_change',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    actorAccountId: uuid('actor_account_id').notNull(),
    reauthJti: text('reauth_jti').notNull(),
    /** 그 시도의 재인증 요소(ops 감사 본문 reauthFactors) */
    reauthFactors: text('reauth_factors').array().notNull().default(sql`'{}'::text[]`),
    result: text('result').notNull(),
    bankCode: text('bank_code').notNull(),
    accountLast4: text('account_last4').notNull(),
    holdUntil: at('hold_until'),
    agencyResults: jsonb('agency_results').notNull(),
    createdAt: at('created_at').notNull(),
    auditSentAt: at('audit_sent_at'),
    auditRefusedCount: integer('audit_refused_count').notNull().default(0),
    auditFailedAt: at('audit_failed_at'),
  },
  (t) => [
    uniqueIndex('payout_account_change_reauth_jti_uidx').on(t.reauthJti),
    check('payout_account_change_result_check', sql`${t.result} in ('ACCEPTED', 'HOLDER_MISMATCH', 'AGENCY_FAILED')`),
    check('payout_account_change_account_last4_check', sql`${t.accountLast4} ~ '^[0-9]{4}$'`),
    check('payout_account_change_audit_refused_count_check', sql`${t.auditRefusedCount} >= 0`),
    index('payout_account_change_unsent_idx').on(t.createdAt).where(sql`${t.auditSentAt} is null and ${t.auditFailedAt} is null`),
    index('payout_account_change_promoter_idx').on(t.promoterId, t.createdAt),
  ],
);

/** 포트원 파트너 등록(0030, ADR-0370 결정 1). 계좌번호는 두지 않는다 */
export const portonePartner = pgTable(
  'portone_partner',
  {
    promoterId: uuid('promoter_id').primaryKey(),
    portonePartnerId: text('portone_partner_id').notNull(),
    contractId: text('contract_id').notNull(),
    registeredAt: at('registered_at').notNull(),
    accountUpdatedAt: at('account_updated_at').notNull(),
    /** 마지막 파트너 계좌 대조(0032, ADR-0370 결정 8 ②) */
    lastAccountCheck: text('last_account_check'),
    lastAccountCheckedAt: at('last_account_checked_at'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('portone_partner_portone_partner_id_uidx').on(t.portonePartnerId),
    check('portone_partner_last_account_check_check', sql`${t.lastAccountCheck} is null or ${t.lastAccountCheck} in ('MATCHED', 'MISMATCH')`),
  ],
);

/** 포트원 이체 원장의 출금 하나(0032, settlement §5.3, ADR-0370 결정 8 ①). 겹쳐 읽어도 한 행. 계좌번호 전체·예금주명은 없다 */
export const portoneTransfer = pgTable(
  'portone_transfer',
  {
    transferId: text('transfer_id').primaryKey(),
    withdrawalType: text('withdrawal_type'),
    payoutId: uuid('payout_id').references(() => payout.id),
    amount: amount('amount').notNull(),
    bankCode: text('bank_code'),
    accountLast4: text('account_last4'),
    holderMatched: boolean('holder_matched'),
    checkResult: text('check_result').notNull(),
    transferredAt: at('transferred_at').notNull(),
    checkedAt: at('checked_at').notNull(),
  },
  (t) => [
    check('portone_transfer_check_result_check', sql`${t.checkResult} in ('MATCHED', 'MISMATCH', 'UNLINKED')`),
    check('portone_transfer_account_last4_check', sql`${t.accountLast4} is null or ${t.accountLast4} ~ '^[0-9]{4}$'`),
    index('portone_transfer_payout_idx').on(t.payoutId).where(sql`${t.payoutId} is not null`),
  ],
);

/** 포트원 사후 대사 진행(0032, ADR-0370 결정 8 ④) */
export const portoneLedgerSync = pgTable(
  'portone_ledger_sync',
  {
    name: text('name').primaryKey(),
    lastSuccessAt: at('last_success_at'),
    readThrough: at('read_through'),
    haltedOn: date('halted_on', { mode: 'string' }),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [check('portone_ledger_sync_name_check', sql`${t.name} in ('WITHDRAWAL', 'PARTNER_ACCOUNT')`)],
);

/** 운영 경보 요청(0032, ADR-0370 결정 8). 원인 쓰기와 같은 트랜잭션에 넣고 정산 일꾼이 보낸 뒤 requested_at을 채운다 */
export const settlementAlertRequest = pgTable(
  'settlement_alert_request',
  {
    eventKey: text('event_key').primaryKey(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    sourceId: text('source_id').notNull(),
    createdAt: at('created_at').notNull(),
    requestedAt: at('requested_at'),
    refusedCount: integer('refused_count').notNull().default(0),
    failedAt: at('failed_at'),
    lastRefusal: text('last_refusal'),
  },
  (t) => [
    check('settlement_alert_request_severity_check', sql`${t.severity} in ('SEV2', 'SEV3')`),
    check('settlement_alert_request_refused_count_check', sql`${t.refusedCount} >= 0`),
    check('settlement_alert_request_last_refusal_check', sql`${t.lastRefusal} is null or ${t.lastRefusal} in ('NOT_ACCEPTED', 'HTTP_400', 'HTTP_422')`),
    index('settlement_alert_request_unsent_idx').on(t.createdAt).where(sql`${t.requestedAt} is null and ${t.failedAt} is null`),
  ],
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

/** 미수금 이동 기록(docs/data.md ERD receivable_movement). 0028이 옛 이름 receivable_move에서 바꿨다(FIX-invariant-m3) */
export const receivableMovement = pgTable(
  'receivable_movement',
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
    // REVERSAL이 되돌린 이동 기록(0033, docs/data.md receivable_movement). 외래 키는 걸지 않는다(F-07-8 U-R5)
    reversesId: uuid('reverses_id'),
  },
  (t) => [
    index('receivable_movement_receivable_idx').on(t.receivableId, t.movedAt),
    check('receivable_movement_amount_check', sql`${t.amount} > 0`),
    // SUPERSEDED: 다시 계산으로 옛 판의 NEGATIVE_STATEMENT 미수금을 남은 금액만큼 닫음(0033, ADR-0380 결정 8). 제약 이름은 그대로다(PRF180 M3 ⑦)
    check('receivable_movement_kind_check', sql`${t.kind} in ('OFFSET', 'GUARANTEE', 'COLLECTED', 'WRITE_OFF', 'REVERSAL', 'SUPERSEDED')`),
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

export const settlementWebhookReceipt = pgTable(
  'settlement_webhook_receipt',
  {
    transmissionId: text('transmission_id').primaryKey(),
    /** 본문 eventId. 정산 웹훅 중복 제거는 이 칸으로 한다(0029, ADR-0369 결정 14). 옛 행은 null */
    eventId: text('event_id'),
    receivedAt: at('received_at').notNull(),
  },
  (t) => [uniqueIndex('settlement_webhook_receipt_event_id_uidx').on(t.eventId).where(sql`${t.eventId} is not null`)],
);

/** 파트너·결제 상점별 토스 셀러(0029, ADR-0369 결정 3). 계좌 칸은 두지 않는다 */
export const tossSeller = pgTable(
  'toss_seller',
  {
    promoterId: uuid('promoter_id').notNull(),
    pgStore: text('pg_store').notNull(),
    tossSellerId: text('toss_seller_id').notNull(),
    refSellerId: text('ref_seller_id').notNull(),
    status: text('status').notNull(),
    businessType: text('business_type').notNull(),
    registeredAt: at('registered_at').notNull(),
    statusCheckedAt: at('status_checked_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.promoterId, t.pgStore] }),
    uniqueIndex('toss_seller_toss_seller_id_uidx').on(t.tossSellerId),
    uniqueIndex('toss_seller_ref_seller_id_uidx').on(t.refSellerId),
    check('toss_seller_pg_store_check', sql`${t.pgStore} in (${PG_STORE})`),
    check('toss_seller_status_check', sql`${t.status} in ('PENDING', 'APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED')`),
    check('toss_seller_business_type_check', sql`${t.businessType} in ('INDIVIDUAL_BUSINESS', 'CORPORATE')`),
  ],
);

/** 지급 건 재요청 기록(0029, 덧붙이기만, ADR-0369 결정 8) */
export const payoutRetryAudit = pgTable(
  'payout_retry_audit',
  {
    id: uuid('id').primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payout.id),
    newPayoutId: uuid('new_payout_id')
      .notNull()
      .references(() => payout.id),
    oldSeq: integer('old_seq').notNull(),
    newSeq: integer('new_seq').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('payout_retry_audit_reason_check', sql`${t.reason} in ('ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN', 'DATE_ERROR')`),
    index('payout_retry_audit_payout_idx').on(t.payoutId, t.createdAt),
  ],
);

/** 지급 쪽 CS 처리함 건 요청(0029, ADR-0369 결정 10). 원인 쓰기와 같은 트랜잭션에 넣는다 */
export const settlementCaseRequest = pgTable(
  'settlement_case_request',
  {
    eventKey: text('event_key').primaryKey(),
    kind: text('kind').notNull(),
    sourceId: text('source_id').notNull(),
    createdAt: at('created_at').notNull(),
    requestedAt: at('requested_at'),
    /** 건 본문 글(선택, 1~2,000자, 0030). 다시 보낼 때 같은 글을 싣는다 */
    detail: text('detail'),
    /** ops 받기 거절 수·영구 실패 시각·마지막 거절 까닭(0030, F-07-7 계획 §5.1 (파) (마)) */
    refusedCount: integer('refused_count').notNull().default(0),
    failedAt: at('failed_at'),
    lastRefusal: text('last_refusal'),
  },
  (t) => [
    // SETTLEMENT_ADJUSTMENT_SUGGESTED: 대사 불일치로 뺀 결제가 풀린 뒤의 조정 제안(0033, ADR-0380 결정 7)
    check(
      'settlement_case_request_kind_check',
      sql`${t.kind} in ('PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH', 'PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'SETTLEMENT_ADJUSTMENT_SUGGESTED')`,
    ),
    check('settlement_case_request_detail_check', sql`${t.detail} is null or char_length(${t.detail}) between 1 and 2000`),
    check('settlement_case_request_refused_count_check', sql`${t.refusedCount} >= 0`),
    check('settlement_case_request_last_refusal_check', sql`${t.lastRefusal} is null or ${t.lastRefusal} in ('NOT_ACCEPTED', 'HTTP_400', 'HTTP_422')`),
    index('settlement_case_request_unsent_idx').on(t.createdAt).where(sql`${t.requestedAt} is null and ${t.failedAt} is null`),
  ],
);

/** 결제사 잔액 대사(0029, settlement §5.5, ADR-0369 결정 11) */
export const pgBalanceReconciliation = pgTable(
  'pg_balance_reconciliation',
  {
    id: uuid('id').primaryKey(),
    pg: text('pg').notNull(),
    pgStore: text('pg_store').notNull(),
    kind: text('kind').notNull(),
    periodMonth: date('period_month', { mode: 'string' }),
    batchId: uuid('batch_id'),
    cutoffAt: at('cutoff_at').notNull(),
    approvedAmount: amount('approved_amount').notNull(),
    refundedAmount: amount('refunded_amount').notNull(),
    pgFeeAmount: amount('pg_fee_amount').notNull(),
    paidOutAmount: amount('paid_out_amount').notNull(),
    peaketWithdrawnAmount: amount('peaket_withdrawn_amount').notNull(),
    expectedAmount: amount('expected_amount').notNull(),
    observedAmount: amount('observed_amount').notNull(),
    diffAmount: amount('diff_amount').notNull(),
    severity: text('severity').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('pg_balance_reconciliation_pg_check', sql`${t.pg} in (${PG})`),
    check('pg_balance_reconciliation_pg_store_check', sql`${t.pgStore} in (${PG_STORE})`),
    check('pg_balance_reconciliation_kind_check', sql`${t.kind} in ('MONTHLY', 'BATCH')`),
    check('pg_balance_reconciliation_severity_check', sql`${t.severity} in ('NONE', 'CASE', 'SEV3')`),
    uniqueIndex('pg_balance_reconciliation_month_uidx').on(t.pg, t.pgStore, t.periodMonth).where(sql`${t.kind} = 'MONTHLY'`),
    uniqueIndex('pg_balance_reconciliation_batch_uidx').on(t.batchId).where(sql`${t.kind} = 'BATCH'`),
    index('pg_balance_reconciliation_last_idx').on(t.pg, t.pgStore, t.cutoffAt),
  ],
);

/**
 * 회차 취소·연기 환급의 다시 계산 진행(0033, docs/data.md settlement_recalculation, ADR-0380). 요청 ID가 멱등 키다.
 * PENDING 동안 그 회차 정산서는 지급 묶음에서 HELD(RECALCULATION)이고 계산 뒤 환급 미수금을 만들지 않는다
 */
export const settlementRecalculation = pgTable(
  'settlement_recalculation',
  {
    requestId: uuid('request_id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    confirmedAt: at('confirmed_at').notNull(),
    openedAt: at('opened_at').notNull(),
    completedAt: at('completed_at'),
    partial: boolean('partial').notNull().default(false),
    // 보류 열기·다시 하기가 HELD(RECALCULATION)로 둔 정산서(같은 요청 ID를 다시 열 때 같은 답을 주려고 남긴다)
    heldStatementIds: jsonb('held_statement_ids').$type<string[]>().notNull().default([]),
    skippedStatementIds: jsonb('skipped_statement_ids').$type<string[]>().notNull().default([]),
    retryStatementIds: jsonb('retry_statement_ids').$type<string[]>().notNull().default([]),
    result: jsonb('result'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('settlement_recalculation_kind_check', sql`${t.kind} in ('CANCEL', 'POSTPONE')`),
    check('settlement_recalculation_state_check', sql`${t.state} in ('PENDING', 'DONE')`),
    index('settlement_recalculation_pending_idx').on(t.eventId).where(sql`${t.state} = 'PENDING'`),
  ],
);

/** 계산 뒤 환급 미수금 훑기의 읽은 자리(0033, docs/data.md settlement_refund_scan, ADR-0380 결정 5). (끝난 시각, 결제 ID) 열쇠다 */
export const settlementRefundScan = pgTable(
  'settlement_refund_scan',
  {
    name: text('name').primaryKey(),
    readThrough: at('read_through').notNull(),
    // 같은 시각의 결제를 나눠 읽을 때 마지막으로 본 결제 ID(빈 글은 그 시각 처음부터)
    readThroughPaymentId: text('read_through_payment_id').notNull().default(''),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [check('settlement_refund_scan_name_check', sql`${t.name} in ('EVENT_REFUND')`)],
);
