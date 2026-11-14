// purchase DB의 판매 정지 표 sale_control(BAT-465 R-584, docs/data.md §3 s:{event:E}:ctl, ADR-0103·0123).
// 원본은 이 표이고 좌석 Redis s:{event:E}:ctl에 사본을 쓴다. 범위는 EVENT(회차)와 PLATFORM(전체)이다.
// paused는 명령 3(판매 일시정지), suspended는 판매 승인 업무의 판매 중지다. 재개는 각자의 칸만 내린다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const saleControl = pgTable(
  'sale_control',
  {
    // EVENT 또는 PLATFORM
    scope: text('scope').notNull(),
    // EVENT면 회차 ID, PLATFORM이면 null
    eventId: uuid('event_id'),
    paused: boolean('paused').notNull().default(false),
    suspended: boolean('suspended').notNull().default(false),
    // 그 범위에서 늘어나기만 하는 판 번호(제어 gRPC의 version과 같은 값)
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    // 마지막으로 이 행을 바꾼 명령(운영 명령 SALE_STOP·SALE_RESUME)
    commandId: uuid('command_id'),
    // 판매 중지를 건 승인 업무 ID
    suspensionRef: text('suspension_ref'),
    reason: text('reason'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('sale_control_event_key')
      .on(t.eventId)
      .where(sql`${t.scope} = 'EVENT'`),
    uniqueIndex('sale_control_platform_key')
      .on(t.scope)
      .where(sql`${t.scope} = 'PLATFORM'`),
    check('sale_control_scope_check', sql`${t.scope} in ('EVENT', 'PLATFORM')`),
    check('sale_control_event_check', sql`(${t.scope} = 'EVENT') = (${t.eventId} is not null)`),
    check('sale_control_revision_check', sql`${t.revision} >= 1`),
  ],
);
