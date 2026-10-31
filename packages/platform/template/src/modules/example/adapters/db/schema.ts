// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const exampleNote = pgTable('example_note', {
  id: uuid('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  title: text('title').notNull(),
});
