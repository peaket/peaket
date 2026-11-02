// 결제 v0 표(docs/features/payment.md §13 표). drizzle-kit generate가 이 정의로 migrations/의 SQL을 만든다.
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** 결제 하나. 주문 하나에 결제 하나(order_id 유일) */
export const v0Payment = pgTable(
  'v0_payment',
  {
    paymentId: uuid('payment_id').primaryKey(),
    orderId: uuid('order_id').notNull().unique('v0_payment_order_id_unique'),
    eventId: text('event_id').notNull(),
    pg: text('pg').notNull(),
    paymentKey: text('payment_key').notNull(),
    amount: integer('amount').notNull(),
    status: text('status').notNull(),
    /** FAILED일 때 결과와 결제사 코드 */
    failure: text('failure'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('v0_payment_status_check', sql`${t.status} in ('CONFIRMING', 'APPROVED', 'FAILED')`),
    check('v0_payment_amount_check', sql`${t.amount} > 0`),
    check('v0_payment_approved_check', sql`(${t.status} = 'APPROVED') = (${t.approvedAt} is not null)`),
  ],
);
