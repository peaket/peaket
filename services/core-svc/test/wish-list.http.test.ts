// GAT-260 찜 목록 HTTP(openapi listWishes, ADR-0063·ADR-0198 결정 5, BUILD_ORDER F-05-8).
// 기준 트리에서는 GET /v1/wishes가 없어 404라 모두 실패한다(시험 먼저).
import 'reflect-metadata';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type SaleReview } from '../src/modules/catalog/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const clock: FakeClock = fakeClock({ now: NOW_MS });
const ME = randomUUID();
const OTHER = randomUUID();

beforeAll(async () => {
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci' }, clock, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

interface Seeded {
  productionId: string;
  eventId: string;
}

/** 공개 공연 한 벌(메모리): 판매 승인 공연·회차·공연장 이름. startsAt 기본값은 2026-12-24(판매 중) */
function seed(o: { title?: string; saleReview?: SaleReview; saleApprovedAt?: Date | null; startsAt?: Date; openAt?: Date } = {}): Seeded {
  const productionId = randomUUID();
  const eventId = randomUUID();
  const placeId = randomUUID();
  const startsAt = o.startsAt ?? new Date('2026-12-24T10:00:00Z');
  repo.productions.set(productionId, {
    id: productionId,
    promoterId: randomUUID(),
    placeId,
    title: o.title ?? '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: o.saleApprovedAt === undefined ? new Date('2026-11-01T00:00:00Z') : o.saleApprovedAt,
  });
  repo.events.set(eventId, {
    id: eventId,
    productionId,
    venueId: null,
    openAt: o.openAt ?? new Date('2026-11-01T00:00:00Z'),
    startsAt,
    status: 'SCHEDULED',
  });
  repo.details.set(eventId, { place: { id: placeId, name: '피켓홀', address: '서울 어딘가 1' }, event: { endsAt: new Date(startsAt.getTime() + 2 * 3_600_000) } });
  return { productionId, eventId };
}

function wish(accountId: string, productionId: string, atMs: number): void {
  const mine = repo.wishes.get(accountId) ?? new Map<string, Date>();
  mine.set(productionId, new Date(atMs));
  repo.wishes.set(accountId, mine);
}

const list = (accountId: string, query = '') => svc.http.inject({ method: 'GET', url: `/v1/wishes${query}`, headers: fan(accountId) });

interface Page {
  items: { productionId: string; eventId?: string; title?: string; placeName?: string; periodStart?: string; periodEnd?: string; saleStatus?: string; badges?: string[] }[];
  nextCursor: string | null;
}

describe('찜 목록', () => {
  test('GAT-260 내 찜 목록은 최근 찜한 순이고 productionIds로 찜한 것만 준다', async () => {
    const a = seed({ title: '첫 공연' });
    const b = seed({ title: '둘째 공연' });
    const c = seed({ title: '찜 안 한 공연' });
    wish(ME, a.productionId, NOW_MS - 120_000);
    wish(ME, b.productionId, NOW_MS - 60_000);
    wish(OTHER, c.productionId, NOW_MS - 30_000);

    const r = await list(ME);
    expect(r.statusCode).toBe(200);
    const page = JSON.parse(r.payload) as Page;
    expect(page.items.map((x) => x.productionId)).toEqual([b.productionId, a.productionId]);
    expect(page.items[0]).toMatchObject({ eventId: b.eventId, title: '둘째 공연', genre: '콘서트', placeName: '피켓홀', periodStart: '2026-12-24', periodEnd: '2026-12-24', saleStatus: 'ON_SALE' });
    expect(page.nextCursor).toBeNull();

    const only = await list(ME, `?productionIds=${b.productionId},${c.productionId}`);
    expect(only.statusCode).toBe(200);
    expect((JSON.parse(only.payload) as Page).items.map((x) => x.productionId)).toEqual([b.productionId]);
  });

  test('GAT-260 ProductionCard.badges는 대표 회차의 정렬·선예매·좌석 배정을 실제 값으로 싣는다', async () => {
    const s = seed({ title: '배지 공연' });
    // FIFO(로비 셔플 끔) + AUTO_SEAT + 지금 열려 있는 팬클럽 선예매
    repo.details.set(s.eventId, {
      ...repo.details.get(s.eventId),
      event: { ...(repo.details.get(s.eventId)?.event ?? {}), lobbyShuffle: false, openBatch: true, seatAssignment: 'AUTO' },
    });
    repo.salePolicies.set(s.productionId, {
      version: 1,
      rules: [
        {
          version: 1,
          name: '팬클럽 선예매',
          rounds: 'ALL',
          during: { from: '2026-11-04T00:00:00Z', to: '2026-11-06T00:00:00Z' },
          rule: { if: { fact: 'buyer.lists', has: 'lumen' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
        },
      ],
    });
    wish(ME, s.productionId, NOW_MS - 1_000);

    const r = await list(ME, `?productionIds=${s.productionId}`);
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.payload) as Page).items[0]?.badges).toEqual(['FIFO', 'PRESALE', 'AUTO_SEAT']);
  });

  test('[ASVS v5.0.0-8.2.2] 남의 찜은 목록에 없고 내 찜만 온다', async () => {
    const mine = seed({ title: '내 공연' });
    const theirs = seed({ title: '남의 공연' });
    wish(ME, mine.productionId, NOW_MS - 10_000);
    wish(OTHER, theirs.productionId, NOW_MS - 5_000);

    const r = await list(ME);
    expect(r.statusCode).toBe(200);
    const ids = (JSON.parse(r.payload) as Page).items.map((x) => x.productionId);
    expect(ids).toContain(mine.productionId);
    expect(ids).not.toContain(theirs.productionId);

    // 남의 공연 ID를 productionIds에 넣어도 내 찜만 온다(있는지 여부를 알리지 않는다)
    const probe = await list(ME, `?productionIds=${theirs.productionId}`);
    expect((JSON.parse(probe.payload) as Page).items).toEqual([]);
  });

  test('GAT-260 커서로 다음 쪽을 받고 겹치거나 빠진 찜이 없으며 잘못된 커서는 400이다', async () => {
    const seeded = [seed({ title: '하나' }), seed({ title: '둘' }), seed({ title: '셋' }), seed({ title: '넷' }), seed({ title: '다섯' })];
    seeded.forEach((s, i) => wish(OTHER + '-cursor', s.productionId, NOW_MS - (5 - i) * 60_000));

    const first = await list(OTHER + '-cursor', '?limit=2');
    expect(first.statusCode).toBe(200);
    const p1 = JSON.parse(first.payload) as Page;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    const second = await list(OTHER + '-cursor', `?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    const p2 = JSON.parse(second.payload) as Page;
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).not.toBeNull();

    const third = await list(OTHER + '-cursor', `?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}`);
    const p3 = JSON.parse(third.payload) as Page;
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();

    const all = [...p1.items, ...p2.items, ...p3.items].map((x) => x.productionId);
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual(seeded.map((s) => s.productionId).reverse());

    expect((await list(ME, '?cursor=not-a-cursor')).statusCode).toBe(400);
    expect(JSON.parse((await list(ME, '?cursor=not-a-cursor')).payload).type).toBe('https://peaket.example/problems/invalid-query');
    expect((await list(ME, '?limit=101')).statusCode).toBe(400);
    expect((await list(ME, `?productionIds=${Array.from({ length: 51 }, () => randomUUID()).join(',')}`)).statusCode).toBe(400);
  });

  test('GAT-260 판매 승인 취소·중지 공연은 목록에서 빠진다', async () => {
    const approved = seed({ title: '공개 공연' });
    const suspended = seed({ title: '판매 중지', saleReview: 'SUSPENDED' });
    const draft = seed({ title: '승인 전', saleReview: 'DRAFT', saleApprovedAt: null });
    const cancelled = seed({ title: '회차 취소' });
    repo.events.get(cancelled.eventId)!.status = 'CANCELLED';
    for (const s of [approved, suspended, draft, cancelled]) wish(ME + '-filter', s.productionId, NOW_MS);

    const r = await list(ME + '-filter');
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.payload) as Page).items.map((x) => x.productionId)).toEqual([approved.productionId]);
  });

  test('GAT-260 응답은 private, no-store이고 세션 없이는 401이다', async () => {
    const p = seed();
    wish(ME + '-header', p.productionId, NOW_MS);
    const r = await list(ME + '-header');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');

    expect((await svc.http.inject({ method: 'GET', url: '/v1/wishes' })).statusCode).toBe(401);
  });
});
