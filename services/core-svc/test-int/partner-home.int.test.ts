// F-07-12 파트너 홈·공연 개요 읽기의 실제 PostgreSQL 통합 시험(SCR-062·063, HOT-260).
// 0054 적용과 production.version 기본·CHECK, Drizzle 목록·상세·seller-profile 매핑, core_partner 행 보안,
// search_document 판매 상태 사본의 한계를 본다(단위 시험은 test/partner-home.http.test.ts가 맡는다).
import 'reflect-metadata';
import { createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSearchReadModel } from '../src/modules/catalog/adapters/db/drizzle-search-read-model.js';
import { artist, event, place, production, productionArtist, productionImage, promoter, searchAlias } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const A = randomUUID();
const B = randomUUID();
const C = randomUUID(); // 판매자 행이 없는 테넌트
const D = randomUUID(); // 면제 근거가 빈 문자열인 판매자
const PLACE = randomUUID();
const PROD_ON = randomUUID();
const PROD_DRAFT = randomUUID();
const PROD_REJECTED = randomUUID();
const PROD_B = randomUUID();
/** version을 넣지 않아 기본 1이 되는 공연(0054 확인용) */
const PROD_DEFAULT = randomUUID();
const EVENT_ON = randomUUID();
const EVENT_B = randomUUID();
const PENDING_EVENT = randomUUID();
const ARTIST = randomUUID();
const ALIAS_LIVE = randomUUID();
const ALIAS_REMOVED = randomUUID();
const POSTER = randomUUID();
const DETAIL_IMAGE = randomUUID();

let pg: PostgresContainer;
let admin: Database;
let app: Database;
let partner: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const identity = new FakeIdentity();

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });
const body = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  app = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  partner = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 2);

  await admin.db.insert(promoter).values([
    {
      id: A,
      legalName: '(주)피켓공연',
      representative: '김대표',
      address: '서울시 마포구 어딘가 1',
      phone: '02-0000-0001',
      email: 'seller-a@example.test',
      businessRegNo: '123-45-67890',
      mailOrderReportNo: '2026-서울-0001',
      exemptionBasis: null,
      verifiedAt: new Date('2026-10-01T00:00:00Z'),
    },
    {
      id: B,
      legalName: '(주)다른공연',
      representative: '이대표',
      address: '부산시 해운대구 어딘가 2',
      phone: '051-000-0002',
      email: 'seller-b@example.test',
      businessRegNo: '987-65-43210',
      mailOrderReportNo: '2026-부산-0002',
      exemptionBasis: '기타 법령에 따른 면제',
      verifiedAt: new Date('2026-10-02T00:00:00Z'),
    },
    {
      id: D,
      legalName: '(주)빈근거공연',
      representative: '박대표',
      address: '대전시 어딘가 3',
      phone: '042-000-0003',
      email: 'seller-d@example.test',
      businessRegNo: '111-22-33333',
      mailOrderReportNo: '2026-대전-0003',
      exemptionBasis: '',
      verifiedAt: new Date('2026-10-03T00:00:00Z'),
    },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });

  await admin.db.insert(production).values([
    {
      id: PROD_ON,
      promoterId: A,
      placeId: PLACE,
      title: 'LUMEN 콘서트 2026 서울',
      genre: '콘서트',
      ageRating: '만 7세 이상',
      runningMinutes: 120,
      saleReview: 'APPROVED',
      saleApprovedAt: new Date('2026-10-01T00:00:00Z'),
      // 승인 뒤 바꾼 항목 셋: 판매 정책·회차 칸·더한 회차. 개요는 셋 다 pendingRevisionFields에 싣는다.
      pendingRevision: {
        salePolicy: [{ version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } }],
        eventChanges: { [EVENT_ON]: { perPersonLimit: 2 } },
        addedEvents: [
          {
            eventId: PENDING_EVENT,
            openAt: '2026-11-21T11:00:00.000Z',
            startsAt: '2027-01-21T10:00:00.000Z',
            endsAt: '2027-01-21T12:30:00.000Z',
            entryOpensAt: null,
            lobbyMinutes: 10,
            lobbyShuffle: true,
            openBatch: true,
            seatAssignment: 'PICK',
            perPersonLimit: 4,
            reentryAllowed: false,
            addedAt: '2026-11-10T00:00:00.000Z',
            venueId: null,
          },
        ],
      },
      version: 9,
    },
    { id: PROD_DRAFT, promoterId: A, placeId: PLACE, title: '초안 공연', genre: '연극', saleReview: 'DRAFT' },
    { id: PROD_DEFAULT, promoterId: A, placeId: PLACE, title: '기본 판 공연', genre: '연극', saleReview: 'DRAFT' },
    { id: PROD_REJECTED, promoterId: A, placeId: PLACE, title: '가을 뮤지컬', genre: '뮤지컬', saleReview: 'REJECTED', rejectionReason: '통신판매업 신고번호 누락' },
    { id: PROD_B, promoterId: B, placeId: PLACE, title: 'B 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-10-02T00:00:00Z') },
  ]);

  await admin.db.insert(event).values([
    {
      id: EVENT_ON,
      productionId: PROD_ON,
      promoterId: A,
      venueId: null,
      openAt: new Date('2026-11-01T11:00:00Z'),
      entryOpensAt: new Date('2026-12-20T09:30:00Z'),
      startsAt: new Date('2026-12-20T10:00:00Z'),
      endsAt: new Date('2026-12-20T12:00:00Z'),
      perPersonLimit: 4,
      version: 7,
    },
    {
      id: EVENT_B,
      productionId: PROD_B,
      promoterId: B,
      venueId: null,
      openAt: new Date('2026-11-02T11:00:00Z'),
      startsAt: new Date('2026-12-21T10:00:00Z'),
      endsAt: new Date('2026-12-21T12:00:00Z'),
    },
  ]);

  await admin.db.insert(artist).values({ id: ARTIST, name: '루멘밴드', createdBy: randomUUID() });
  await admin.db.insert(productionArtist).values({ productionId: PROD_ON, artistId: ARTIST, sortOrder: 0 });
  await admin.db.insert(searchAlias).values([
    { id: ALIAS_LIVE, targetKind: 'PRODUCTION', targetId: PROD_ON, alias: '겨울콘서트', source: 'PARTNER', createdBy: randomUUID() },
    { id: ALIAS_REMOVED, targetKind: 'PRODUCTION', targetId: PROD_ON, alias: '지운이름', source: 'PARTNER', createdBy: randomUUID(), removedAt: new Date('2026-11-01T00:00:00Z') },
  ]);
  await admin.db.insert(productionImage).values([
    {
      id: POSTER,
      productionId: PROD_ON,
      promoterId: A,
      kind: 'POSTER',
      alt: '겨울 콘서트 포스터',
      displayOrder: 0,
      width: 1000,
      height: 1400,
      version: 2,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
    },
    {
      id: DETAIL_IMAGE,
      productionId: PROD_ON,
      promoterId: A,
      kind: 'DETAIL',
      alt: '공연 소개 이미지',
      displayOrder: 1,
      width: 1200,
      height: 800,
      version: 3,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
    },
  ]);

  const sync = new DrizzleSearchReadModel(admin);
  await admin.transaction((tx) => sync.sync(tx, [PROD_ON, PROD_B], new Date(NOW)));

  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: app, notifyDatabase: app, partnerDatabase: partner, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await app?.close();
  await partner?.close();
  await admin?.close();
  pg?.stop();
});

describe('F-07-12 실제 PostgreSQL', () => {
  test('S-T42 ① 0054가 적용되어 production.version이 기본 1이고 0을 거부한다 [ASVS v5.0.0-8.2.2]', async () => {
    const column = rows<{ data_type: string; is_nullable: string; column_default: string | null }>(
      await admin.db.execute(sql`select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'production' and column_name = 'version'`),
    );
    expect(column).toEqual([{ data_type: 'integer', is_nullable: 'NO', column_default: '1' }]);

    const applied = rows<{ n: number; last_at: string | number }>(await admin.db.execute(sql`select count(*)::int as n, max(created_at) as last_at from drizzle.__drizzle_migrations`));
    // 저널은 idx 0~54 가운데 44개다(다른 가지가 쓰는 idx 구멍은 그대로). 마지막 적용이 0054의 when이다.
    expect(applied[0]?.n).toBe(44);
    expect(Number(applied[0]?.last_at)).toBe(1795319500000);

    const [made] = await admin.db.select({ version: production.version }).from(production).where(eq(production.id, PROD_DEFAULT));
    expect(made?.version).toBe(1);
    await expect(admin.db.update(production).set({ version: 0 }).where(eq(production.id, PROD_DEFAULT))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  test('S-T42 ② 목록은 테넌트 공연만 계약 칸으로 주고 search_document의 판매 상태를 읽는다 [ASVS v5.0.0-8.2.2]', async () => {
    const r = await get('/v1/partner/productions?q=LUMEN', identity.partner(A));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const items = (body(r).items ?? []) as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productionId: PROD_ON,
      title: 'LUMEN 콘서트 2026 서울',
      eventCount: 2,
      saleReview: 'APPROVED',
      hasApprovalHistory: true,
      rejectionReason: null,
      suspensionReasonCode: null,
      firstOpenAt: '2026-11-01T11:00:00.000Z',
      saleStatus: 'ON_SALE',
      pgPrimary: null,
      payoutHoldReason: null,
    });
    for (const key of ['promoterId', 'pendingRevision', 'salePolicy', 'eventChanges', 'createdAt']) expect(items[0]).not.toHaveProperty(key);

    const onSale = await get('/v1/partner/productions?saleStatus=ON_SALE', identity.partner(A));
    expect(((body(onSale).items ?? []) as { productionId: string }[]).map((i) => i.productionId)).toContain(PROD_ON);

    const other = await get('/v1/partner/productions', identity.partner(B));
    const otherIds = ((body(other).items ?? []) as { productionId: string }[]).map((i) => i.productionId);
    expect(otherIds).toEqual([PROD_B]);

    const noStore = await get('/v1/partner/productions?saleReview=NOPE', identity.partner(A));
    expect(noStore.statusCode).toBe(400);
    expect(noStore.headers['cache-control']).toBe('no-store');
  });

  test('S-T42 ③ 상세는 테넌트 공연의 계약 칸·회차·이미지·출연진을 주고 다른 테넌트에는 404다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3]', async () => {
    const r = await get(`/v1/partner/productions/${PROD_ON}`, identity.partner(A));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = body(r) as Record<string, unknown>;
    expect(d).toMatchObject({
      productionId: PROD_ON,
      version: 9,
      title: 'LUMEN 콘서트 2026 서울',
      genre: '콘서트',
      ageRating: '만 7세 이상',
      runningMinutes: 120,
      place: { placeId: PLACE, name: '피켓홀' },
      artists: [{ artistId: ARTIST, name: '루멘밴드' }],
      aliases: ['겨울콘서트'],
      saleReview: 'APPROVED',
      hasApprovalHistory: true,
      saleApprovedAt: '2026-10-01T00:00:00.000Z',
      hasPendingRevision: true,
      progressStage: 'SALE',
    });
    expect((d.pendingRevisionFields as string[]).sort()).toEqual(['addedEvents', 'eventChanges', 'salePolicy']);
    const events = d.events as Record<string, unknown>[];
    expect(events.map((e) => e.eventId)).toEqual([EVENT_ON, PENDING_EVENT]);
    expect(events[0]).toMatchObject({ version: 7, pending: false, status: 'SCHEDULED', openAt: '2026-11-01T11:00:00.000Z', entryOpensAt: '2026-12-20T09:30:00.000Z' });
    expect(events[1]).toMatchObject({ pending: true, version: 1, startsAt: '2027-01-21T10:00:00.000Z' });
    const images = d.images as Record<string, unknown>[];
    expect(images.map((i) => [i.imageId, i.kind, i.version])).toEqual([
      [POSTER, 'POSTER', 2],
      [DETAIL_IMAGE, 'DETAIL', 3],
    ]);
    expect(images[0]?.url).toBe(`https://img.peaket.test/production/${POSTER}`);
    expect(Object.keys(images[0]?.derivatives as object)).toHaveLength(8);
    for (const key of ['key', 'storageKey', 'quarantineKey', 'originalName', 'uploadedBy']) expect(images[0]).not.toHaveProperty(key);

    expect((await get(`/v1/partner/productions/${PROD_ON}`, identity.partner(B))).statusCode).toBe(404);
    expect((await get(`/v1/partner/productions/${PROD_ON}`, identity.partner(C))).statusCode).toBe(404);
    expect((await get(`/v1/partner/productions/${randomUUID()}`, identity.partner(A))).statusCode).toBe(404);
    expect((await get('/v1/partner/productions/not-a-uuid', identity.partner(A))).statusCode).toBe(404);
  });

  test('S-T42 ④ seller-profile은 자기 판매자 7칸과 verifiedAt을 주고 없으면 404다 [ASVS v5.0.0-8.2.2]', async () => {
    const r = await get('/v1/partner/seller-profile', identity.partner(A));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const a = body(r);
    expect(a).toEqual({
      seller: {
        legalName: '(주)피켓공연',
        representative: '김대표',
        address: '서울시 마포구 어딘가 1',
        phone: '02-0000-0001',
        email: 'seller-a@example.test',
        businessRegNo: '123-45-67890',
        mailOrderReportNo: '2026-서울-0001',
      },
      verifiedAt: '2026-10-01T00:00:00.000Z',
      pendingChange: null,
    });
    // 정본 SellerInfo.exemptionBasis는 optional string(nullable 아님). null이면 ''가 아니라 칸을 뺀다.
    expect(a.seller).not.toHaveProperty('exemptionBasis');

    const b = body(await get('/v1/partner/seller-profile', identity.partner(B)));
    expect(b.seller).toMatchObject({ legalName: '(주)다른공연', exemptionBasis: '기타 법령에 따른 면제' });

    // 저장 값이 빈 문자열이어도 '면제 근거 없음'을 뜻하는 ''를 내보내지 않는다.
    const d = body(await get('/v1/partner/seller-profile', identity.partner(D)));
    expect(d.seller).toMatchObject({ legalName: '(주)빈근거공연' });
    expect(d.seller).not.toHaveProperty('exemptionBasis');

    expect((await get('/v1/partner/seller-profile', identity.partner(C))).statusCode).toBe(404);
  });

  test('S-T42 ⑤ todo-summary는 테넌트 반려 수를 0과 null로 가른다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-14.2.2]', async () => {
    const a = await get('/v1/partner/todo-summary', identity.partner(A));
    expect(a.statusCode).toBe(200);
    expect(body(a)).toEqual({
      asOf: new Date(NOW).toISOString(),
      rejectedSaleReviewCount: 1,
      settlementDisputeDueCount: null,
      settlementDisputeEarliestDueAt: null,
      openGateFlagCount: null,
      pendingStaffInvitationCount: null,
    });
    expect(body(await get('/v1/partner/todo-summary', identity.partner(B))).rejectedSaleReviewCount).toBe(0);
    expect(body(await get('/v1/partner/todo-summary', identity.partner(C))).rejectedSaleReviewCount).toBe(0);
  });

  test('S-T42 ⑥ core_partner 행 보안은 테넌트를 넘지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const idsOf = async (tenantId?: string) => {
      const r = await partner.transaction(
        async (tx) => ({ p: await tx.select({ id: production.id }).from(production), e: await tx.select({ id: event.id }).from(event), s: await tx.select({ id: promoter.id }).from(promoter) }),
        tenantId === undefined ? undefined : { tenantId },
      );
      return { p: r.p.map((x) => x.id).sort(), e: r.e.map((x) => x.id).sort(), s: r.s.map((x) => x.id).sort() };
    };
    const a = await idsOf(A);
    expect(a.p).toEqual([PROD_DEFAULT, PROD_DRAFT, PROD_ON, PROD_REJECTED].sort());
    expect(a.e).toEqual([EVENT_ON]);
    expect(a.s).toEqual([A]);
    const b = await idsOf(B);
    expect(b).toEqual({ p: [PROD_B], e: [EVENT_B], s: [B] });
    expect(await idsOf()).toEqual({ p: [], e: [], s: [] });
  });

  test('S-T42 ⑦ search_document 판매 상태 사본은 ALL_HELD를 담지 못한다(한계 기록)', async () => {
    const doc = rows<{ sale_status: string }>(await admin.db.execute(sql`select sale_status from search_document where production_id = ${PROD_ON}::uuid`));
    expect(doc).toEqual([{ sale_status: 'ON_SALE' }]);
    // 사본 표의 CHECK는 UPCOMING·ON_SALE·SOLD_OUT·ENDED만 받는다. 그래서 DB 목록의 ALL_HELD 필터는 회차 원값을 쓸 수 없다(RV-02).
    await expect(admin.db.execute(sql`update search_document set sale_status = 'ALL_HELD' where production_id = ${PROD_ON}::uuid`)).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
