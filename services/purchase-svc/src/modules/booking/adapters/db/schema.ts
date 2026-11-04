// purchase DB의 주문 표(docs/data.md §2 ERD purchase_order·order_item·order_event·order_idempotency·payment_attempt와 §4 '주문 표 마이그레이션',
// docs/features/payment.md §3 '주문 저장소의 첫 구현', BUILD_ORDER PRF-160, ADR-0113·0114). 마이그레이션은 0003_order_tables.sql이다.
// - 주문 표는 나누지 않는다(ADR-0114). 쓰기가 많은 purchase_order에는 새 인덱스를 두지 않는다(data.md §5.1).
// - order_event의 occurred_at BRIN 인덱스(매일 검사가 '전날 이력'을 찾는다, autosummarize = on), 상태 이력 지연 제약 트리거(order_status_has_event)와
//   Outbox 부모 표는 마이그레이션 SQL에만 손으로 적었다(Drizzle 표 정의로 적을 수 없다).
// - 결제 접수가 저장할 결제 참조 칸은 PRF-162, 발권 재시도 큐 ticket_issue_job은 PRF-163이 더한다.
// - drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다(도메인 → inventory 공개 면 → Nest 모듈까지 끌려 온다).
//   상태 목록은 도메인 상수 ORDER_STATUSES와 같은 차례로 글로 적는다(inventory schema.ts의 seat_sale 상태 목록과 같은 방식).
import { idempotencyRecordTable } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 주문 상태 열세 값의 CHECK 목록(domain/order.ts ORDER_STATUSES와 같은 값·차례) */
const STATUS_LIST = sql.raw(
  "'CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'",
);

export const purchaseOrder = pgTable(
  'purchase_order',
  {
    // UUIDv7(시간순, 부르는 쪽이 만든다)
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').notNull(),
    // 서버가 계산한 금액(원)
    amount: integer('amount').notNull(),
    // 상태 이력 order_event의 마지막 번호. 주문 전이 함수가 상태를 바꾸는 UPDATE에서 1 올린다(ADR-0113)
    eventSeq: integer('event_seq').notNull(),
    // 반영한 마지막 결제 사건 순번(ADR-0146 결정 2)
    paymentEventSeq: bigint('payment_event_seq', { mode: 'number' }).notNull().default(0),
    // 예매자 성명·휴대폰 번호. 탈퇴 회원은 보존 스키마로 옮기고 비우므로 널을 허용한다(data.md §6)
    buyerName: text('buyer_name'),
    buyerPhone: text('buyer_phone'),
    // 클라이언트 Idempotency-Key 사본(멱등 확인은 order_idempotency)
    idempotencyKey: text('idempotency_key').notNull(),
    consentVersion: text('consent_version').notNull(),
    seatAssignment: text('seat_assignment').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('purchase_order_status_check', sql`${t.status} in (${STATUS_LIST})`),
    check('purchase_order_amount_check', sql`${t.amount} >= 0`),
    check('purchase_order_event_seq_check', sql`${t.eventSeq} >= 1`),
    check('purchase_order_payment_event_seq_check', sql`${t.paymentEventSeq} >= 0`),
    check('purchase_order_seat_assignment_check', sql`${t.seatAssignment} in ('PICK', 'AUTO')`),
  ],
);

export const orderItem = pgTable(
  'order_item',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    // 주문 안 줄 번호(1부터)
    lineNo: integer('line_no').notNull(),
    seatId: uuid('seat_id').notNull(),
    // 등급 ID(주문 사건 items의 tierId)
    tier: text('tier').notNull(),
    // 구역 ID(주문 사건 items의 sectionId, ADR-0150)
    sectionId: text('section_id').notNull(),
    // 주문 때 가격 스냅샷(원)
    unitPrice: integer('unit_price').notNull(),
    // 발권 뒤 채운다(ticket DB라 외래 키 없음)
    ticketId: uuid('ticket_id'),
  },
  (t) => [
    primaryKey({ name: 'order_item_pkey', columns: [t.orderId, t.lineNo] }),
    // 한 주문에 같은 좌석은 한 줄(createOrder 입력 검사의 마지막 안전망, 리뷰 2026-11-05)
    uniqueIndex('order_item_seat_key').on(t.orderId, t.seatId),
    check('order_item_unit_price_check', sql`${t.unitPrice} >= 0`),
  ],
);

export const orderEvent = pgTable(
  'order_event',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    // 주문마다 1부터 빈틈 없이 늘어난다(purchase_order.event_seq와 같은 UPDATE에서 매긴다)
    seq: integer('seq').notNull(),
    // 이전 상태(첫 행 T1은 비움)
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    // 전이 번호 T1~T26
    cause: text('cause').notNull(),
    // account:<계정 ID> | admin:<관리 계정 ID> | system:<작업 이름>
    actor: text('actor').notNull(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'order_event_pkey', columns: [t.orderId, t.seq] }),
    // 이력 번호는 1부터(빈틈 검사 '행 수 = 마지막 번호'가 0·음수 번호로 속지 않게)
    check('order_event_seq_check', sql`${t.seq} >= 1`),
    // 널(첫 행)은 CHECK를 지난다
    check('order_event_from_status_check', sql`${t.fromStatus} in (${STATUS_LIST})`),
    check('order_event_to_status_check', sql`${t.toStatus} in (${STATUS_LIST})`),
  ],
);

/** 주문 생성·결제 시도 시작·결제 접수의 멱등 기록(계정 × 작업 범위, 기술 검토 중간-046) */
export const orderIdempotency = idempotencyRecordTable(['CREATE_ORDER', 'START_PAYMENT', 'ACCEPT_PAYMENT'], 'order_idempotency');

export const paymentAttempt = pgTable(
  'payment_attempt',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    pg: text('pg').notNull(),
    // 토스 orderId 또는 포트원 paymentId
    pgOrderRef: text('pg_order_ref'),
    status: text('status').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    // 활성(READY·ACCEPTED) 결제 시도는 주문마다 하나
    uniqueIndex('payment_attempt_active_key')
      .on(t.orderId)
      .where(sql`${t.status} in ('READY', 'ACCEPTED')`),
    // 주문의 모든 시도(끝난 것 포함)를 찾고, 주문 행을 지울 때 외래 키 검사가 표를 다 훑지 않게(리뷰 2026-11-05)
    index('payment_attempt_order_id_idx').on(t.orderId),
    check('payment_attempt_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('payment_attempt_status_check', sql`${t.status} in ('READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED')`),
  ],
);
