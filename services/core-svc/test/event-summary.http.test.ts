// 받는 층: 회차 공개 요약(openapi GET /v1/events/{eventId}, authz-matrix §3.5, ADR-0093 결정 7, BUILD_ORDER HOT-170 ①)
import 'reflect-metadata';
import { GetEventResponse } from '@peaket/contracts/openapi/catalog';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import type { Production, SaleReview } from '../src/modules/catalog/index.js';
import { FakeIdentity, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const PROMOTER = randomUUID();
const STARTS = new Date('2026-12-24T10:00:00.000Z');

beforeAll(async () => {
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

/** 공연 하나와 회차 하나를 넣고 회차 ID를 돌려준다 */
function seed(saleReview: SaleReview, saleApprovedAt: Date | null): string {
  const p: Production = { id: randomUUID(), promoterId: PROMOTER, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview, saleApprovedAt };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-12-01T03:00:00Z'), startsAt: STARTS, status: 'SCHEDULED' });
  return eventId;
}
const get = (eventId: string, headers: Record<string, string> = {}) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}`, headers });

describe('회차 공개 요약', () => {
  test('판매승인된공연의회차는_계약모양의요약과_공개캐시머리로답한다', async () => {
    const id = seed('APPROVED', new Date('2026-11-20T00:00:00Z'));
    const r = await get(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300, stale-if-error=86400');
    expect(r.headers['x-peaket-cache-tag']).toBe(`event:${id},production:${repo.events.get(id)?.productionId}`);
    expect(r.headers['set-cookie']).toBeUndefined();
    const body = JSON.parse(r.payload);
    expect(GetEventResponse.parse(body)).toMatchObject({ eventId: id, productionId: repo.events.get(id)?.productionId, title: '겨울 콘서트', sellerName: '(주)피켓공연', status: 'SCHEDULED', queueOrder: 'HYBRID', seatAssignment: 'PICK', perPersonLimit: 4, reentryAllowed: false, badges: ['HYBRID'] });
    expect(body.seller).toBeUndefined();
    expect(body.rounds.map((x: { eventId: string }) => x.eventId)).toContain(id);
  });

  test('공연상세칸을_공연·회차·공연장·아티스트·판매자에서_채운다', async () => {
    const id = seed('APPROVED', new Date('2026-11-20T00:00:00Z'));
    const placeId = randomUUID();
    const artistId = randomUUID();
    repo.details.set(id, {
      place: { id: placeId, name: '피켓홀', address: '서울 어딘가 1' },
      artists: [{ artistId, name: '별빛 앙상블' }],
      production: { ageRating: '만 7세 이상', runningMinutes: 150, description: '설명 글' },
      event: { lobbyShuffle: false, openBatch: true, seatAssignment: 'AUTO', perPersonLimit: 2, reentryAllowed: true, entryOpensAt: new Date('2026-12-24T09:00:00Z') },
      seller: { representative: '김피켓', address: '서울 어딘가 1', phone: '02-0000-0000', email: 'seller@peaket.example', businessRegNo: '123-45-67890', mailOrderReportNo: '제2026-1호' },
    });
    const body = GetEventResponse.parse(JSON.parse((await get(id)).payload));
    expect(body).toMatchObject({ genre: '콘서트', ageRating: '만 7세 이상', runningMinutes: 150, descriptionText: '설명 글', placeId, placeName: '피켓홀', placeAddress: '서울 어딘가 1', artists: [{ artistId, name: '별빛 앙상블' }], queueOrder: 'FIFO', lobbyOpensAt: null, seatAssignment: 'AUTO', perPersonLimit: 2, reentryAllowed: true, entryOpensAt: '2026-12-24T09:00:00.000Z', badges: ['FIFO', 'AUTO_SEAT'], saleEndsAt: '2026-12-23T10:00:00.000Z', seller: { legalName: '(주)피켓공연', representative: '김피켓', mailOrderReportNo: '제2026-1호' } });
  });

  test('[ASVS v5.0.0-8.1.1] 승인뒤바꾼내용의재승인대기·반려중에도_마지막승인내용으로공개는이어진다', async () => {
    const at = new Date('2026-11-20T00:00:00Z');
    expect((await get(seed('SUBMITTED', at))).statusCode).toBe(200);
    expect((await get(seed('REJECTED', at))).statusCode).toBe(200);
  });

  test('[ASVS v5.0.0-8.1.1] 한번공개된뒤판매중지된회차는_410 event-suspended이고_캐시하지않는다', async () => {
    const r = await get(seed('SUSPENDED', new Date('2026-11-20T00:00:00Z')));
    expect(r.statusCode).toBe(410);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/event-suspended', status: 410 });
    expect(r.payload).not.toContain('사유');
  });

  test('[ASVS v5.0.0-8.1.1] 판매승인전·없는회차·모양이틀린ID는_모두같은404이고_캐시하지않는다', async () => {
    const cases = [seed('DRAFT', null), seed('SUBMITTED', null), seed('REJECTED', null), randomUUID(), 'not-a-uuid'];
    const bodies = [];
    for (const id of cases) {
      const r = await get(id);
      expect(r.statusCode).toBe(404);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-peaket-cache-tag']).toBeUndefined();
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      const { type, title, status } = JSON.parse(r.payload);
      bodies.push({ type, title, status });
    }
    for (const b of bodies) expect(b).toEqual({ type: 'https://peaket.example/problems/not-found', title: '찾을 수 없습니다', status: 404 });
  });

  test('인증없는경로라_쿠키가있어도_같은공개응답이다(쿠키를캐시키에넣지않는다)', async () => {
    const id = seed('APPROVED', new Date('2026-11-20T00:00:00Z'));
    const plain = await get(id);
    const withCookie = await get(id, { cookie: 'peaket_session=anything' });
    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.payload).toBe(plain.payload);
    expect(withCookie.headers['cache-control']).toBe(plain.headers['cache-control']);
  });

  test('대문자로부른주소도_같은요약이고_CDN태그는DB의소문자ID라_한번의태그무효화로함께지워진다', async () => {
    const id = seed('APPROVED', new Date('2026-11-20T00:00:00Z'));
    repo.events.set(id.toUpperCase(), repo.events.get(id)!);
    const r = await get(id.toUpperCase());
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-peaket-cache-tag']).toBe(`event:${id},production:${repo.events.get(id)?.productionId}`);
  });

  // 경로 칸이 100자를 넘으면 그 전에 Fastify가 414로 막는다(maxParamLength 기본값, 모든 서비스 같음)
  test('긴ID도_계약에없는400이아니라_없는회차와같은404다', async () => {
    const r = await get('a'.repeat(100));
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload).type).toBe('https://peaket.example/problems/not-found');
  });
});
