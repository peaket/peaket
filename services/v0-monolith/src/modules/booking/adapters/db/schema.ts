// 주문 v0 표(docs/features/payment.md §13 표). drizzle-kit generate가 이 정의로 migrations/의 SQL을 만든다.
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** 회차의 좌석 등급별 가격(원) */
export const v0Price = pgTable(
  'v0_price',
  {
    eventId: text('event_id').notNull(),
    grade: text('grade').notNull(),
    price: integer('price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.grade] }), check('v0_price_price_check', sql`${t.price} between 1 and 100000000`)],
);

/** 주문 하나. 홀드 하나에 주문 하나(hold_id 유일). 주문 ID는 결제사 주문 ID로도 쓴다 */
export const v0Order = pgTable(
  'v0_order',
  {
    orderId: uuid('order_id').primaryKey(),
    eventId: text('event_id').notNull(),
    accountId: text('account_id').notNull(),
    holdId: uuid('hold_id').notNull().unique('v0_order_hold_id_unique'),
    seatIds: text('seat_ids').array().notNull(),
    amount: integer('amount').notNull(),
    orderName: text('order_name').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('v0_order_status_check', sql`${t.status} in ('CREATED', 'PAYING', 'APPROVED', 'CONFIRMED', 'FAILED')`),
    check('v0_order_amount_check', sql`${t.amount} > 0`),
  ],
);

/** 주문의 좌석 */
export const v0OrderItem = pgTable(
  'v0_order_item',
  {
    orderId: uuid('order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    seatId: text('seat_id').notNull(),
    grade: text('grade').notNull(),
    price: integer('price').notNull(),
    ticketId: uuid('ticket_id'),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.lineNo] })],
);

/** 주문 상태가 바뀐 이력(1부터 빈틈 없는 번호) */
export const v0OrderEvent = pgTable(
  'v0_order_event',
  {
    orderId: uuid('order_id').notNull(),
    seq: integer('seq').notNull(),
    toStatus: text('to_status').notNull(),
    reason: text('reason').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.seq] })],
);
