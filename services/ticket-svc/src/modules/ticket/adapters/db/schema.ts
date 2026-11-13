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

/** 취소표. (cancellation_id, ticket_id)로 멱등하다. */
export const ticketCancellation = pgTable(
  'ticket_cancellation',
  {
    cancellationId: uuid('cancellation_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    orderId: uuid('order_id').notNull(),
    result: text('result').notNull(),
    cancelledAt: at('cancelled_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cancellationId, t.ticketId] }), index('ticket_cancellation_ticket_idx').on(t.ticketId)],
);

