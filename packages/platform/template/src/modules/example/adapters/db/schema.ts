// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
// Outbox 부모 표는 파티션 선언이 없어 손으로 쓴 SQL(migrations/0002_outbox.sql)이고 여기 두지 않는다.
import { heldEventTable, idempotencyRecordTable, statSnapshotTable } from '@peaket/platform';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const exampleNote = pgTable('example_note', {
  id: uuid('id').primaryKey(),
  ownerAccountId: text('owner_account_id').notNull(),
  title: text('title').notNull(),
});

/** 멱등 기록 표(작업 목록이 CHECK가 된다, docs/data.md '서비스마다 둔 멱등 기록 표') */
export const idempotencyRecord = idempotencyRecordTable(['CREATE_NOTE']);

/** 서비스 소비자의 보류 표(ADR-0142 결정 2, migrations/0003). 소비자가 없는 서비스도 같은 표를 둔다(정비 잡이 지운다) */
export const heldEvent = heldEventTable();

/** 정비 잡의 통계 스냅샷(ADR-0086 결정 7, migrations/0003) */
export const statSnapshot = statSnapshotTable();
