// 좌석 v0 표(docs/features/seat-hold.md §14 표). drizzle-kit generate가 이 정의로 migrations/의 SQL을 만든다.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** 좌석을 연 회차 */
export const v0SeatEvent = pgTable('v0_seat_event', {
  eventId: text('event_id').primaryKey(),
  perPersonLimit: integer('per_person_limit').notNull(),
  holdTtlMs: integer('hold_ttl_ms').notNull(),
  extendMs: integer('extend_ms').notNull(),
});

/** 좌석 하나 = 행 하나(잠금의 단위) */
export const v0Seat = pgTable(
  'v0_seat',
  {
    eventId: text('event_id').notNull(),
    seatId: text('seat_id').notNull(),
    section: text('section').notNull(),
    rowLabel: text('row_label').notNull(),
    seatNumber: integer('seat_number').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    grade: text('grade').notNull(),
    status: text('status').notNull(),
    holdId: uuid('hold_id'),
    /** SOLD일 때만: 판 주문(docs/features/seat-hold.md §14 동작 9) */
    orderId: uuid('order_id'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.seatId] }),
    check('v0_seat_status_check', sql`${t.status} in ('AVAILABLE', 'HELD', 'SOLD')`),
    check('v0_seat_hold_check', sql`(${t.status} = 'HELD') = (${t.holdId} is not null)`),
    check('v0_seat_order_check', sql`(${t.status} = 'SOLD') = (${t.orderId} is not null)`),
  ],
);

/** 홀드 하나 */
export const v0Hold = pgTable(
  'v0_hold',
  {
    holdId: uuid('hold_id').primaryKey(),
    eventId: text('event_id').notNull(),
    accountId: text('account_id').notNull(),
    seatIds: text('seat_ids').array().notNull(),
    status: text('status').notNull(),
    extended: boolean('extended').notNull().default(false),
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('v0_hold_status_check', sql`${t.status} in ('HELD', 'RELEASED', 'EXPIRED', 'SOLD')`),
    index('v0_hold_due_idx').on(t.expiresAt).where(sql`${t.status} = 'HELD'`),
  ],
);

/** 계정이 그 회차에서 잡고 있는 좌석 수와 판 좌석 수(POL-011). 한도는 둘을 함께 센다 */
export const v0Quota = pgTable(
  'v0_quota',
  {
    eventId: text('event_id').notNull(),
    accountId: text('account_id').notNull(),
    held: integer('held').notNull(),
    sold: integer('sold').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.accountId] }),
    check('v0_quota_held_check', sql`${t.held} >= 0`),
    check('v0_quota_sold_check', sql`${t.sold} >= 0`),
  ],
);
