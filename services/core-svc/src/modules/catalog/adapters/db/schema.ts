// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
// catalog 모듈의 공연(회차 묶음)·공연장·아티스트·다른 이름·회차와 판매자(docs/data.md ②, ADR-0093, BUILD_ORDER HOT-170 ①).
// 회차(event)는 공연 칸을 옮긴 뒤의 모양이다: 공연 정보(이름·장르·이미지·공연장)는 production에 있고 회차는 일정·상태와 판매 설정만 갖는다.
// data.md의 칸은 그 칸을 처음 쓰는 단계가 더한다. 공개 요약·대표 회차 칸은 HOT-170, 등록 칸(event.reentry_allowed·lobby_minutes·lobby_shuffle·
// open_batch·seat_assignment·per_person_limit·sale_policy, production.kopis_fields·pending_revision·requested_place·requested_artists)과 찜·멱등 기록 표는
// HOT-171이 더했다(ADR-0198). 남은 칸: LCH-080·LCH-090(판매 승인)의 event.pg_primary·pg_fallback·scale·commission_rate_bp, production.accessible_seating_check
// - 판매자(promoter)는 공개 신원정보 칸만 둔다. 지급대행·정산 계좌·수수료율 칸은 파트너 등록·정산 단계가 더한다.
// 공개 판단의 전제: production·event 행은 늘 마지막 승인 내용(공개본)이다. 승인 뒤 바꾼 것은 승인 때까지 pending_revision에만 둔다(domain/production.ts isPublic).
import { heldEventTable, idempotencyRecordTable, statSnapshotTable } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
  /** 통신판매업 신고 면제 사유(신고번호가 없을 때, openapi SellerInfo.exemptionBasis, ADR-0200 결정 4) */
  exemptionBasis: text('exemption_basis'),
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
    // 새 공연장 요청이면 판매 승인 때 운영자가 잇기 전까지 비어 있다(requested_place와 꼭 하나만 찬다, ADR-0198 결정 4)
    placeId: uuid('place_id').references(() => place.id),
    title: text('title').notNull(),
    genre: text('genre').notNull(),
    ageRating: text('age_rating'),
    runningMinutes: integer('running_minutes'),
    description: text('description'),
    descriptionDoc: jsonb('description_doc'),
    saleReview: text('sale_review').notNull().default('DRAFT'),
    saleApprovedAt: at('sale_approved_at'),
    /** 공연예술통합전산망 항목 가운데 공연에 딸린 것(HOT-180이 채운다) */
    kopisFields: jsonb('kopis_fields'),
    /** 재승인 대기 변경분. 승인 뒤 더한 회차는 addedEvents에만 둔다(ADR-0198 결정 3) */
    pendingRevision: jsonb('pending_revision'),
    /** 새 공연장 요청 { name, address } */
    requestedPlace: jsonb('requested_place'),
    /** 새 아티스트 이름 요청 [{ name, sortOrder }] */
    requestedArtists: jsonb('requested_artists'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('production_title_check', sql`char_length(${t.title}) between 1 and 100`),
    check('production_genre_check', sql`${t.genre} in ('콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타')`),
    check('production_sale_review_check', sql`${t.saleReview} in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED')`),
    // 승인 이력과 상태가 맞아야 한다(planning/03 §2.14): Draft는 승인 이력이 없고, Approved와 판매 중지(T9·T10은 승인 이력이 있을 때만)는 있다.
    // 승인 대기·반려는 둘 다 될 수 있다(첫 요청이거나 재승인). HOT-170의 첫 제약은 판매 중지를 빠뜨렸다(ADR-0198 결정 7)
    check('production_sale_approved_check', sql`(${t.saleReview} <> 'DRAFT' or ${t.saleApprovedAt} is null) and (${t.saleReview} not in ('APPROVED', 'SUSPENDED') or ${t.saleApprovedAt} is not null)`),
    // 공연장은 등록된 공연장과 새 공연장 요청 가운데 꼭 하나다. 승인 이력이 있으면 등록된 공연장이다(ADR-0198 결정 4)
    check('production_place_check', sql`(${t.placeId} is null) <> (${t.requestedPlace} is null)`),
    check('production_approved_place_check', sql`${t.saleApprovedAt} is null or ${t.placeId} is not null`),
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
    // 한 공연의 회차는 모두 같은 배치본을 쓴다(ADR-0093 결정 1). 배치본 표와 값은 좌석맵 단계(HOT-240)가 더하고, 그 전에는 비어 있다(ADR-0198 결정 4)
    venueId: uuid('venue_id'),
    openAt: at('open_at').notNull(),
    entryOpensAt: at('entry_opens_at'),
    startsAt: at('starts_at').notNull(),
    endsAt: at('ends_at').notNull(),
    entryClosedAt: at('entry_closed_at'),
    status: text('status').notNull().default('SCHEDULED'),
    reentryAllowed: boolean('reentry_allowed').notNull().default(false),
    lobbyMinutes: integer('lobby_minutes').notNull().default(10),
    lobbyShuffle: boolean('lobby_shuffle').notNull().default(true),
    openBatch: boolean('open_batch').notNull().default(true),
    seatAssignment: text('seat_assignment').notNull().default('PICK'),
    perPersonLimit: integer('per_person_limit').notNull().default(4),
    /** 판매 정책 DSL AST(HOT-250이 채운다) */
    salePolicy: jsonb('sale_policy'),
  },
  (t) => [
    check('event_status_check', sql`${t.status} in ('SCHEDULED', 'CANCELLED', 'POSTPONED')`),
    check('event_times_check', sql`${t.openAt} < ${t.startsAt} and ${t.startsAt} < ${t.endsAt}`),
    foreignKey({ name: 'event_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    check('event_lobby_minutes_check', sql`${t.lobbyMinutes} between 0 and 60`),
    // 정렬 설정 두 값을 둘 다 끈 조합은 받지 않는다(POL-003, ADR-0118)
    check('event_queue_order_check', sql`${t.lobbyShuffle} or ${t.openBatch}`),
    check('event_seat_assignment_check', sql`${t.seatAssignment} in ('PICK', 'AUTO')`),
    check('event_per_person_limit_check', sql`${t.perPersonLimit} between 1 and 10`),
    index('event_production_idx').on(t.productionId),
    // 오픈 간격 판정(다른 공연의 오픈 시각 범위 읽기)
    index('event_open_at_idx').on(t.openAt),
  ],
);

/** 찜(공연 단위, ADR-0093). account_id는 identity 논리 DB라 외래키가 없다. 같은 찜은 처음 시각을 둔다(ADR-0198 결정 5) */
export const wish = pgTable(
  'wish',
  {
    accountId: uuid('account_id').notNull(),
    productionId: uuid('production_id')
      .notNull()
      .references(() => production.id),
    createdAt: at('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.productionId] }), index('wish_account_created_idx').on(t.accountId, t.createdAt)],
);

/** 멱등 기록 표(ADR-0146 결정 1). 작업 이름은 openapi가 멱등 키를 요구하는 core-svc 쓰기다 */
export const idempotencyRecord = idempotencyRecordTable(['CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT']);

/** 서비스 소비자의 보류 표(ADR-0142 결정 2). 소비자가 없는 서비스도 같은 표를 둔다(정비 잡이 지운다) */
export const heldEvent = heldEventTable();

/** 정비 잡의 통계 스냅샷(ADR-0086 결정 7) */
export const statSnapshot = statSnapshotTable();
