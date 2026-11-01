// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
// Outbox 부모 표는 파티션 선언이 없어 손으로 쓴 SQL(migrations/0002_outbox.sql)이고 여기 두지 않는다.
import { idempotencyRecordTable } from '@peaket/platform';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const exampleNote = pgTable('example_note', {
  id: uuid('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  title: text('title').notNull(),
});

/** 멱등 기록 표(작업 목록이 CHECK가 된다, docs/data.md '서비스마다 둔 멱등 기록 표') */
export const idempotencyRecord = idempotencyRecordTable(['CREATE_NOTE']);
