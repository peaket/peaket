// 홈 피드 서버(SCR-001, GET /v1/home, BUILD_ORDER HOT-305, ADR-0199 결정 3, docs/features/search.md §2.4).
// 메모리 저장소로 계약 모양·줄 고르기·정렬·상한·빈 줄·캐시 머리를 본다. 실제 search_document 뷰는 test-int가 본다.
// 기준 트리에서는 GET /v1/home이 404라 이 파일의 시험이 모두 실패한다.
import 'reflect-metadata';
import { GetHomeResponse } from '@peaket/contracts/openapi/catalog';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import type { ProductionImageRow } from '../src/modules/catalog/domain/production-image.js';
import { FakeIdentity, IMAGE_ORIGIN_TEST, quiet, testMedia } from './support.js';

const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0';
const PLACE_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const PLACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const PLACE_C = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const at = (iso: string) => new Date(iso);
const hours = (n: number) => n * 3_600_000;
const days = (n: number) => n * 86_400_000;
const pid = (n: number) => `0194b197-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const eid = (n: number) => `0194b198-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const services: Awaited<ReturnType<typeof createService>>[] = [];

afterEach(async () => {
  for (const s of services) await s.close();
  services.length = 0;
  for (const key of Object.keys(LABELS)) delete LABELS[key];
});

interface ProdOptions {
  title?: string;
  placeId?: string;
  placeName?: string;
  saleReview?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  approved?: boolean;
  genre?: '콘서트' | '뮤지컬' | '연극';
  poster?: boolean;
}

const LABELS: Record<string, string> = {};
const placeName = (id: string) => LABELS[id] ?? (id === PLACE_A ? '에이홀' : id === PLACE_B ? '비홀' : '씨홀');

function production(repo: MemoryCatalogRepository, id: string, o: ProdOptions = {}): void {
  repo.productions.set(id, {
    id,
    promoterId: TENANT,
    placeId: o.placeId ?? PLACE_A,
    title: o.title ?? `공연 ${id.slice(-4)}`,
    genre: o.genre ?? '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: o.approved === false ? null : at('2026-10-01T00:00:00Z'),
  });
  if (o.poster !== false) {
    const imageId = `cccccccc-cccc-4ccc-8ccc-${id.slice(-12)}`;
    const row: ProductionImageRow = {
      id: imageId,
      productionId: id,
      promoterId: TENANT,
      kind: 'POSTER',
      alt: `${o.title ?? id} 포스터`,
      order: 0,
      width: 1000,
      height: 1400,
      version: 1,
      createdAt: at('2026-10-01T00:00:00Z'),
      updatedAt: at('2026-10-01T00:00:00Z'),
    };
    repo.images.set(imageId, row);
  }
}

function event(
  repo: MemoryCatalogRepository,
  id: string,
  productionId: string,
  o: { openAt: string; startsAt: string; sale: 'UPCOMING' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED'; placeId?: string; status?: 'SCHEDULED' | 'CANCELLED' | 'POSTPONED' },
): void {
  const placeId = o.placeId ?? PLACE_A;
  repo.events.set(id, { id, productionId, venueId: null, openAt: at(o.openAt), startsAt: at(o.startsAt), status: o.status ?? 'SCHEDULED' });
  repo.saleStates.set(id, o.sale);
  repo.details.set(id, {
    event: { endsAt: new Date(at(o.startsAt).getTime() + hours(2)) },
    place: { id: placeId, name: placeName(placeId), address: '서울' },
    artists: [],
  });
  repo.places.add(placeId);
  if (!repo.placeNames.some((p) => p.id === placeId)) repo.placeNames.push({ id: placeId, name: placeName(placeId), address: '서울', aliases: [] });
}

async function boot(o: { seed?: (repo: MemoryCatalogRepository) => void; home?: unknown; media?: ReturnType<typeof testMedia> } = {}): Promise<Awaited<ReturnType<typeof createService>>> {
  const repo = new MemoryCatalogRepository();
  o.seed?.(repo);
  const svc = await createService({
    name: 'core-svc-home',
    module: AppModule.register({ memory: true, catalog: repo, media: o.media ?? testMedia(), ...(o.home !== undefined ? { home: o.home } : {}) } as never),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  services.push(svc);
  return svc;
}

const getHome = async (s: Awaited<ReturnType<typeof createService>>) => s.http.inject({ method: 'GET', url: '/v1/home' });
const bodyOf = (r: { payload: string }) => GetHomeResponse.parse(JSON.parse(r.payload));

describe('홈 피드(HOT-305)', () => {
  test('HOT-305 빈 피드는 계약 모양·랭킹 경로·생성 시각·캐시 머리를 지키고 개인 값을 싣지 않는다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-14.2.5]', async () => {
    const s = await boot();
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=30, stale-if-error=86400');
    const body = bodyOf(r);
    expect(body).toMatchObject({
      banners: [],
      upcoming: [],
      onSale: [],
      themes: [],
      places: [],
      rankingsPath: '/v1/home/rankings.json',
      generatedAt: new Date(NOW).toISOString(),
    });
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain('accountid');
    expect(text).not.toContain('cookie');
    expect(text).not.toContain('authorization');
  });

  test('HOT-305 오픈 예정은 공개 공연만 다음 오픈이 이른 순·ID 순으로 10개까지 싣는다 [ASVS v5.0.0-2.1.3]', async () => {
    const s = await boot({
      seed: (repo) => {
        for (let i = 1; i <= 12; i++) {
          production(repo, pid(i), { title: `오픈 ${i}` });
          event(repo, eid(i), pid(i), { openAt: new Date(NOW + hours(i)).toISOString(), startsAt: new Date(NOW + days(90 + i)).toISOString(), sale: 'UPCOMING' });
        }
        // 같은 오픈 시각은 ID 오름차순
        production(repo, pid(30), { title: '같은 시각 낮은 ID' });
        event(repo, eid(30), pid(30), { openAt: new Date(NOW + hours(1)).toISOString(), startsAt: new Date(NOW + days(120)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(31), { title: '같은 시각 높은 ID' });
        event(repo, eid(31), pid(31), { openAt: new Date(NOW + hours(1)).toISOString(), startsAt: new Date(NOW + days(121)).toISOString(), sale: 'UPCOMING' });
        // 승인 전·반려·중지·끝남은 없다
        production(repo, pid(40), { saleReview: 'SUBMITTED', approved: false });
        event(repo, eid(40), pid(40), { openAt: new Date(NOW + hours(1)).toISOString(), startsAt: new Date(NOW + days(130)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(41), { saleReview: 'REJECTED', approved: false });
        event(repo, eid(41), pid(41), { openAt: new Date(NOW + hours(1)).toISOString(), startsAt: new Date(NOW + days(131)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(42), { saleReview: 'SUSPENDED' });
        event(repo, eid(42), pid(42), { openAt: new Date(NOW + hours(1)).toISOString(), startsAt: new Date(NOW + days(132)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(43));
        event(repo, eid(43), pid(43), { openAt: new Date(NOW - days(30)).toISOString(), startsAt: new Date(NOW - days(1)).toISOString(), sale: 'ENDED' });
      },
    });
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    const body = bodyOf(r);
    expect(body.upcoming).toHaveLength(10);
    // 후보: pid(30)·pid(31)이 1시간, pid(1)이 1시간, pid(2) 2시간 … 순서는 시각 뒤 ID.
    // pid(1) < pid(30) < pid(31)이므로 1시간 무리의 차례는 pid(1), pid(30), pid(31)이다.
    const expected = [pid(1), pid(30), pid(31), pid(2), pid(3), pid(4), pid(5), pid(6), pid(7), pid(8)];
    expect(body.upcoming?.map((c) => c.productionId)).toEqual(expected);
    expect(body.upcoming?.every((c) => c.saleStatus === 'UPCOMING')).toBe(true);
    expect(body.upcoming?.[0]).toMatchObject({ eventId: eid(1), title: '오픈 1', genre: '콘서트', nextOpenAt: new Date(NOW + hours(1)).toISOString(), nextOpenEventId: eid(1), placeName: '에이홀', posterAlt: '오픈 1 포스터' });
    expect(body.upcoming?.[0]?.posterUrl).toMatch(new RegExp(`^${IMAGE_ORIGIN_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/production/`));
    expect(body.upcoming?.[0]?.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ids = new Set(body.upcoming?.map((c) => c.productionId));
    for (const absent of [pid(40), pid(41), pid(42), pid(43)]) expect(ids.has(absent)).toBe(false);
  });

  test('HOT-305 지금 판매 중은 판매 종료가 이른 순·ID 순으로 9개까지 싣고 saleEndsAt을 정확히 준다 [ASVS v5.0.0-2.1.3]', async () => {
    const s = await boot({
      seed: (repo) => {
        for (let i = 1; i <= 10; i++) {
          production(repo, pid(i), { title: `판매 ${i}` });
          event(repo, eid(i), pid(i), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(i)).toISOString(), sale: 'ON_SALE' });
        }
        // 같은 판매 종료 시각은 ID 오름차순
        production(repo, pid(20), { title: '같은 종료 낮은 ID' });
        event(repo, eid(20), pid(20), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(1)).toISOString(), sale: 'ON_SALE' });
        production(repo, pid(21), { title: '같은 종료 높은 ID' });
        event(repo, eid(21), pid(21), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(1)).toISOString(), sale: 'ON_SALE' });
        // 오픈 전·매진·끝남은 없다
        production(repo, pid(30));
        event(repo, eid(30), pid(30), { openAt: new Date(NOW + days(1)).toISOString(), startsAt: new Date(NOW + days(20)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(31));
        event(repo, eid(31), pid(31), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(3)).toISOString(), sale: 'SOLD_OUT' });
        production(repo, pid(32));
        event(repo, eid(32), pid(32), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW - days(1)).toISOString(), sale: 'ENDED' });
      },
    });
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    const body = bodyOf(r);
    expect(body.onSale).toHaveLength(9);
    // 1일 뒤 시작(2개, ID 차례) → 2일 → … → 9일
    const expected = [pid(1), pid(20), pid(21), pid(2), pid(3), pid(4), pid(5), pid(6), pid(7)];
    expect(body.onSale?.map((c) => c.productionId)).toEqual(expected);
    expect(body.onSale?.[0]?.saleEndsAt).toBe(new Date(NOW + days(1) - hours(24)).toISOString());
    expect(body.onSale?.[0]?.saleStatus).toBe('ON_SALE');
    const ids = new Set(body.onSale?.map((c) => c.productionId));
    for (const absent of [pid(30), pid(31), pid(32)]) expect(ids.has(absent)).toBe(false);
  });

  test('HOT-305 공연장 줄은 공연이 있는 곳만 공연 수·이름·ID 순으로 10개까지 싣고 initial을 준다', async () => {
    const places = [PLACE_A, PLACE_B, PLACE_C, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const names: Record<string, string> = { [PLACE_A]: '가홀', [PLACE_B]: '나홀', [PLACE_C]: '다홀' };
    places.forEach((p, i) => (names[p] = names[p] ?? `${'가나다라마바사아자차카'[i]}홀`));
    Object.assign(LABELS, names);
    const s = await boot({
      seed: (repo) => {
        // 에이홀 3, 비홀 2, 나머지 1씩. 오픈 예정 10 + 판매 중 10으로 11곳이 모두 보이게 한다.
        const up = [places[0]!, places[0]!, places[1]!, places[1]!, ...places.slice(2, 8)];
        up.forEach((placeId, i) => {
          const id = pid(100 + i);
          production(repo, id, { placeId, title: `오픈 ${i}` });
          event(repo, eid(100 + i), id, { openAt: new Date(NOW + hours(i + 1)).toISOString(), startsAt: new Date(NOW + days(90 + i)).toISOString(), sale: 'UPCOMING', placeId });
        });
        const sale = [places[8]!, places[9]!, places[10]!, places[0]!, places[1]!, places[2]!, places[3]!, places[4]!, places[5]!, places[6]!];
        sale.forEach((placeId, i) => {
          const id = pid(200 + i);
          production(repo, id, { placeId, title: `판매 ${i}` });
          event(repo, eid(200 + i), id, { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(i + 1)).toISOString(), sale: 'ON_SALE', placeId });
        });
      },
    });
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    const body = bodyOf(r);
    expect(body.places).toHaveLength(10);
    expect(body.places?.[0]).toEqual({ placeId: PLACE_A, name: '가홀', initial: '가' });
    expect(body.places?.[1]).toEqual({ placeId: PLACE_B, name: '나홀', initial: '나' });
    expect(new Set(body.places?.map((p) => p.placeId)).size).toBe(10);
  });

  test('HOT-305 배너·테마는 노출 기간·공개 공연·정렬·상한을 지키고 빈 테마는 싣지 않는다 [ASVS v5.0.0-2.1.1] [ASVS v5.0.0-2.1.3]', async () => {
    const s = await boot({
      seed: (repo) => {
        production(repo, pid(1), { title: '판매 중 공연' });
        event(repo, eid(1), pid(1), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(10)).toISOString(), sale: 'ON_SALE' });
        production(repo, pid(2), { title: '오픈 예정 공연' });
        event(repo, eid(2), pid(2), { openAt: new Date(NOW + days(1)).toISOString(), startsAt: new Date(NOW + days(20)).toISOString(), sale: 'UPCOMING' });
        production(repo, pid(3), { title: '중지 공연', saleReview: 'SUSPENDED' });
        event(repo, eid(3), pid(3), { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(10)).toISOString(), sale: 'ON_SALE' });
      },
      home: {
        banners: [
          { bannerId: 'b1', productionId: pid(1), eventId: eid(1), title: '첫 배너', subtitle: '11/20', imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b1`, alt: '첫 배너 그림', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 2 },
          { bannerId: 'b2', productionId: pid(2), eventId: eid(2), title: '둘째 배너', imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b2`, alt: '둘째 배너 그림', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 1 },
          { bannerId: 'b3', productionId: pid(3), eventId: eid(3), imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b3`, alt: '중지 공연 배너', displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 0 },
          { bannerId: 'b4', productionId: pid(1), eventId: eid(1), imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b4`, alt: '끝난 배너', displayFrom: '2026-10-01T00:00:00.000Z', displayUntil: new Date(NOW).toISOString(), sortOrder: 0 },
          { bannerId: 'b5', productionId: pid(2), eventId: eid(2), imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b5`, alt: '시작 경계 배너', displayFrom: new Date(NOW).toISOString(), displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 3 },
        ],
        themes: [
          { themeId: 't1', name: '루멘 테마', productionIds: [pid(2), pid(1), pid(3)], displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 2 },
          { themeId: 't2', name: '빈 테마', productionIds: [pid(3)], displayFrom: '2026-11-01T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 1 },
          { themeId: 't3', name: '끝난 테마', productionIds: [pid(1)], displayFrom: '2026-10-01T00:00:00.000Z', displayUntil: new Date(NOW).toISOString(), sortOrder: 0 },
          { themeId: 't4', name: '시작 경계 테마', productionIds: [pid(1)], displayFrom: new Date(NOW).toISOString(), displayUntil: '2026-12-01T00:00:00.000Z', sortOrder: 3 },
        ],
      },
    });
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    const body = bodyOf(r);
    expect(body.banners?.map((b) => b.bannerId)).toEqual(['b2', 'b1', 'b5']);
    expect(body.banners?.[0]).toMatchObject({ productionId: pid(2), eventId: eid(2), title: '둘째 배너', imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/b2`, alt: '둘째 배너 그림', displayUntil: '2026-12-01T00:00:00.000Z' });
    expect(body.themes?.map((t) => t.themeId)).toEqual(['t1', 't4']);
    expect(body.themes?.[0]?.productions?.map((c) => c.productionId)).toEqual([pid(2), pid(1)]);
    expect(body.themes?.[1]?.productions?.map((c) => c.productionId)).toEqual([pid(1)]);
  });

  test('HOT-305 배너 10·테마 5·테마 항목 20 상한을 넘지 않는다', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => pid(300 + i));
    const banners = Array.from({ length: 12 }, (_, i) => ({
      bannerId: pid(400 + i),
      productionId: ids[0]!,
      eventId: eid(300),
      imageUrl: `${IMAGE_ORIGIN_TEST}/home-banners/${i}`,
      alt: `배너 ${i}`,
      displayFrom: '2026-11-01T00:00:00.000Z',
      displayUntil: '2026-12-01T00:00:00.000Z',
      sortOrder: i,
    }));
    const themes = Array.from({ length: 6 }, (_, i) => ({
      themeId: pid(500 + i),
      name: `테마 ${i}`,
      productionIds: i === 0 ? ids : [ids[0]!],
      displayFrom: '2026-11-01T00:00:00.000Z',
      displayUntil: '2026-12-01T00:00:00.000Z',
      sortOrder: i,
    }));
    const s = await boot({
      seed: (repo) => {
        ids.forEach((id, i) => {
          production(repo, id, { title: `공연 ${i}` });
          event(repo, eid(300 + i), id, { openAt: new Date(NOW - days(10)).toISOString(), startsAt: new Date(NOW + days(10 + i)).toISOString(), sale: 'ON_SALE' });
        });
      },
      home: { banners, themes },
    });
    const r = await getHome(s);
    expect(r.statusCode).toBe(200);
    const body = bodyOf(r);
    expect(body.banners).toHaveLength(10);
    expect(body.banners?.map((b) => b.bannerId)).toEqual(banners.slice(0, 10).map((b) => b.bannerId));
    expect(body.themes).toHaveLength(5);
    expect(body.themes?.map((t) => t.themeId)).toEqual(themes.slice(0, 5).map((t) => t.themeId));
    expect(body.themes?.[0]?.productions).toHaveLength(20);
    expect(body.themes?.[0]?.productions?.map((c) => c.productionId)).toEqual(ids.slice(0, 20));
  });

  test('HOT-305 원천이 실패하면 배너·테마만 비우고 200이며, 검색 원천이 실패하면 503·no-store다 [ASVS v5.0.0-16.5.2]', async () => {
    const degraded = await boot({
      home: {
        source: {
          documents: async () => [],
          banners: async () => {
            throw new Error('banner store down');
          },
          themes: async () => {
            throw new Error('theme store down');
          },
        },
      },
    });
    const r = await getHome(degraded);
    expect(r.statusCode).toBe(200);
    expect(bodyOf(r)).toMatchObject({ banners: [], upcoming: [], onSale: [], themes: [], places: [], rankingsPath: '/v1/home/rankings.json' });

    const unknown = await degraded.http.inject({ method: 'GET', url: '/v1/home/unknown' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['cache-control']).toBe('no-store');

    const failedSvc = await boot({
      home: {
        source: {
          documents: async () => {
            throw new Error('search document down');
          },
          banners: async () => [],
          themes: async () => [],
        },
      },
    });
    const failed = await getHome(failedSvc);
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(failed.headers['retry-after']).toBeDefined();
  });
});
