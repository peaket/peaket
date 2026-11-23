// 계산 뒤 환급 미수금의 칸까지 보이는 partner_receivable 정의(payment 0033, F-07-8 I-02, docs/data.md partner_receivable).
// schema.ts의 partnerReceivable은 고정 시험(payment-schema BAT-425)이 0024 스냅숏 모양에 묶어 칸을 더하지 않는다. 그래서 0033의 손으로 쓴 칸은
// 이 정의로 읽고 쓴다. 이 파일은 drizzle 설정의 표 정의 글로브(adapters/db/schema.ts) 밖이라 마이그레이션 생성기가 표로 보지 않는다(제약·인덱스를 두지 않는다).
import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });

export const partnerReceivableFull = pgTable('partner_receivable', {
  id: uuid('id').primaryKey(),
  promoterId: uuid('promoter_id').notNull(),
  pg: text('pg'),
  cause: text('cause').notNull(),
  eventId: uuid('event_id'),
  sourceRef: text('source_ref'),
  amount: amount('amount').notNull(),
  remaining: amount('remaining').notNull(),
  status: text('status').notNull().default('OPEN'),
  createdAt: at('created_at').notNull(),
  updatedAt: at('updated_at').notNull(),
  statementId: uuid('statement_id'),
  commissionRateBp: integer('commission_rate_bp'),
  refundAmount: amount('refund_amount'),
  commissionShare: amount('commission_share'),
  commissionVatShare: amount('commission_vat_share'),
});
