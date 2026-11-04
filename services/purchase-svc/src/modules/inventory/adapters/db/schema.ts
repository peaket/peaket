// purchase DB의 좌석 표 셋(docs/data.md §2 ERD와 §4 '좌석 표 마이그레이션', docs/features/seat-hold.md §6, BUILD_ORDER PRF-140 ①).
// seat_sale(활성 판매), purchase_quota(1인 한도 행), seat_hold(홀드 원장). 주문·결제 표는 그 단계(PRF-160)가 더한다.
// seat_hold는 회차 ID 범위 월 파티션 표다. Drizzle 0.45에는 파티션 선언이 없어 여기는 부모 표 모양만 적고, 파티션 선언은 손으로 고친 마이그레이션 SQL에만 있다.
import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const seatSale = pgTable(
  'seat_sale',
  {
    eventId: uuid('event_id').notNull(),
    seatId: uuid('seat_id').notNull(),
    orderId: uuid('order_id').notNull(),
    // 주문한 계정. 한도를 되돌리는 연산(releasePending·returnSold)이 넘겨받은 계정과 대조해, 다른 계정의 한도 행을 줄이지 않게 한다(추천 적용 2026-11-04, PRF-140 ① 리뷰)
    accountId: uuid('account_id').notNull(),
    status: text('status').notNull(),
    reservedAt: at('reserved_at').notNull().defaultNow(),
    // 가상계좌 PENDING 기한(입금 기한 + 10분 [가정]). 쓸기 작업의 안전망이다(ADR-0086)
    pendingUntil: at('pending_until'),
  },
  (t) => [
    primaryKey({ name: 'seat_sale_pkey', columns: [t.eventId, t.seatId, t.orderId] }),
    // 활성 판매(PENDING·SOLD)만 좌석마다 하나. RETURNED는 이력으로 남고 재판매를 허용한다
    uniqueIndex('seat_sale_active_key')
      .on(t.eventId, t.seatId)
      .where(sql`${t.status} in ('PENDING', 'SOLD')`),
    check('seat_sale_status_check', sql`${t.status} in ('PENDING', 'SOLD', 'RETURNED')`),
  ],
);

export const purchaseQuota = pgTable(
  'purchase_quota',
  {
    accountId: uuid('account_id').notNull(),
    eventId: uuid('event_id').notNull(),
    used: integer('used').notNull(),
    limitCount: integer('limit_count').notNull(),
  },
  (t) => [
    primaryKey({ name: 'purchase_quota_pkey', columns: [t.accountId, t.eventId] }),
    // 한도를 넘는 갱신은 마지막으로 이 제약이 막는다(reserve는 조건부 갱신이 먼저 거른다)
    check('purchase_quota_used_within_limit', sql`${t.used} >= 0 and ${t.limitCount} >= 0 and ${t.used} <= ${t.limitCount}`),
  ],
);

export const seatHold = pgTable(
  'seat_hold',
  {
    eventId: uuid('event_id').notNull(),
    seatId: uuid('seat_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    kind: text('kind').notNull().default('FAN'),
    // kind PRIORITY일 때 priority_grant.id(ops 논리 DB라 외래키 없음)
    priorityGrantId: uuid('priority_grant_id'),
    // 좌석을 잡은 시각(SeatEvent HELD의 occurredAt = 홀드 Lua의 Redis TIME). 홀드 원장 적재(PRF-141)가 채운다
    heldAt: at('held_at'),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'seat_hold_pkey', columns: [t.eventId, t.seatId, t.fencingToken] }),
    // 활성 홀드는 좌석마다 하나
    uniqueIndex('seat_hold_active_key')
      .on(t.eventId, t.seatId)
      .where(sql`${t.status} = 'HELD'`),
    check('seat_hold_status_check', sql`${t.status} in ('HELD', 'RELEASED', 'EXPIRED')`),
    check('seat_hold_kind_check', sql`${t.kind} in ('FAN', 'PRIORITY')`),
  ],
);
