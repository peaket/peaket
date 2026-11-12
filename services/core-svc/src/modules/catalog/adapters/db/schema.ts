// Drizzle 표 정의(어댑터 안). 스키마의 원본은 migrations/의 SQL 파일이다(drizzle-kit generate로 만들고 검토해 커밋, ADR-0037 결정 6).
// catalog 모듈의 공연(회차 묶음)·공연장·아티스트·다른 이름·회차와 판매자(docs/data.md ②, ADR-0093, BUILD_ORDER HOT-170 ①).
// 회차(event)는 공연 칸을 옮긴 뒤의 모양이다: 공연 정보(이름·장르·이미지·공연장)는 production에 있고 회차는 일정·상태와 판매 설정만 갖는다.
// data.md의 칸은 그 칸을 처음 쓰는 단계가 더한다. 공개 요약·대표 회차 칸은 HOT-170, 등록 칸(event.reentry_allowed·lobby_minutes·lobby_shuffle·
// open_batch·seat_assignment·per_person_limit, production.kopis_fields·pending_revision·requested_place·requested_artists)과 찜·멱등 기록 표는
// HOT-171이 더했다(ADR-0198). 배치본 표(venue·section·seat·price_tier)와 회차의 배치본 외래키는 HOT-240이 더했다(ADR-0260). 판매 정책 규칙(공연 단위
// production.sale_policy·sale_policy_version, event.sale_policy는 없앰)·회차 판 event.version·판매 자격 명단 두 표는 HOT-250이 더했다(ADR-0261 결정 1·4·8).
// 남은 칸: LCH-080·LCH-090(판매 승인)의 event.pg_primary·pg_fallback·scale·commission_rate_bp, production.accessible_seating_check
// - 판매자(promoter)는 공개 신원정보 칸만 둔다. 지급대행·정산 계좌·수수료율 칸은 파트너 등록·정산 단계가 더한다.
// 공개 판단의 전제: production·event 행은 늘 마지막 승인 내용(공개본)이다. 승인 뒤 바꾼 것은 승인 때까지 pending_revision에만 둔다(domain/production.ts isPublic).
import { heldEventTable, idempotencyRecordTable, statSnapshotTable } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, foreignKey, index, integer, jsonb, pgSequence, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

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
    /** 재승인 대기 변경분. 승인 뒤 더한 회차는 addedEvents, 고친 판매 정책 규칙은 salePolicy, 고친 회차 칸은 eventChanges[회차 ID]에만 둔다(ADR-0198 결정 3, ADR-0261 결정 1·4) */
    pendingRevision: jsonb('pending_revision'),
    /** 판매 정책 규칙 배열(문법 1판, 공연 단위 한 칸, 승인 이력이 있으면 마지막 승인 내용, ADR-0261 결정 1). 없으면 규칙 없음 */
    salePolicy: jsonb('sale_policy'),
    /** 규칙 고치기 If-Match의 판(1부터, 저장마다 +1, 변경분에 둘 때도 오른다, ADR-0261 결정 2) */
    salePolicyVersion: integer('sale_policy_version').notNull().default(1),
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
    check('production_sale_policy_version_check', sql`${t.salePolicyVersion} >= 1`),
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

/**
 * 공연장 틀(TEMPLATE)과 틀을 복제한 공연용 배치본(LAYOUT, docs/data.md venue, ADR-0063·ADR-0260 결정 2). 이 단계는 배치본 저장에 쓰는 칸과
 * 틀의 공개 표시(published)만 둔다. 템플릿 코드·이름·계열·변형·기본 좌석 수·개략도·판은 DB 칸이 아니라 정적 JSON(seed/seatmap-templates)이 정본이고,
 * DB venue·section 행은 templateOk·templateDraft가 읽는 사본이다(ADR-0264 결정 43).
 * 배치본 ID는 공연 ID에서 정해진 값(domain/seatmap-layout.ts layoutVenueId)이라, 첫 저장이 판을 잡은 뒤 실패해도 다음 저장이 같은 행의 판 차례를 잇는다
 */
export const venue = pgTable(
  'venue',
  {
    id: uuid('id').primaryKey(),
    name: text('name'),
    kind: text('kind').notNull(),
    templateVenueId: uuid('template_venue_id'),
    // LAYOUT일 때 배치본을 가진 파트너(테넌트, 행 보안). TEMPLATE은 NULL
    promoterId: uuid('promoter_id').references(() => promoter.id),
    canvasWidth: integer('canvas_width'),
    canvasHeight: integer('canvas_height'),
    stageShapes: jsonb('stage_shapes'),
    /** 행(section·seat·price_tier·캔버스·무대)에 있는 배치의 판. 0은 아직 저장한 배치가 없음 */
    layoutVersion: integer('layout_version').notNull().default(0),
    /** 마지막으로 잡은 판 번호(다시 쓰지 않는다, ADR-0260 결정 5) */
    versionSeq: integer('version_seq').notNull().default(0),
    /** 행 판의 팬 좌석맵 파일을 공개 위치에 게시했으면 그 판(= layout_version), 아니면 NULL. LCH-080이 게시 여부를 다시 계산하지 않게 남긴다(ADR-0260 결정 6) */
    publishedVersion: integer('published_version'),
    /** 승인 이력이 있는 공연의 재승인 대기 배치 문서와 판(ADR-0260 결정 9) */
    pendingLayout: jsonb('pending_layout'),
    /** TEMPLATE만. 파트너 템플릿 목록에 보이는지 */
    published: boolean('published').notNull().default(false),
  },
  (t) => [
    check('venue_kind_check', sql`${t.kind} in ('TEMPLATE', 'LAYOUT')`),
    // 배치본은 파트너가 가지고 틀은 아무도 가지지 않는다. 틀 복제 표시는 배치본에만 있다
    check('venue_owner_check', sql`(${t.kind} = 'LAYOUT') = (${t.promoterId} is not null) and (${t.kind} = 'LAYOUT' or ${t.templateVenueId} is null)`),
    check('venue_version_check', sql`${t.layoutVersion} >= 0 and ${t.versionSeq} >= ${t.layoutVersion}`),
    check('venue_published_check', sql`${t.publishedVersion} is null or ${t.publishedVersion} = ${t.layoutVersion}`),
    check('venue_canvas_check', sql`(${t.canvasWidth} is null or ${t.canvasWidth} between 1 and 100000) and (${t.canvasHeight} is null or ${t.canvasHeight} between 1 and 100000)`),
    foreignKey({ name: 'venue_template_fk', columns: [t.templateVenueId], foreignColumns: [t.id] }),
    // 구역·좌석·가격 등급·회차의 판매자 사본이 배치본의 판매자와 같게 묶는 외래키의 대상
    unique('venue_id_promoter_uq').on(t.id, t.promoterId),
  ],
);

/** 배치본(또는 틀)의 구역(docs/data.md section). 차례 sort_order가 곧 색인 차례다(ADR-0260 결정 3) */
export const section = pgTable(
  'section',
  {
    venueId: uuid('venue_id').notNull(),
    sectionKey: text('section_key').notNull(),
    // 테넌트(행 보안, 배치본의 promoter_id와 같다). TEMPLATE은 NULL
    promoterId: uuid('promoter_id'),
    sortOrder: integer('sort_order').notNull(),
    seatIndexFrom: integer('seat_index_from'),
    seatIndexTo: integer('seat_index_to'),
    name: text('name').notNull(),
    level: text('level'),
    /** 공연장 좌표계 다각형 꼭짓점 목록 */
    shape: jsonb('shape').notNull(),
    /** 그린 도구(kind)·도형 이름·좌석 채우기 규칙(fillRule). 팬 화면은 쓰지 않는다 */
    editorMeta: jsonb('editor_meta'),
    labelX: integer('label_x'),
    labelY: integer('label_y'),
    defaultTier: text('default_tier'),
    gateZone: text('gate_zone'),
  },
  (t) => [
    primaryKey({ columns: [t.venueId, t.sectionKey] }),
    foreignKey({ name: 'section_venue_fk', columns: [t.venueId], foreignColumns: [venue.id] }),
    foreignKey({ name: 'section_venue_promoter_fk', columns: [t.venueId, t.promoterId], foreignColumns: [venue.id, venue.promoterId] }),
    check('section_order_check', sql`${t.sortOrder} >= 0`),
    // 좌석이 없는 구역은 범위가 둘 다 없다
    check('section_range_check', sql`(${t.seatIndexFrom} is null) = (${t.seatIndexTo} is null) and (${t.seatIndexFrom} is null or (${t.seatIndexFrom} >= 0 and ${t.seatIndexFrom} <= ${t.seatIndexTo}))`),
    unique('section_order_uq').on(t.venueId, t.sortOrder),
  ],
);

/**
 * 배치본의 좌석(docs/data.md seat). seat_key는 판매·홀드 기록의 좌석 ID(소문자 UUID, seat-hold §5 '좌석 ID 글')와 같은 값이라 저장마다 행을 바꿔 넣어도 그대로다.
 * 서버가 매긴다(보낸 값이 이 배치본에 이미 있는 UUID면 그대로, 아니면 새 UUIDv7, ADR-0260 결정 2)
 */
export const seat = pgTable(
  'seat',
  {
    venueId: uuid('venue_id').notNull(),
    seatKey: uuid('seat_key').notNull(),
    sectionKey: text('section_key').notNull(),
    promoterId: uuid('promoter_id'),
    seatIndex: integer('seat_index').notNull(),
    rowLabel: text('row_label').notNull(),
    number: integer('number').notNull(),
    /** 좌석 등급. 없으면 구역 default_tier */
    tierId: text('tier_id'),
    unavailable: boolean('unavailable').notNull().default(false),
    wheelchair: boolean('wheelchair').notNull().default(false),
    gateZone: text('gate_zone'),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.venueId, t.seatKey] }),
    foreignKey({ name: 'seat_section_fk', columns: [t.venueId, t.sectionKey], foreignColumns: [section.venueId, section.sectionKey] }),
    foreignKey({ name: 'seat_venue_promoter_fk', columns: [t.venueId, t.promoterId], foreignColumns: [venue.id, venue.promoterId] }),
    check('seat_index_check', sql`${t.seatIndex} >= 0`),
    unique('seat_index_uq').on(t.venueId, t.seatIndex),
    unique('seat_place_uq').on(t.venueId, t.sectionKey, t.rowLabel, t.number),
  ],
);

/** 가격 등급(배치본 단위 = 공연 단위, docs/data.md price_tier, ADR-0260 결정 2). 보이는 순서가 팬 파일 tiers와 공연 상세 priceTiers의 차례다 */
export const priceTier = pgTable(
  'price_tier',
  {
    venueId: uuid('venue_id').notNull(),
    tierId: text('tier_id').notNull(),
    promoterId: uuid('promoter_id').notNull(),
    name: text('name').notNull(),
    price: integer('price').notNull(),
    displayOrder: integer('display_order').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.venueId, t.tierId] }),
    foreignKey({ name: 'price_tier_venue_promoter_fk', columns: [t.venueId, t.promoterId], foreignColumns: [venue.id, venue.promoterId] }),
    check('price_tier_tier_id_check', sql`char_length(${t.tierId}) between 1 and 30`),
    check('price_tier_name_check', sql`char_length(${t.name}) between 1 and 30`),
    check('price_tier_price_check', sql`${t.price} between 1 and 10000000`),
    check('price_tier_order_check', sql`${t.displayOrder} between 0 and 15`),
    unique('price_tier_order_uq').on(t.venueId, t.displayOrder),
  ],
);

export const event = pgTable(
  'event',
  {
    id: uuid('id').primaryKey(),
    productionId: uuid('production_id').notNull(),
    // 공연의 파트너와 같은 값(테넌트 검사용 사본). 아래 묶음 외래키가 공연의 판매자와 다르게 들어가지 못하게 막는다
    promoterId: uuid('promoter_id').notNull(),
    // 한 공연의 회차는 모두 같은 배치본을 쓴다(ADR-0093 결정 1). 첫 배치본을 커밋할 때 그 공연의 모든 회차에 같은 값을 넣고 그 전에는 비어 있다
    // (ADR-0198 결정 4, ADR-0260 결정 8). 아래 묶음 외래키가 다른 판매자의 배치본을 가리키지 못하게 막는다
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
    /** 회차 고치기 If-Match의 판(1부터, 고칠 때마다 +1, 변경분에 둘 때도 오른다, ADR-0261 결정 4) */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('event_status_check', sql`${t.status} in ('SCHEDULED', 'CANCELLED', 'POSTPONED')`),
    check('event_times_check', sql`${t.openAt} < ${t.startsAt} and ${t.startsAt} < ${t.endsAt}`),
    foreignKey({ name: 'event_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    foreignKey({ name: 'event_venue_promoter_fk', columns: [t.venueId, t.promoterId], foreignColumns: [venue.id, venue.promoterId] }),
    check('event_lobby_minutes_check', sql`${t.lobbyMinutes} between 0 and 60`),
    // 정렬 설정 두 값을 둘 다 끈 조합은 받지 않는다(POL-003, ADR-0118)
    check('event_queue_order_check', sql`${t.lobbyShuffle} or ${t.openBatch}`),
    check('event_seat_assignment_check', sql`${t.seatAssignment} in ('PICK', 'AUTO')`),
    check('event_per_person_limit_check', sql`${t.perPersonLimit} between 1 and 10`),
    check('event_version_check', sql`${t.version} >= 1`),
    index('event_production_idx').on(t.productionId),
    // 오픈 간격 판정(다른 공연의 오픈 시각 범위 읽기)
    index('event_open_at_idx').on(t.openAt),
  ],
);

/**
 * 공연 이미지(포스터 1장·상세 0~10장, ADR-0062 결정 38, ADR-0257, docs/data.md production_image). 처리가 끝나 받은 것만 행이 된다(상태 칸이 없다).
 * 원본 키·파생본 경로는 서버가 만든 id로만 만든다. 공연마다 포스터 하나는 부분 유일 인덱스가 막고, 장수·순서는 공연 행 잠금 안에서 본다(data.md §5)
 */
export const productionImage = pgTable(
  'production_image',
  {
    id: uuid('id').primaryKey(),
    productionId: uuid('production_id').notNull(),
    // 테넌트(행 보안). 아래 묶음 외래키가 공연의 판매자와 다르게 들어가지 못하게 막는다
    promoterId: uuid('promoter_id').notNull(),
    kind: text('kind').notNull(),
    alt: text('alt').notNull(),
    displayOrder: integer('display_order').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ name: 'production_image_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    check('production_image_kind_check', sql`${t.kind} in ('POSTER', 'DETAIL')`),
    check('production_image_alt_check', sql`char_length(${t.alt}) between 1 and 300`),
    check('production_image_order_check', sql`${t.displayOrder} between 0 and 9 and (${t.kind} <> 'POSTER' or ${t.displayOrder} = 0)`),
    check('production_image_size_check', sql`${t.width} between 1 and 20000 and ${t.height} between 1 and 20000`),
    check('production_image_version_check', sql`${t.version} >= 1`),
    uniqueIndex('production_image_poster_uq').on(t.productionId).where(sql`${t.kind} = 'POSTER'`),
    index('production_image_production_idx').on(t.productionId, t.displayOrder),
  ],
);

/**
 * 판매 자격 명단 사본의 판(전역에서 늘기만 하는 번호, 리뷰 H1·D3). 사본에 닿는 일(올리기·규칙 저장·회차 더하기·고치기·파기 시각 변경)마다 그 공연 명단에 새 번호를 매기고,
 * 지우기·파기도 새 번호를 실어 넘긴다. 지웠다 같은 키로 다시 올려도 번호가 계속 커서 받는 쪽의 '판이 클 때만'에 걸리지 않는다
 */
export const saleEligibilityCopySeq = pgSequence('sale_eligibility_copy_seq');

/**
 * 판매 자격 명단(docs/data.md sale_eligibility_list, ADR-0062 결정 35·37, ADR-0261 결정 6~9). 공연마다 키가 유일하고 10개 [가정]까지(공연 행 잠금 안에서 센다).
 * 올린 파일은 두지 않고 SHA-256만 둔다. 잠금·파기 시각은 규칙 저장·명단 올리기·회차 더하기·고치기 때 다시 계산한다
 */
export const saleEligibilityList = pgTable(
  'sale_eligibility_list',
  {
    id: uuid('id').primaryKey(),
    productionId: uuid('production_id').notNull(),
    // 테넌트(행 보안). 아래 묶음 외래키가 공연의 판매자와 다르게 들어가지 못하게 막는다
    promoterId: uuid('promoter_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    memberCount: integer('member_count').notNull(),
    fileSha256: bytea('file_sha256').notNull(),
    /** 올릴 때마다 +1(1부터). 사본은 이 판으로 넘긴다 */
    version: integer('version').notNull(),
    /** 사본 판(sale_eligibility_copy_seq에서 받는다). 사본에 닿는 일마다 새 번호다 */
    copySeq: bigint('copy_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('sale_eligibility_copy_seq')`),
    /** 사본으로 넘긴 마지막 판(못 넘겼으면 copy_seq보다 작거나 NULL, 정비 일 sale-eligibility-copy가 다시 넘긴다) */
    copiedSeq: bigint('copied_seq', { mode: 'number' }),
    uploadedAt: at('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    /** 그 키를 쓰는 규칙의 가장 이른 during.from − 24시간 [가정]. 쓰는 규칙이 없으면 NULL */
    lockedAt: at('locked_at'),
    /** 공연의 취소되지 않은 회차 가운데 가장 늦은 판매 종료 + 1일 [가정] */
    destroyDueAt: at('destroy_due_at').notNull(),
  },
  (t) => [
    foreignKey({ name: 'sale_eligibility_list_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    unique('sale_eligibility_list_key_uq').on(t.productionId, t.key),
    // 구성원의 판매자 사본이 명단의 판매자와 같게 묶는 외래키의 대상
    unique('sale_eligibility_list_id_promoter_uq').on(t.id, t.promoterId),
    check('sale_eligibility_list_key_check', sql`${t.key} ~ '^[a-z0-9-]{3,32}$'`),
    check('sale_eligibility_list_name_check', sql`char_length(${t.name}) between 1 and 40`),
    check('sale_eligibility_list_count_check', sql`${t.memberCount} between 0 and 500000`),
    check('sale_eligibility_list_sha_check', sql`octet_length(${t.fileSha256}) = 32`),
    check('sale_eligibility_list_version_check', sql`${t.version} >= 1 and (${t.copiedSeq} is null or ${t.copiedSeq} <= ${t.copySeq})`),
    // 파기 정비가 파기 시각이 지난 명단을 찾는다
    index('sale_eligibility_list_destroy_idx').on(t.destroyDueAt),
  ],
);

/** 판매 자격 명단 구성원(회원 코드를 바꾼 계정 ID만, docs/data.md sale_eligibility_member). account_id는 identity 논리 DB라 외래키가 없다 */
export const saleEligibilityMember = pgTable(
  'sale_eligibility_member',
  {
    listId: uuid('list_id').notNull(),
    promoterId: uuid('promoter_id').notNull(),
    accountId: uuid('account_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.accountId] }),
    foreignKey({ name: 'sale_eligibility_member_list_promoter_fk', columns: [t.listId, t.promoterId], foreignColumns: [saleEligibilityList.id, saleEligibilityList.promoterId] }),
  ],
);

/**
 * 지운 명단의 사본 지우기 기록(리뷰 S1·D4). 명단 지우기·파기가 같은 트랜잭션에 남기고, 사본 지우기가 성공하면 지운다. 정비 일이 성공할 때까지 다시 지운다(판 copy_seq를 실어
 * 받는 쪽은 그 판 이하만 지운다)
 */
export const saleEligibilityDrop = pgTable(
  'sale_eligibility_drop',
  {
    productionId: uuid('production_id').notNull(),
    promoterId: uuid('promoter_id').notNull(),
    listKey: text('list_key').notNull(),
    copySeq: bigint('copy_seq', { mode: 'number' }).notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productionId, t.listKey, t.copySeq] }),
    foreignKey({ name: 'sale_eligibility_drop_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    index('sale_eligibility_drop_created_idx').on(t.createdAt),
  ],
);

/** 명단 올리기 기록(공연마다 시간당 횟수 한도, 리뷰 S5). 정비 일이 두 시간 [가정] 지난 행을 지운다 */
export const saleEligibilityUpload = pgTable(
  'sale_eligibility_upload',
  {
    id: uuid('id').primaryKey(),
    productionId: uuid('production_id').notNull(),
    promoterId: uuid('promoter_id').notNull(),
    at: at('at').notNull(),
  },
  (t) => [
    foreignKey({ name: 'sale_eligibility_upload_production_promoter_fk', columns: [t.productionId, t.promoterId], foreignColumns: [production.id, production.promoterId] }),
    index('sale_eligibility_upload_production_at_idx').on(t.productionId, t.at),
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
