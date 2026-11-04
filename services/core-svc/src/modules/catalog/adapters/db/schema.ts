// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
// catalog 모듈의 공연(회차 묶음)·공연장·아티스트·다른 이름·회차와 판매자(docs/data.md ②, ADR-0093, BUILD_ORDER HOT-170 ①).
// 회차(event)는 공연 칸을 옮긴 뒤의 모양이다: 공연 정보(이름·장르·이미지·공연장)는 production에 있고 회차는 일정·상태와 판매 설정만 갖는다.
// 지금 둔 칸은 회차 공개 요약과 대표 회차 계산에 쓰는 것뿐이다. data.md의 나머지 칸은 그 칸을 처음 쓰는 단계가 더한다:
// - HOT-171(공연 등록·회차 더하기): event.reentry_allowed·lobby_minutes·lobby_shuffle·open_batch(CHECK 둘 중 하나는 true)·seat_assignment·
//   per_person_limit·sale_policy, production.kopis_fields·pending_revision
// - LCH-080·LCH-090(판매 승인): event.pg_primary·pg_fallback·scale·commission_rate_bp, production.accessible_seating_check
// - 판매자(promoter)는 공개 신원정보 칸만 둔다. 지급대행·정산 계좌·수수료율 칸은 파트너 등록·정산 단계가 더한다.
// 공개 판단의 전제: production·event 행은 늘 마지막 승인 내용(공개본)이다. 승인 뒤 바꾼 것은 승인 때까지 pending_revision에만 둔다(domain/production.ts isPublic).
import { heldEventTable, statSnapshotTable } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const promoter = pgTable('promoter', {
  id: uuid('id').primaryKey(),
  legalName: text('legal_name').notNull(),
  representative: text('representative'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  businessRegNo: text('business_reg_no'),
  mailOrderReportNo: text('mail_order_report_no'),
  verifiedAt: at('verified_at'),
});

export const place = pgTable(
  'place',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    address: text('address').notNull(),
    region: text('region').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').notNull(),
  },
  (t) => [check('place_status_check', sql`${t.status} in ('ACTIVE', 'CLOSED')`)],
);

export const production = pgTable(
  'production',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull().references(() => promoter.id),
    placeId: uuid('place_id').notNull().references(() => place.id),
    title: text('title').notNull(),
    genre: text('genre').notNull(),
    ageRating: text('age_rating'),
    runningMinutes: integer('running_minutes'),
    description: text('description'),
    saleReview: text('sale_review').notNull().default('DRAFT'),
    saleApprovedAt: at('sale_approved_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('production_title_check', sql`char_length(${t.title}) between 1 and 100`),
    check('production_genre_check', sql`${t.genre} in ('콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타')`),
    check('production_sale_review_check', sql`${t.saleReview} in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED')`),
    // 승인 이력과 상태가 맞아야 한다(planning/03 §2.14): Draft는 승인 이력이 없고, Approved는 있다. 다른 상태는 둘 다 될 수 있다(첫 승인 대기·반려·판매 중지)
    check('production_sale_approved_check', sql`(${t.saleReview} <> 'DRAFT' or ${t.saleApprovedAt} is null) and (${t.saleReview} <> 'APPROVED' or ${t.saleApprovedAt} is not null)`),
    // 회차의 판매자 사본이 공연의 판매자와 같게 묶는 외래키의 대상
    unique('production_id_promoter_uq').on(t.id, t.promoterId),
    index('production_promoter_idx').on(t.promoterId),
    index('production_place_idx').on(t.placeId),
  ],
);

export const artist = pgTable('artist', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const productionArtist = pgTable(
  'production_artist',
  {
    productionId: uuid('production_id').notNull().references(() => production.id, { onDelete: 'cascade' }),
    artistId: uuid('artist_id').notNull().references(() => artist.id),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productionId, t.artistId] }), index('production_artist_artist_idx').on(t.artistId)],
);

export const searchAlias = pgTable(
  'search_alias',
  {
    id: uuid('id').primaryKey(),
    targetKind: text('target_kind').notNull(),
    // 종류가 여럿이라 외래키를 두지 않는다(docs/data.md)
    targetId: uuid('target_id').notNull(),
    alias: text('alias').notNull(),
    source: text('source').notNull(),
    createdBy: uuid('created_by').notNull(),
    reason: text('reason'),
    removedAt: at('removed_at'),
  },
  (t) => [
    check('search_alias_kind_check', sql`${t.targetKind} in ('PRODUCTION', 'ARTIST', 'PLACE')`),
    check('search_alias_source_check', sql`${t.source} in ('PARTNER', 'OPERATOR')`),
    check('search_alias_alias_check', sql`char_length(${t.alias}) between 1 and 100`),
    // 지우지 않은 같은 대상의 같은 이름은 하나
    uniqueIndex('search_alias_live_uq').on(t.targetKind, t.targetId, t.alias).where(sql`${t.removedAt} is null`),
  ],
);

export const event = pgTable(
  'event',
  {
    id: uuid('id').primaryKey(),
    productionId: uuid('production_id').notNull(),
    // 공연의 파트너와 같은 값(테넌트 검사용 사본). 아래 묶음 외래키가 공연의 판매자와 다르게 들어가지 못하게 막는다
    promoterId: uuid('promoter_id').notNull(),
    // 한 공연의 회차는 모두 같은 배치본을 쓴다(ADR-0093 결정 1). 배치본 표는 좌석맵 단계가 더한다
    venueId: uuid('venue_id').notNull(),
    openAt: at('open_at').notNull(),
    entryOpensAt: at('entry_opens_at'),
    startsAt: at('starts_at').notNull(),
    endsAt: at('ends_at').notNull(),
    entryClosedAt: at('entry_closed_at'),
    status: text('status').notNull().default('SCHEDULED'),
  },
  (t) => [
    check('event_status_check', sql`${t.status} in ('SCHEDULED', 'CANCELLED', 'POSTPONED')`),
    check('event_times_check', sql`${t.openAt} < ${t.startsAt} and ${t.startsAt} < ${t.endsAt}`),
    foreignKey({ name: 'event_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    index('event_production_idx').on(t.productionId),
  ],
);

/** 서비스 소비자의 보류 표(ADR-0142 결정 2). 소비자가 없는 서비스도 같은 표를 둔다(정비 잡이 지운다) */
export const heldEvent = heldEventTable();

/** 정비 잡의 통계 스냅샷(ADR-0086 결정 7) */
export const statSnapshot = statSnapshotTable();
