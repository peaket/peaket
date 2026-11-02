// 발권·검표 v0 표(docs/features/offline-gate.md §13 표). drizzle-kit generate가 이 정의로 migrations/의 SQL을 만든다.
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** 티켓 하나. (주문, 좌석)마다 하나, 코드는 유일 */
export const v0Ticket = pgTable(
  'v0_ticket',
  {
    ticketId: uuid('ticket_id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    eventId: text('event_id').notNull(),
    seatId: text('seat_id').notNull(),
    accountId: text('account_id').notNull(),
    code: text('code').notNull(),
    status: text('status').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true, mode: 'date' }),
    /** 입장을 판정한 검표 스태프 계정 */
    enteredBy: text('entered_by'),
  },
  (t) => [
    unique('v0_ticket_code_unique').on(t.code),
    unique('v0_ticket_order_seat_unique').on(t.orderId, t.seatId),
    check('v0_ticket_status_check', sql`${t.status} in ('ISSUED')`),
    check('v0_ticket_entered_check', sql`(${t.enteredAt} is null) = (${t.enteredBy} is null)`),
  ],
);

/** 그 회차를 검표하는 스태프 계정(요청마다 본다) */
export const v0GateStaff = pgTable(
  'v0_gate_staff',
  {
    eventId: text('event_id').notNull(),
    accountId: text('account_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.accountId] })],
);
