// 받는 층: 좌석맵 불러오기·저장(openapi getPartnerProductionSeatmap·putPartnerProductionSeatmap, ADR-0260, BUILD_ORDER HOT-240).
// 메모리 저장소로 응답이 계약 응답 스키마에 맞는지와 회차 더하기·공연 상세의 연결을 본다. 실제 DB·파일은 test-int/seatmap-save.int.test.ts가 본다
import 'reflect-metadata';
import { GetEventResponse } from '@peaket/contracts/openapi/catalog';
import { GetPartnerProductionSeatmapResponse, PutPartnerProductionSeatmapResponse } from '@peaket/contracts/openapi/partner';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { layoutVenueId } from '../src/modules/catalog/domain/seatmap-layout.js';
import { MemoryCatalogRepository, MemoryPublicFileStore } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const files = new MemoryPublicFileStore();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PROD = randomUUID();
const EVENT = randomUUID();
const TEMPLATE = randomUUID();
const P = 'https://peaket.example/problems/';

const sq = (x: number, w: number): [number, number][] => [
  [x, 0],
  [x + w, 0],
  [x + w, w],
  [x, w],
];
const TIERS = [
  { tierId: 'S', name: 'S석', price: 99_000 },
  { tierId: 'R', name: 'R석', price: 150_000 },
];
const body = (o: Record<string, unknown> = {}) => ({
  canvas: { width: 1000, height: 600 },
  sections: [{ sectionId: 'A', name: 'A구역', shape: { kind: 'POLYGON', points: sq(0, 400) }, tierId: 'R', seats: [1, 2].map((n) => ({ seatId: `A-1-${n}`, row: '1', number: n, x: n * 10, y: 10 })) }],
  priceTiers: TIERS,
  ...o,
});

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.productions.set(PROD, { id: PROD, promoterId: TENANT, placeId: null, title: '겨울 콘서트', genre: '콘서트', saleReview: 'DRAFT', saleApprovedAt: null });
  repo.events.set(EVENT, { id: EVENT, productionId: PROD, venueId: null, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), status: 'SCHEDULED' });
  repo.templates.set(TEMPLATE, { doc: { canvas: { width: 500, height: 500 }, stage: [], sections: [{ sectionId: 'F', name: '플로어', shape: { kind: 'RECT', points: sq(0, 100) }, seats: [] }], priceTiers: [] }, published: true });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, media: { publicFiles: files } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const h = () => identity.partner(TENANT, 'partner_member');
const put = (b: unknown, ifMatch?: string) => svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${PROD}/seatmap`, headers: { ...h(), 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(b) });
const get = (q = '') => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${PROD}/seatmap${q}`, headers: h() });

describe('좌석맵 불러오기·저장(메모리)', () => {
  test('S-T38 ⑨ 배치본이 없으면 공개된 틀의 판 0 초안을 계약 모양으로 주고 ETag는 "0"이다', async () => {
    expect((await get()).statusCode).toBe(404);
    const r = await get(`?fromTemplate=${TEMPLATE}`);
    expect([r.statusCode, r.headers.etag, r.headers['cache-control']]).toEqual([200, '"0"', 'no-store']);
    const out = GetPartnerProductionSeatmapResponse.parse(JSON.parse(r.payload));
    expect(out).toMatchObject({ layoutVersion: 0, templateVenueId: TEMPLATE, priceTiers: [] });
    // 정의 밖 쿼리·겹친 쿼리는 400이다
    expect((await get(`?fromTemplate=${TEMPLATE}&x=1`)).statusCode).toBe(400);
  });

  test('S-T38 ② 저장 응답·불러오기 응답이 계약 모양이고 회차에 배치본을 이으며 팬 파일을 쓴다', async () => {
    const r = await put(body(), '"0"');
    expect([r.statusCode, r.headers.etag, r.headers['cache-control']]).toEqual([200, '"1"', 'no-store']);
    const saved = PutPartnerProductionSeatmapResponse.parse(JSON.parse(r.payload));
    expect(saved).toMatchObject({ layoutVersion: 1, fanFilePublished: true, priceTiers: TIERS });
    expect(saved.sections![0]!.seatIndexRange).toEqual({ from: 0, to: 1 });
    expect(repo.events.get(EVENT)!.venueId).toBe(layoutVenueId(PROD));
    expect([...files.files.keys()]).toEqual([`v1/events/${EVENT}/seatmap-layouts/1.json`]);
    const g = await get();
    expect(GetPartnerProductionSeatmapResponse.parse(JSON.parse(g.payload))).toMatchObject({ layoutVersion: 1, priceTiers: TIERS });
    // 옛 판·없는 If-Match
    expect(JSON.parse((await put(body(), '"0"')).payload).type).toBe(`${P}precondition-failed`);
    expect((await put(body())).statusCode).toBe(428);
  });

  test('S-T38 ⑧ 승인된 공연의 공연 상세는 가격 등급을 보이는 순서로 싣는다(계약 모양)', async () => {
    repo.productions.set(PROD, { ...repo.productions.get(PROD)!, saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') });
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${EVENT}` });
    expect(r.statusCode).toBe(200);
    expect(GetEventResponse.parse(JSON.parse(r.payload)).priceTiers).toEqual(TIERS);
  });
});
