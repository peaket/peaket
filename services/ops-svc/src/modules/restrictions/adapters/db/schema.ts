// ops 예매 제한 표의 Drizzle 매핑(F-06-4). 표는 F-04-13 0037이 만들고, 이 파일은 읽기·쓰기 모양만 둔다.
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const bookingRestriction = pgTable('booking_restriction', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  reasonCode: text('reason_code').notNull(),
  fraudCaseId: uuid('fraud_case_id'),
  confirmedBy: uuid('confirmed_by'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  appealDueAt: timestamp('appeal_due_at', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  version: bigint('version', { mode: 'number' }).notNull(),
});

export type BookingRestrictionDbRow = typeof bookingRestriction.$inferSelect;
