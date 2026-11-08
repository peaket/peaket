// purchase DB의 좌석 표 셋(docs/data.md §2 ERD와 §4 '좌석 표 마이그레이션', docs/features/seat-hold.md §6, BUILD_ORDER PRF-140 ①).
// seat_sale(활성 판매), purchase_quota(1인 한도 행), seat_hold(홀드 원장). 주문·결제 표는 그 단계(PRF-160)가 더한다.
// seat_hold는 회차 ID 범위 월 파티션 표다. Drizzle 0.45에는 파티션 선언이 없어 여기는 부모 표 모양만 적고, 파티션 선언은 손으로 고친 마이그레이션 SQL에만 있다.
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    // 결제 중 셈(회차의 PENDING, ADR-0122 결정 3, BUILD_ORDER PRF-144). status UPDATE는 이미 위 활성 유일 부분 인덱스 때문에 HOT 갱신이 아니라 HOT을 더 잃지 않는다
    // reserved_at까지 두어 승인 기한 조건을 인덱스로 거른다(입금 대기·결과 모름으로 오래 남은 PENDING을 틱마다 읽지 않게, 리뷰 고침 L11)
    index('seat_sale_pending_idx')
      .on(t.eventId, t.reservedAt)
      .where(sql`${t.status} = 'PENDING'`),
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
    // 홀드 ID·구매 세션 ID(SeatEvent의 holdId·purchaseSessionId). 다시 만들기(RB-06)가 되살린 홀드 Hash에 쓴다(BUILD_ORDER PRF-143). 옛 행은 비어 있다.
    // 0002 마이그레이션의 ADD COLUMN이 표 끝에 붙이므로 DB 칸 차례와 맞춰 expires_at 뒤에 둔다
    holdId: uuid('hold_id'),
    purchaseSessionId: text('purchase_session_id'),
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

/** 회차마다 한 행: 회차 판매 상태와 판 번호(docs/data.md §2 event_sale, docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122, BUILD_ORDER PRF-144) */
export const eventSale = pgTable(
  'event_sale',
  {
    eventId: uuid('event_id').primaryKey(),
    status: text('status').notNull(),
    // 바뀌기 전 상태(같은 판을 다시 낼 때 그 판의 값으로 싣는다). 첫 행은 비운다
    previousStatus: text('previous_status'),
    version: bigint('version', { mode: 'number' }).notNull(),
    sellableSeats: integer('sellable_seats').notNull(),
    available: integer('available').notNull(),
    held: integer('held').notNull(),
    paying: integer('paying').notNull(),
    // 매진인 등급 ID(정렬). 집합이 바뀌면 판 번호를 올린다(ADR-0214 결정 3)
    soldOutTiers: text('sold_out_tiers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // UPCOMING이면 오픈 시각(LCH-080이 쓴다)
    openAt: at('open_at'),
    firstSoldOutAt: at('first_sold_out_at'),
    reopenCount: integer('reopen_count').notNull().default(0),
    changedAt: at('changed_at').notNull(),
    // 셈을 쓴 시각. 지금과의 차이로 같은 판을 다시 낼지 가른다
    countedAt: at('counted_at').notNull(),
  },
  (t) => [
    check('event_sale_status_check', sql`${t.status} in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED')`),
    check('event_sale_previous_status_check', sql`${t.previousStatus} in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED')`),
    check('event_sale_version_check', sql`${t.version} >= 1`),
    check('event_sale_counts_check', sql`${t.sellableSeats} >= 0 and ${t.available} >= 0 and ${t.held} >= 0 and ${t.paying} >= 0 and ${t.reopenCount} >= 0`),
  ],
);

/** 회차마다 한 행: 다시 만들기 판 번호와 다시 만들기 임대(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현') */
export const seatRebuild = pgTable(
  'seat_rebuild',
  {
    eventId: uuid('event_id').primaryKey(),
    gen: integer('gen').notNull().default(1),
    holder: text('holder'),
    leaseUntil: at('lease_until'),
  },
  (t) => [check('seat_rebuild_gen_check', sql`${t.gen} >= 1`)],
);
