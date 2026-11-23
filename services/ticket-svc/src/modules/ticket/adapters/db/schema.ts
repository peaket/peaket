// ticket DB 스키마(BUILD_ORDER HOT-160, docs/data.md §2 `ticket`·`ticket_cancellation`, docs/features/payment.md §2·§4.1).
// 마이그레이션은 migrations/0000_ticket.sql이다. 다른 논리 DB의 주문·좌석 ID에는 외래키를 걸지 않는다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 발권 세대 단위 멱등 기록. 같은 (order_id, issue_generation)은 한 번만 발권한다. */
export const ticketIssue = pgTable(
  'ticket_issue',
  {
    orderId: uuid('order_id').notNull(),
    issueGeneration: bigint('issue_generation', { mode: 'number' }).notNull(),
    eventId: uuid('event_id').notNull(),
    payerAccountId: uuid('payer_account_id').notNull(),
    /** 발권 내용(좌석·회차·결제자·세대)의 SHA-256. 같은 세대에 다른 내용이면 거절한다. */
    fingerprint: text('fingerprint').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.issueGeneration] })],
);

/**
 * 주문 단위 발권 막기(BAT-011, HOT-161·PRF-173, 0011, docs/data.md ticket_issue_guard).
 * IssueTickets와 BlockTicketIssuance가 이 행을 먼저 잠가 같은 주문의 발권과 막기를 한 차례로 가른다.
 * blocked_at이 비어 있으면 아직 막지 않은 잠금 자리이고(발권이 먼저 만든다), 값이 있으면 막힌 주문이다
 */
export const ticketIssueGuard = pgTable('ticket_issue_guard', {
  orderId: uuid('order_id').primaryKey(),
  blockedAt: at('blocked_at'),
  /** 막은 사유(감사·로그용). 없을 수 있다 */
  reason: text('reason'),
});

/** 티켓. docs/data.md `ticket`의 최소 칸만 둔다. 상태는 이 구현이 쓰는 네 값만 CHECK로 막는다. */
export const ticket = pgTable(
  'ticket',
  {
    id: uuid('id').primaryKey(),
    /** 보유자. 처음에는 결제자다. */
    accountId: uuid('account_id').notNull(),
    payerAccountId: uuid('payer_account_id').notNull(),
    orderId: uuid('order_id').notNull(),
    eventId: uuid('event_id').notNull(),
    seatId: uuid('seat_id').notNull(),
    /** 좌석 배치의 게이트 구역. 최소 구현은 빈 값이다(좌석 배치 연결은 후속). */
    gateZone: text('gate_zone').notNull().default(''),
    status: text('status').notNull(),
    issueGeneration: bigint('issue_generation', { mode: 'number' }).notNull(),
    /** 스캐너가 읽는 공개 포인터(PEAKET1:<ticket_id>) */
    qrPayload: text('qr_payload').notNull(),
    /** 티켓 키 SHA-256(hex). 원문은 발권 응답에만 있다. */
    keyHash: text('key_hash').notNull(),
    keyRevokedAt: at('key_revoked_at'),
    /** 양도 요청 진행 중 자리(양도 모듈은 후속). */
    transferPending: boolean('transfer_pending').notNull().default(false),
    /** 부정 예매 양도 잠금 사건 ID 자리(후속). */
    fraudLockCaseId: uuid('fraud_lock_case_id'),
    /** 그 사건이 이 표에 적은 판(ADR-0171, 0010). 같은 사건의 더 큰 판만 반영한다 */
    fraudLockVersion: bigint('fraud_lock_version', { mode: 'number' }).notNull().default(0),
    version: integer('version').notNull().default(0),
    /** 취소가 입장 시작 전인지 판정하는 회차 시작 시각. 없으면 입장 전으로 본다. */
    eventStartsAt: at('event_starts_at'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('ticket_order_generation_seat_key').on(t.orderId, t.issueGeneration, t.seatId),
    index('ticket_wallet_idx').on(t.accountId, t.createdAt, t.id),
    index('ticket_order_idx').on(t.orderId, t.issueGeneration),
    check('ticket_status_check', sql`${t.status} IN ('ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'FLAGGED', 'VOIDED')`),
  ],
);

/** 양도 요청(0010, BUILD_ORDER GAT-050, docs/data.md `transfer_offer`). id = 요청의 Idempotency-Key */
export const transferOffer = pgTable(
  'transfer_offer',
  {
    id: uuid('id').primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id),
    fromAccountId: uuid('from_account_id').notNull(),
    toAccountId: uuid('to_account_id').notNull(),
    status: text('status').notNull(),
    withdrawReason: text('withdraw_reason'),
    expiresAt: at('expires_at').notNull(),
    decidedAt: at('decided_at'),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('transfer_offer_open_key').on(t.ticketId).where(sql`${t.status} = 'OFFERED'`),
    index('transfer_offer_expires_idx').on(t.expiresAt).where(sql`${t.status} = 'OFFERED'`),
    index('transfer_offer_recipient_idx').on(t.toAccountId, t.status),
    index('transfer_offer_ticket_idx').on(t.ticketId, t.status),
    check('transfer_offer_status_check', sql`${t.status} IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'RECLAIMED')`),
    check(
      'transfer_offer_withdraw_reason_check',
      sql`${t.withdrawReason} IS NULL OR ${t.withdrawReason} IN ('SENDER', 'ACCOUNT_DELETED', 'DEPOSIT_ERROR', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'FRAUD_LOCK')`,
    ),
  ],
);

/**
 * 받는 사람 조회 기록(0018, F-05-2, ASVS 2.4.1). 시도마다 한 행, 회원 코드·휴대폰 번호 원문·찾은 계정 ID는 남기지 않는다.
 * result는 FOUND·NOT_FOUND·LIMITED·UNAVAILABLE이고 LIMITED는 한도 셈에서 뺀다(창 안 마지막 60분의 나머지 결과를 센다)
 */
export const transferRecipientLookup = pgTable(
  'transfer_recipient_lookup',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    lookedUpAt: at('looked_up_at').notNull(),
    result: text('result').notNull(),
  },
  (t) => [
    index('transfer_recipient_lookup_account_idx').on(t.accountId, t.lookedUpAt),
    check('transfer_recipient_lookup_result_check', sql`${t.result} IN ('FOUND', 'NOT_FOUND', 'LIMITED', 'UNAVAILABLE')`),
  ],
);

/** 돌려주기 멱등 기록(0018, F-05-2, guidelines §4). (account_id, idempotency_key)로 한 번만 처리하고 같은 표면 처음 200을 재생한다 */
export const ticketReturn = pgTable(
  'ticket_return',
  {
    idempotencyKey: uuid('idempotency_key').notNull(),
    accountId: uuid('account_id').notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id),
    returnedAt: at('returned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.idempotencyKey] })],
);

/** 계정 단위 부정 예매 양도 잠금(0010, docs/data.md `fraud_transfer_lock`, ADR-0171·0173) */
export const fraudTransferLock = pgTable(
  'fraud_transfer_lock',
  {
    caseId: uuid('case_id').notNull(),
    eventId: uuid('event_id').notNull(),
    accountId: uuid('account_id').notNull(),
    locked: boolean('locked').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    expiresAt: at('expires_at').notNull(),
    changedAt: at('changed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.eventId, t.accountId] })],
);

/** 입장용 기기 공개키(offline-gate §2·§3, ADR-0025·0051). 티켓당 유효 키 하나, 폐기 키는 목록에 남긴다. */
export const deviceKey = pgTable(
  'device_key',
  {
    id: uuid('id').primaryKey(),
    ticketId: uuid('ticket_id').notNull(),
    /** QR v1 keyId 8바이트 */
    keyId: bytea('key_id').notNull(),
    /** 압축 P-256 공개키 33바이트 */
    publicKey: bytea('public_key').notNull(),
    reason: text('reason').notNull(),
    registeredAt: at('registered_at').notNull(),
    revokedAt: at('revoked_at'),
  },
  (t) => [
    uniqueIndex('device_key_active_key').on(t.ticketId).where(sql`${t.revokedAt} IS NULL`),
    index('device_key_ticket_key_idx').on(t.ticketId, t.keyId),
    check('device_key_reason_check', sql`${t.reason} IN ('ISSUE', 'REISSUE', 'TRANSFER', 'BOOTH')`),
    check('device_key_key_id_len', sql`octet_length(${t.keyId}) = 8`),
    check('device_key_public_key_len', sql`octet_length(${t.publicKey}) = 33`),
  ],
);

/**
 * 입장 키 알림 보낼 표(docs/data.md device_key_notice, ADR-0363 결정 4, 마이그레이션 0012). 성공한 교체·입장 시작 뒤 첫 등록이
 * 등록과 같은 트랜잭션에 한 행을 적고, 보내기 반복이 core-svc 알림 내부 입구로 보낸다. 연락처·키 값은 두지 않는다
 */
export const deviceKeyNotice = pgTable(
  'device_key_notice',
  {
    /** core-svc 알림 중복 키에 들어간다 */
    id: uuid('id').primaryKey(),
    /** 새로 등록한 키 */
    deviceKeyId: uuid('device_key_id')
      .notNull()
      .references(() => deviceKey.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id),
    /** 알림 받을 계정(그때의 보유자) */
    accountId: uuid('account_id').notNull(),
    type: text('type').notNull(),
    createdAt: at('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull(),
    sentAt: at('sent_at'),
  },
  (t) => [
    uniqueIndex('device_key_notice_device_key_uq').on(t.deviceKeyId),
    index('device_key_notice_due_idx').on(t.nextAttemptAt).where(sql`${t.sentAt} IS NULL`),
    check('device_key_notice_type_check', sql`${t.type} IN ('DEVICE_KEY_REISSUED', 'DEVICE_KEY_LATE_ISSUE')`),
    check('device_key_notice_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

/** 취소표. (cancellation_id, ticket_id)로 멱등하다. */
export const ticketCancellation = pgTable(
  'ticket_cancellation',
  {
    cancellationId: uuid('cancellation_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    orderId: uuid('order_id').notNull(),
    result: text('result').notNull(),
    /** CancelTickets 요청의 취소 사유(0009, 다시 보기 R1). USER인 기록만 첫 팬 취소로 싣는다. 널 허용 */
    reason: text('reason'),
    cancelledAt: at('cancelled_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cancellationId, t.ticketId] }),
    index('ticket_cancellation_ticket_idx').on(t.ticketId),
    check('ticket_cancellation_reason_check', sql`${t.reason} IS NULL OR ${t.reason} IN ('USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', 'FRAUD')`),
  ],
);

/** 부정 예매 운영자 취소의 표별 결과(0008, BUILD_ORDER GAT-080, docs/data.md ticket_operator_cancellation). (approval_id, ticket_id)로 멱등하다. 건너뜀도 남긴다 */
export const ticketOperatorCancellation = pgTable(
  'ticket_operator_cancellation',
  {
    approvalId: uuid('approval_id').notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => ticket.id),
    orderId: uuid('order_id').notNull(),
    fraudCaseId: uuid('fraud_case_id').notNull(),
    result: text('result').notNull(),
    /** 거둔 양도 요청 ID. transfer_offer 표가 생기기 전에는 비운다 */
    withdrawnTransferOfferId: text('withdrawn_transfer_offer_id'),
    cancelledAt: at('cancelled_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.approvalId, t.ticketId] }),
    check('ticket_operator_cancellation_result_check', sql`${t.result} IN ('CANCELED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_RECORDED', 'SKIPPED_HOLDER_CHANGED')`),
  ],
);
