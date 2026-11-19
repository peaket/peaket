// 배상 송금 DB 스키마(BAT-425, ADR-0317, docs/data.md compensation_transfer, 마이그레이션 0024).
// 계좌 원문은 저장하지 않고 끝 4자리만 둔다(POL-014). compensation_id가 멱등 키이고 한 행이다.
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const compensationTransfer = pgTable(
  'compensation_transfer',
  {
    id: uuid('id').primaryKey(),
    // compensation.id. 멱등 키이고 한 행만 있다
    compensationId: uuid('compensation_id').notNull(),
    // 지급대행이 준 송금 ID. UNAVAILABLE이면 빈 글자다
    transferId: text('transfer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    // 결제자 계정
    accountId: uuid('account_id').notNull(),
    // 상계할 파트너(주최 측). PAID일 때 partner_receivable.promoter_id가 된다
    promoterId: uuid('promoter_id').notNull(),
    // 원래 회차. 상품 배상은 null
    eventId: uuid('event_id'),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    // 계좌번호 끝 4자리만. 원문은 저장하지 않는다
    accountLast4: text('account_last4').notNull(),
    // REQUESTED·PAID·FAILED·UNAVAILABLE(ADR-0317)
    status: text('status').notNull(),
    // 개인정보 없는 실패 이름표만
    failureReason: text('failure_reason'),
    // PAID일 때 만든 partner_receivable(COMPENSATION_ADVANCE)의 ID. 그 밖에는 null
    receivableId: uuid('receivable_id'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('compensation_transfer_compensation_id_key').on(t.compensationId),
    index('compensation_transfer_status_idx').on(t.status, t.createdAt),
    check('compensation_transfer_amount_check', sql`${t.amount} > 0`),
    check('compensation_transfer_status_check', sql`${t.status} IN ('REQUESTED', 'PAID', 'FAILED', 'UNAVAILABLE')`),
    check('compensation_transfer_account_last4_check', sql`${t.accountLast4} ~ '^[0-9]{1,4}$'`),
  ],
);
