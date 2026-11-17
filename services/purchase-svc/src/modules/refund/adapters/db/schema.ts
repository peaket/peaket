// purchase DB의 회차 취소 일괄 환불 표(BAT-425 GAT-120·GAT-130, docs/features/transfer-refund.md §5).
// drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다. 상태 목록은 도메인 상수와 같은 차례로 글로 적는다.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const eventCancellationRequest = pgTable(
  'event_cancellation_request',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    fault: text('fault'),
    fanNoticeReason: text('fan_notice_reason'),
    postponedTo: at('postponed_to'),
    refundWindowClosesAt: at('refund_window_closes_at'),
    ruledBy: text('ruled_by'),
    confirmedBy: text('confirmed_by'),
    targetOrders: integer('target_orders').notNull().default(0),
    refundTotal: integer('refund_total').notNull().default(0),
    compensationTargets: integer('compensation_targets').notNull().default(0),
    compensationTotal: integer('compensation_total').notNull().default(0),
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('event_cancellation_active_key')
      .on(t.eventId)
      .where(sql`${t.status} in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW')`),
    check('event_cancellation_kind_check', sql`${t.kind} in ('CANCEL', 'POSTPONE')`),
    check(
      'event_cancellation_status_check',
      sql`${t.status} in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED')`,
    ),
    check('event_cancellation_fault_check', sql`${t.fault} is null or ${t.fault} in ('ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE')`),
    check('event_cancellation_amounts_check', sql`${t.targetOrders} >= 0 and ${t.refundTotal} >= 0 and ${t.compensationTargets} >= 0 and ${t.compensationTotal} >= 0`),
    check('event_cancellation_people_check', sql`${t.ruledBy} is null or ${t.confirmedBy} is null or ${t.ruledBy} <> ${t.confirmedBy}`),
    check('event_cancellation_window_check', sql`${t.refundWindowClosesAt} is null or ${t.postponedTo} is null or ${t.refundWindowClosesAt} <= ${t.postponedTo}`),
  ],
);

/**
 * 회차 취소 요청 중 보류 취소의 환급 미룸(BAT-420 몫 D, OPEN[45], docs/data.md event_refund_hold). 회차 하나에 한 줄이다.
 * 풀리지 않았고(released_at 빔) 기한 안(expires_at > 지금)이면 그 회차의 마감 뒤 환급(REQUESTED)을 집지 않는다
 */
export const eventRefundHold = pgTable(
  'event_refund_hold',
  {
    eventId: uuid('event_id').primaryKey(),
    cancellationRequestId: uuid('cancellation_request_id').notNull(),
    heldAt: at('held_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    releasedAt: at('released_at'),
  },
  (t) => [check('event_refund_hold_expires_check', sql`${t.expiresAt} > ${t.heldAt}`)],
);

export const eventRefundItem = pgTable(
  'event_refund_item',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => eventCancellationRequest.id),
    ticketId: uuid('ticket_id').notNull(),
    orderId: uuid('order_id').notNull(),
    cancellationId: uuid('cancellation_id').notNull(),
    pg: text('pg').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    appliedAt: at('applied_at'),
    nextAttemptAt: at('next_attempt_at'),
    updatedAt: at('updated_at').notNull(),
    /** 주문 단위로 잡은 처리자의 무작위 값(0025, 웨이브 끝 리뷰 K2). 잡은 쪽만 처리하고 끝내기는 이 값이 같고 상태가 PENDING·UNKNOWN일 때만 쓴다 */
    claimToken: uuid('claim_token'),
    /** 잡기 기한(지금 + 60초 [가정]). 지나면(claimed_until <= 지금) 다른 처리자가 다시 잡는다 */
    claimedUntil: at('claimed_until'),
    /** 일괄 환불 실패 CS 건을 열 대상으로 정한 시각(0026, 다시 보기 2 N2). 항목을 FAILED로 끝내는 쓰기와 같은 트랜잭션에서 쓰고, 차액 건으로 대신한 항목에는 쓰지 않는다 */
    failureCaseAt: at('failure_case_at'),
    /** 그 건을 ops-svc가 2xx로 받은 시각. failure_case_at이 있는데 비어 있으면 일괄 환불 실행기 틱 끝에 다시 연다. failure_case_at 없이 쓰지 않는다(CHECK) */
    failureCaseOpenedAt: at('failure_case_opened_at'),
  },
  (t) => [
    primaryKey({ name: 'event_refund_item_pkey', columns: [t.requestId, t.ticketId] }),
    uniqueIndex('event_refund_item_cancellation_key').on(t.cancellationId),
    index('event_refund_item_status_idx').on(t.requestId, t.status),
    index('event_refund_item_due_idx').on(t.status, t.nextAttemptAt),
    check('event_refund_item_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('event_refund_item_status_check', sql`${t.status} in ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN', 'NOT_APPLIED')`),
    check('event_refund_item_attempts_check', sql`${t.attempts} >= 0`),
    // 잡기 값과 기한은 함께 있거나 함께 없다(0025)
    check('event_refund_item_claim_check', sql`(${t.claimToken} is null) = (${t.claimedUntil} is null)`),
    // 연 시각은 열 대상 표시가 있을 때만 쓴다(0026)
    check('event_refund_item_failure_case_check', sql`${t.failureCaseOpenedAt} is null or ${t.failureCaseAt} is not null`),
    // 일괄 환불 실패 건 다시 열기 목록(열지 않은 건)을 받치는 부분 색인(0026)
    index('event_refund_item_failure_case_open_idx')
      .on(t.failureCaseAt)
      .where(sql`${t.failureCaseAt} is not null and ${t.failureCaseOpenedAt} is null`),
  ],
);

export const eventRefundAttempt = pgTable(
  'event_refund_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    pg: text('pg').notNull(),
    amount: integer('amount').notNull(),
    outcome: text('outcome').notNull(),
    attemptedAt: at('attempted_at').notNull(),
  },
  (t) => [
    index('event_refund_attempt_pg_time_idx').on(t.pg, t.attemptedAt),
    check('event_refund_attempt_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('event_refund_attempt_outcome_check', sql`${t.outcome} in ('SUCCESS', 'FAILURE', 'REJECT', 'UNKNOWN')`),
    check('event_refund_attempt_amount_check', sql`${t.amount} >= 0`),
  ],
);

/**
 * 부정 예매 운영자 취소의 승인 단위 요청(0022, BUILD_ORDER GAT-080, docs/data.md fraud_cancellation_request, docs/features/transfer-refund.md §7.4).
 * approval_id가 CancelFraudTickets의 멱등키다. 같은 승인 ID에 다른 지문(targets_hash)이면 ALREADY_EXISTS다
 */
export const fraudCancellationRequest = pgTable(
  'fraud_cancellation_request',
  {
    approvalId: uuid('approval_id').primaryKey(),
    // ops 사건 ID(다른 논리 DB라 외래키 없음)
    fraudCaseId: uuid('fraud_case_id').notNull(),
    eventId: uuid('event_id').notNull(),
    // 사건 ID·회차·(표 ID, 기대 보유자)를 표 ID 순으로 늘어놓은 SHA-256 hex
    targetsHash: text('targets_hash').notNull(),
    requestedBy: text('requested_by').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvedAt: at('approved_at'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [check('fraud_cancellation_request_actors_check', sql`${t.requestedBy} <> ${t.approvedBy}`)],
);

/** 부정 예매 운영자 취소의 표별 결과(0022). 기본 키 (approval_id, ticket_id)가 표 단위 멱등이다. FAILED만 다시 부르기에서 다시 한다 */
export const fraudCancellationTicket = pgTable(
  'fraud_cancellation_ticket',
  {
    approvalId: uuid('approval_id')
      .notNull()
      .references(() => fraudCancellationRequest.approvalId),
    ticketId: uuid('ticket_id').notNull(),
    expectedHolderAccountId: uuid('expected_holder_account_id').notNull(),
    outcome: text('outcome').notNull(),
    // ACCEPTED일 때 order_cancellation.id(승인·표에서 정해지는 UUID)
    cancellationId: uuid('cancellation_id'),
    // ACCEPTED일 때 공제 없는 환급액(권면 금액)
    refundAmount: integer('refund_amount'),
    // 시스템이 거둔 양도 요청 ID(transfer_offer 표가 생기기 전에는 비운다)
    withdrawnTransferOfferId: text('withdrawn_transfer_offer_id'),
    // FAILED일 때의 까닭(개인정보 없음)
    failureCode: text('failure_code'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.approvalId, t.ticketId] }),
    check('fraud_cancellation_ticket_outcome_check', sql`${t.outcome} in ('ACCEPTED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_STARTED', 'SKIPPED_HOLDER_CHANGED', 'FAILED')`),
    check('fraud_cancellation_ticket_failure_code_check', sql`${t.failureCode} in ('TICKET_UNAVAILABLE', 'SEAT_RETURN_FAILED', 'CANCELLATION_CONFLICT', 'ORDER_STATE', 'INTERNAL')`),
    check('fraud_cancellation_ticket_refund_amount_check', sql`${t.refundAmount} >= 0`),
    check('fraud_cancellation_ticket_accepted_check', sql`(${t.outcome} = 'ACCEPTED') = (${t.cancellationId} is not null)`),
    check('fraud_cancellation_ticket_failed_check', sql`(${t.outcome} = 'FAILED') = (${t.failureCode} is not null)`),
  ],
);
