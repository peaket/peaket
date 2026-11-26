// F-07-12 파트너 홈·공연 목록·개요 읽기 API(SCR-062·063, HOT-260).
// 정본: docs/api/openapi.yaml `GET /v1/partner/productions`(5480~5503행)·`GET /v1/partner/todo-summary`(6800~6815행)·
// `GET /v1/partner/productions/{productionId}`(6816~6836행)·`GET /v1/partner/seller-profile`, docs/design/d5 §6.2·§6.3,
// docs/security/authz-matrix.md §3.3·§3.5, ASVS catalog-review 2.2.1·8.2.1·8.2.2·8.2.3·14.2.2.
// 메모리 저장소로 테넌트 경계·계약 칸·필터·커서·진행 단계·no-store를 본다. 실제 DB는 test-int가 맡는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { FakeIdentity, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const PLACE = randomUUID();
const NOW_MS = Date.parse('2026-11-15T00:00:00.000Z');
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

type SaleState = 'UPCOMING' | 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';
type SuspensionCode = 'SELLER_IDENTITY' | 'LEGAL_REQUEST' | 'FRAUD_SUSPECTED' | 'OTHER';

interface EventSeed {
  openAt: string;
  startsAt: string;
  endsAt?: string;
  status?: 'SCHEDULED' | 'CANCELLED' | 'POSTPONED';
  sale?: SaleState;
  entryClosedAt?: Date;
  soldPercent?: number;
}

interface ProductionSeed {
  tenant?: string;
  title?: string;
  saleReview?: Production['saleReview'];
  saleApprovedAt?: Date | null;
  saleSubmittedAt?: Date | null;
  rejectionReason?: string | null;
  suspensionReasonCode?: SuspensionCode | null;
  version?: number;
  events?: EventSeed[];
}

function sellerRow(promoterId: string, legalName: string) {
  return {
    promoterId,
    legalName,
    representative: '대표자',
    address: '서울 어딘가 1',
    phone: '02-0000-0000',
    email: 'seller@example.test',
    businessRegNo: '123-45-67890',
    mailOrderReportNo: '2026-서울-0001',
    exemptionBasis: null,
    verifiedAt: new Date('2026-10-01T00:00:00Z'),
    commissionRateBp: 1000,
    pendingContractApprovalId: null,
  };
}

/** 공연 하나와 회차를 넣는다. `production.version`·판매 중지 칸은 구현 전 도메인에 없어 캐스팅으로 넣는다(계획 §5). */
function seedProduction(o: ProductionSeed = {}): string {
  const id = randomUUID();
  const tenant = o.tenant ?? TENANT;
  const row = {
    id,
    promoterId: tenant,
    placeId: PLACE,
    title: o.title ?? `공연-${id.slice(0, 8)}`,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'DRAFT',
    saleApprovedAt: o.saleApprovedAt ?? null,
    saleSubmittedAt: o.saleSubmittedAt ?? null,
    rejectionReason: o.rejectionReason ?? null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    suspensionReasonCode: o.suspensionReasonCode ?? null,
    version: o.version ?? 1,
  };
  repo.productions.set(id, row as unknown as Production);
  for (const e of o.events ?? []) {
    const eventId = randomUUID();
    repo.events.set(eventId, {
      id: eventId,
      productionId: id,
      venueId: null,
      openAt: new Date(e.openAt),
      startsAt: new Date(e.startsAt),
      status: e.status ?? 'SCHEDULED',
      ...(e.entryClosedAt ? { entryClosedAt: e.entryClosedAt } : {}),
    } as never);
    if (e.sale !== undefined) repo.saleStates.set(eventId, e.sale);
    if (e.endsAt !== undefined || e.entryClosedAt !== undefined || e.soldPercent !== undefined) {
      repo.details.set(eventId, {
        event: {
          ...(e.endsAt !== undefined ? { endsAt: new Date(e.endsAt) } : {}),
          ...(e.entryClosedAt !== undefined ? { entryClosedAt: e.entryClosedAt } : {}),
          ...(e.soldPercent !== undefined ? { soldPercent: e.soldPercent } : {}),
        } as never,
      });
    }
  }
  return id;
}

function eventsOf(productionId: string) {
  return [...repo.events.values()].filter((e) => e.productionId === productionId);
}

const APPROVED_AT = new Date('2026-10-01T00:00:00Z');

// A 테넌트: 재승인 대기(12/20) · 판매 중지(12/15) · 반려(12/10, 취소 회차 12/01 포함) · 판매 중(11/01) · 초안
const resubmitted = seedProduction({
  title: '재승인 공연',
  saleReview: 'SUBMITTED',
  saleApprovedAt: APPROVED_AT,
  saleSubmittedAt: new Date('2026-11-01T00:00:00Z'),
  events: [{ openAt: '2026-12-20T11:00:00Z', startsAt: '2027-01-20T10:00:00Z', endsAt: '2027-01-20T12:00:00Z', sale: 'UPCOMING' }],
});
// 승인 뒤 더해 변경분에만 있는 회차(pending true). 목록 eventCount와 개요 회차에 함께 든다.
const pendingEventId = randomUUID();
repo.pending.set(resubmitted, [
  {
    eventId: pendingEventId,
    openAt: new Date('2026-12-21T11:00:00Z'),
    startsAt: new Date('2027-01-21T10:00:00Z'),
    endsAt: new Date('2027-01-21T12:00:00Z'),
    lobbyMinutes: 10,
    reentryAllowed: false,
    lobbyShuffle: true,
    openBatch: true,
    seatAssignment: 'PICK',
    perPersonLimit: 4,
    addedAt: new Date('2026-11-01T00:00:00Z'),
    venueId: null,
  },
]);
const suspended = seedProduction({
  title: '겨울 팬미팅',
  saleReview: 'SUSPENDED',
  saleApprovedAt: APPROVED_AT,
  suspensionReasonCode: 'SELLER_IDENTITY',
  events: [{ openAt: '2026-12-15T11:00:00Z', startsAt: '2027-01-15T10:00:00Z', endsAt: '2027-01-15T12:00:00Z', sale: 'UPCOMING' }],
});
const rejected = seedProduction({
  title: '가을 뮤지컬',
  saleReview: 'REJECTED',
  rejectionReason: '통신판매업 신고번호 누락',
  events: [
    { openAt: '2026-12-10T11:00:00Z', startsAt: '2027-01-10T10:00:00Z', endsAt: '2027-01-10T12:00:00Z', sale: 'UPCOMING' },
    { openAt: '2026-12-11T11:00:00Z', startsAt: '2027-01-11T10:00:00Z', endsAt: '2027-01-11T12:00:00Z', sale: 'UPCOMING' },
    { openAt: '2026-12-01T11:00:00Z', startsAt: '2027-01-01T10:00:00Z', endsAt: '2027-01-01T12:00:00Z', status: 'CANCELLED' },
  ],
});
const onSale = seedProduction({
  title: 'LUMEN 콘서트 2026 서울',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [
    {
      openAt: '2026-11-01T11:00:00Z',
      startsAt: '2026-12-24T10:00:00Z',
      endsAt: '2026-12-24T12:30:00Z',
      sale: 'ON_SALE',
      soldPercent: 50,
    },
  ],
});
const draft = seedProduction({ title: '초안 공연' });

// B 테넌트: A 목록에 섞이면 안 되는 공연
const otherTenant = seedProduction({
  tenant: OTHER,
  title: '다른 파트너 공연',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [{ openAt: '2026-12-05T11:00:00Z', startsAt: '2027-01-05T10:00:00Z', endsAt: '2027-01-05T12:00:00Z', sale: 'ON_SALE' }],
});

// 공연 개요: 아티스트·공연장·이미지·회차 칸
const onSaleEvent = eventsOf(onSale)[0]!;
repo.details.set(onSaleEvent.id, {
  place: { id: PLACE, name: '피켓 아레나', address: '서울 어딘가 1' },
  artists: [{ artistId: randomUUID(), name: '루멘' }],
  event: {
    endsAt: new Date('2026-12-24T12:30:00Z'),
    entryOpensAt: new Date('2026-12-24T08:30:00Z'),
    lobbyMinutes: 10,
    reentryAllowed: false,
    lobbyShuffle: true,
    openBatch: true,
    seatAssignment: 'PICK',
    perPersonLimit: 4,
    soldPercent: 50,
  } as never,
  production: { ageRating: '만 7세 이상', runningMinutes: 120, description: null, descriptionDoc: null, salePolicy: [] },
});
const posterId = randomUUID();
repo.images.set(posterId, {
  id: posterId,
  productionId: onSale,
  promoterId: TENANT,
  kind: 'POSTER',
  alt: 'LUMEN 포스터',
  order: 0,
  width: 1000,
  height: 1400,
  version: 1,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
});

// 진행 단계 경계값(2026-11-15T00:00Z 기준)
const stageDraft = seedProduction({ title: '단계 초안' });
const stageReview = seedProduction({ title: '단계 승인 대기', saleReview: 'SUBMITTED' });
const stageOpen = seedProduction({
  title: '단계 오픈',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [{ openAt: '2026-12-01T11:00:00Z', startsAt: '2026-12-24T10:00:00Z', endsAt: '2026-12-24T12:30:00Z', sale: 'UPCOMING' }],
});
const stageSale = seedProduction({
  title: '단계 판매',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [{ openAt: '2026-11-01T11:00:00Z', startsAt: '2026-12-24T10:00:00Z', endsAt: '2026-12-24T12:30:00Z', sale: 'ON_SALE' }],
});
const stageEntry = seedProduction({
  title: '단계 입장',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [{ openAt: '2026-10-01T11:00:00Z', startsAt: '2026-11-14T10:00:00Z', endsAt: '2026-11-15T12:00:00Z', sale: 'ENDED' }],
});
const stageClosed = seedProduction({
  title: '단계 입장 기록 마감',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [
    {
      openAt: '2026-10-01T11:00:00Z',
      startsAt: '2026-11-10T10:00:00Z',
      endsAt: '2026-11-11T12:00:00Z',
      entryClosedAt: new Date('2026-11-11T12:00:00Z'),
      sale: 'ENDED',
    },
  ],
});
const stageSettlement = seedProduction({
  title: '단계 정산',
  saleReview: 'APPROVED',
  saleApprovedAt: APPROVED_AT,
  events: [{ openAt: '2026-10-01T11:00:00Z', startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-06T12:00:00Z', sale: 'ENDED' }],
});

beforeAll(async () => {
  repo.places.add(PLACE);
  repo.promoters.set(TENANT, sellerRow(TENANT, '(주)피켓공연'));
  repo.promoters.set(OTHER, sellerRow(OTHER, '(주)다른공연'));
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.sellerNames.set(OTHER, '(주)다른공연');
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
});

const headersOf = (role: 'partner_admin' | 'partner_member' = 'partner_admin') => identity.partner(TENANT, role);
const otherHeaders = () => identity.partner(OTHER, 'partner_admin');
const get = (url: string, headers: Record<string, string> = headersOf()) => svc.http.inject({ method: 'GET', url, headers });
const body = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };

const ALLOWED_SUMMARY = new Set([
  'productionId',
  'title',
  'eventCount',
  'saleReview',
  'hasApprovalHistory',
  'rejectionReason',
  'suspensionReasonCode',
  'firstOpenAt',
  'saleStatus',
  'pgPrimary',
  'payoutHoldReason',
]);

describe('F-07-12 SCR-062 공연 목록 읽기', () => {
  test('F-07-12 AC-01 PH-01 목록은 소속 공연만 첫 오픈 늦은 순으로 주고 내부 칸이 없다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3]', async () => {
    const r = await get('/v1/partner/productions');
    expect(r.statusCode).toBe(200);
    const page = body(r) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(page.items.map((i) => i.productionId)).toEqual([resubmitted, suspended, rejected, onSale, draft]);

    const byId = new Map(page.items.map((i) => [i.productionId as string, i]));
    expect(byId.get(resubmitted)).toMatchObject({
      title: '재승인 공연',
      saleReview: 'SUBMITTED',
      hasApprovalHistory: true,
      eventCount: 2,
      saleStatus: 'UPCOMING',
    });
    expect(byId.get(suspended)).toMatchObject({
      saleReview: 'SUSPENDED',
      hasApprovalHistory: true,
      suspensionReasonCode: 'SELLER_IDENTITY',
      saleStatus: null,
    });
    expect(byId.get(rejected)).toMatchObject({
      saleReview: 'REJECTED',
      hasApprovalHistory: false,
      rejectionReason: '통신판매업 신고번호 누락',
      eventCount: 3,
      firstOpenAt: '2026-12-10T11:00:00.000Z',
      saleStatus: null,
    });
    expect(byId.get(onSale)).toMatchObject({
      title: 'LUMEN 콘서트 2026 서울',
      saleReview: 'APPROVED',
      hasApprovalHistory: true,
      eventCount: 1,
      firstOpenAt: '2026-11-01T11:00:00.000Z',
      saleStatus: 'ON_SALE',
      pgPrimary: null,
      payoutHoldReason: null,
    });
    expect(byId.get(draft)).toMatchObject({ saleReview: 'DRAFT', eventCount: 0, firstOpenAt: null, saleStatus: null });

    expect(page.items.some((i) => i.productionId === otherTenant)).toBe(false);
    for (const item of page.items) {
      expect(Object.keys(item).filter((k) => !ALLOWED_SUMMARY.has(k))).toEqual([]);
      for (const forbidden of ['promoterId', 'saleApprovedAt', 'pendingRevision', 'createdAt', 'seller']) {
        expect(item).not.toHaveProperty(forbidden);
      }
    }
    expect(page.nextCursor).toBeNull();
  });

  test('F-07-12 AC-01 PH-02 판매 승인·재승인·변경 반려·판매 상태·기간·이름 필터가 계약대로다', async () => {
    const rejectedOnly = await get('/v1/partner/productions?saleReview=REJECTED');
    expect(rejectedOnly.statusCode).toBe(200);
    expect((body(rejectedOnly) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([rejected]);

    const resubOnly = await get('/v1/partner/productions?saleReview=SUBMITTED&hasApprovalHistory=true');
    expect(resubOnly.statusCode).toBe(200);
    expect((body(resubOnly) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([resubmitted]);

    const onSaleOnly = await get('/v1/partner/productions?saleStatus=ON_SALE');
    expect(onSaleOnly.statusCode).toBe(200);
    expect((body(onSaleOnly) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([onSale]);

    const byName = await get('/v1/partner/productions?q=lumen');
    expect(byName.statusCode).toBe(200);
    expect((body(byName) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([onSale]);

    // KST 날짜 경계: 12/15 20:00 KST는 to=12/15에 들고, 12/10은 from=12/15에 들지 않는다
    const day = await get('/v1/partner/productions?from=2026-12-15&to=2026-12-15');
    expect(day.statusCode).toBe(200);
    expect((body(day) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([suspended]);

    const after = await get('/v1/partner/productions?from=2026-12-16');
    expect(after.statusCode).toBe(200);
    expect((body(after) as { items: { productionId: string }[] }).items.map((i) => i.productionId)).toEqual([resubmitted]);
  });

  test('F-07-12 AC-01 PH-03 커서는 다음 쪽을 잇고 같은 공연을 다시 주지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const url = `/v1/partner/productions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await get(url);
      expect(r.statusCode).toBe(200);
      const page = body(r) as { items: { productionId: string }[]; nextCursor: string | null };
      all.push(...page.items.map((x) => x.productionId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(all).toEqual([resubmitted, suspended, rejected, onSale, draft]);
    expect(new Set(all).size).toBe(all.length);
    expect(cursor).toBeNull();
  });

  test('F-07-12 AC-01 PH-04 목록의 잘못된 쿼리는 400이고 200·404는 no-store다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-14.2.2]', async () => {
    for (const url of [
      '/v1/partner/productions?limit=0',
      '/v1/partner/productions?limit=101',
      '/v1/partner/productions?saleReview=NOPE',
      '/v1/partner/productions?saleStatus=NOPE',
      '/v1/partner/productions?hasApprovalHistory=maybe',
      '/v1/partner/productions?from=2026-13-01',
      '/v1/partner/productions?to=2026-02-30',
      '/v1/partner/productions?cursor=not-base64',
    ]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(400);
      expect(problem(r).status, url).toBe(400);
    }

    const ok = await get('/v1/partner/productions');
    expect(ok.headers['cache-control']).toBe('no-store');
    const missing = await get(`/v1/partner/productions/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(problem(missing).type).toBe('https://peaket.example/problems/not-found');
  });

  test('F-07-12 AC-01 PH-05 partner_member도 읽고 로그인 없으면 401이다 [ASVS v5.0.0-8.2.1]', async () => {
    const member = await get('/v1/partner/productions', headersOf('partner_member'));
    expect(member.statusCode).toBe(200);
    const anon = await svc.http.inject({ method: 'GET', url: '/v1/partner/productions' });
    expect(anon.statusCode).toBe(401);
  });

  test('F-07-12 AC-02 PH-06 할 일 카드는 반려된 판매 승인만 세고 원천이 없는 칸은 null이다 [ASVS v5.0.0-14.2.2]', async () => {
    const r = await get('/v1/partner/todo-summary');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(body(r)).toEqual({
      asOf: new Date(NOW_MS).toISOString(),
      rejectedSaleReviewCount: 1,
      settlementDisputeDueCount: null,
      settlementDisputeEarliestDueAt: null,
      openGateFlagCount: null,
      pendingStaffInvitationCount: null,
    });
    const anon = await svc.http.inject({ method: 'GET', url: '/v1/partner/todo-summary' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('F-07-12 SCR-063 공연 개요 읽기', () => {
  test('F-07-12 AC-03 PH-07 공연 개요는 회차·진행 단계·이미지를 주고 다른 파트너 공연은 404다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3]', async () => {
    const r = await get(`/v1/partner/productions/${onSale}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = body(r) as Record<string, unknown>;
    expect(d).toMatchObject({
      productionId: onSale,
      title: 'LUMEN 콘서트 2026 서울',
      genre: '콘서트',
      ageRating: '만 7세 이상',
      runningMinutes: 120,
      saleReview: 'APPROVED',
      hasApprovalHistory: true,
      hasPendingRevision: false,
      progressStage: 'SALE',
    });
    expect(Number(d.version)).toBeGreaterThanOrEqual(1);
    expect(d.place).toEqual({ placeId: PLACE, name: '피켓 아레나' });
    expect(d.artists).toEqual([expect.objectContaining({ name: '루멘' })]);
    expect(d.aliases).toEqual([]);
    expect(Array.isArray(d.events)).toBe(true);
    expect(d.events as unknown[]).toHaveLength(1);
    expect((d.events as Record<string, unknown>[])[0]).toMatchObject({
      eventId: onSaleEvent.id,
      pending: false,
      openAt: '2026-11-01T11:00:00.000Z',
      startsAt: '2026-12-24T10:00:00.000Z',
      endsAt: '2026-12-24T12:30:00.000Z',
      status: 'SCHEDULED',
      saleStatus: 'ON_SALE',
      soldPercent: 50,
    });
    const images = d.images as Record<string, unknown>[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ imageId: posterId, kind: 'POSTER', alt: 'LUMEN 포스터', order: 0, width: 1000, height: 1400 });
    expect(images[0]).not.toHaveProperty('storageKey');
    expect(images[0]).not.toHaveProperty('quarantineKey');
    expect(images[0]!.url).toMatch(new RegExp(`/production/${posterId}$`));
    for (const forbidden of ['promoterId', 'pendingRevision', 'salePolicy', 'seller']) {
      expect(d).not.toHaveProperty(forbidden);
    }

    for (const id of [otherTenant, randomUUID(), 'not-a-uuid']) {
      const miss = await get(`/v1/partner/productions/${id}`);
      expect(miss.statusCode, id).toBe(404);
      expect(problem(miss).type).toBe('https://peaket.example/problems/not-found');
      expect(miss.headers['cache-control']).toBe('no-store');
      expect(miss.payload).not.toContain('다른 파트너 공연');
    }
  });

  test('F-07-12 AC-03 PH-08 진행 단계는 등록·판매 승인·오픈·판매·입장·입장 기록 마감·정산 일곱 값이다', async () => {
    const cases: [string, string][] = [
      [stageDraft, 'REGISTRATION'],
      [stageReview, 'SALE_REVIEW'],
      [stageOpen, 'OPEN'],
      [stageSale, 'SALE'],
      [stageEntry, 'ENTRY'],
      [stageClosed, 'ENTRY_RECORD_CLOSED'],
      [stageSettlement, 'SETTLEMENT'],
    ];
    for (const [id, stage] of cases) {
      const r = await get(`/v1/partner/productions/${id}`);
      expect(r.statusCode, stage).toBe(200);
      expect(body(r).progressStage, stage).toBe(stage);
    }
  });

  test('F-07-12 AC-03 PH-09 회차는 시작 순이고 취소 회차도 계약 칸을 채운다', async () => {
    const r = await get(`/v1/partner/productions/${rejected}`);
    expect(r.statusCode).toBe(200);
    const events = body(r).events as Record<string, unknown>[];
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.status)).toEqual(['CANCELLED', 'SCHEDULED', 'SCHEDULED']);
    expect(events.map((e) => e.startsAt)).toEqual([...events.map((e) => e.startsAt)].sort());
    for (const e of events) {
      for (const key of ['eventId', 'version', 'pending', 'openAt', 'startsAt', 'endsAt', 'status']) expect(e).toHaveProperty(key);
    }
  });

  test('F-07-12 AC-03 PH-12 승인 뒤 변경분에만 있는 회차를 목록 수와 개요 pending true로 센다', async () => {
    const list = await get('/v1/partner/productions?saleReview=SUBMITTED&hasApprovalHistory=true');
    expect(list.statusCode).toBe(200);
    expect((body(list) as { items: { productionId: string; eventCount: number }[] }).items[0]).toMatchObject({ productionId: resubmitted, eventCount: 2 });

    const detail = await get(`/v1/partner/productions/${resubmitted}`);
    expect(detail.statusCode).toBe(200);
    const events = body(detail).events as { eventId: string; pending: boolean }[];
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.eventId === pendingEventId)).toMatchObject({ pending: true });
    expect(events.find((e) => e.eventId !== pendingEventId)).toMatchObject({ pending: false });
  });

  test('F-07-12 AC-03 PH-10 같은 공연을 두 번 읽어도 판·진행 단계가 같다', async () => {
    const first = await get(`/v1/partner/productions/${onSale}`);
    const second = await get(`/v1/partner/productions/${onSale}`);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const one = body(first);
    const two = body(second);
    expect(typeof one.version).toBe('number');
    expect(typeof one.progressStage).toBe('string');
    expect(two.version).toBe(one.version);
    expect(two.progressStage).toBe(one.progressStage);
  });

  test('F-07-12 AC-04 PH-11 판매자 정보는 소속 파트너 것만 주고 계정·계좌가 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const r = await get('/v1/partner/seller-profile');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = body(r) as { seller: Record<string, unknown>; verifiedAt: unknown; pendingChange: unknown };
    expect(d.seller).toMatchObject({
      legalName: '(주)피켓공연',
      representative: '대표자',
      address: '서울 어딘가 1',
      phone: '02-0000-0000',
      email: 'seller@example.test',
      businessRegNo: '123-45-67890',
      mailOrderReportNo: '2026-서울-0001',
    });
    expect(d.verifiedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(d.pendingChange).toBeNull();
    for (const forbidden of ['promoterId', 'accountId', 'payoutAccount']) expect(d).not.toHaveProperty(forbidden);

    const other = await get('/v1/partner/seller-profile', otherHeaders());
    expect(other.statusCode).toBe(200);
    expect((body(other) as { seller: { legalName: string } }).seller.legalName).toBe('(주)다른공연');

    const anon = await svc.http.inject({ method: 'GET', url: '/v1/partner/seller-profile' });
    expect(anon.statusCode).toBe(401);
  });
});
