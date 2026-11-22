// 미수금 이동 기록의 옛 이름 receivable_move(0028이 남긴 자동 갱신 뷰)를 저장소가 읽고 쓰는 정의(FIX-invariant-m3).
// 표 이름 바꾸기 확장 단계(docs/devops.md §7.1 원칙 3)에서 이 판의 앱은 옛 이름으로 돈다. 표 정의는 schema.ts의 receivableMovement다.
// 이 파일은 drizzle 설정의 표 정의 글로브(adapters/db/schema.ts) 밖이라 마이그레이션 생성기가 표로 보지 않는다. 그래서 제약·인덱스를 두지 않는다.
// 단계 ② 묶음이 지운다(docs/data.md §4 미수금 이동 기록 표 이름 맞추기).
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const receivableMoveCompat = pgTable('receivable_move', {
  id: uuid('id').defaultRandom().primaryKey(),
  receivableId: uuid('receivable_id').notNull(),
  statementId: uuid('statement_id').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  kind: text('kind').notNull().default('OFFSET'),
  movedAt: timestamp('moved_at', { withTimezone: true, mode: 'date' }).notNull(),
});
