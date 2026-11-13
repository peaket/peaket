// 받는 층: 관제 수요 예측·규모 올리기(BUILD_ORDER BAT-620, ADR-0078 결정 1, POL-030).
// 판매 승인된 회차의 예측을 viewer 이상이 읽고, operator 이상이 더 큰 규모로만 올린다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const OPEN = new Date('2026-11-20T11:00:00.000Z');
const PROMOTER = randomUUID();
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
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

function seed(o: { saleReview?: Production['saleReview']; openAt?: Date; scale?: 'LARGE' | 'MEDIUM' | 'SMALL'; status?: 'SCHEDULED' | 'CANCELLED' } = {}): { eventId: string; productionId: string } {
  const productionId = randomUUID();
  repo.productions.set(productionId, {
    id: productionId,
    promoterId: PROMOTER,
    placeId: randomUUID(),
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: new Date('2026-11-01T00:00:00.000Z'),
  });
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId, venueId: randomUUID(), openAt: o.openAt ?? OPEN, startsAt: new Date('2026-12-24T10:00:00.000Z'), status: o.status ?? 'SCHEDULED' });
  repo.eventScales.set(eventId, o.scale ?? 'SMALL');
  return { eventId, productionId };
}

const forecast = (eventId: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url: `/v1/ops/events/${eventId}/demand-forecast`, headers });
const scaleChange = (eventId: string, headers: Record<string, string>, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/events/${eventId}/scale-changes`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('GET /v1/ops/events/{eventId}/demand-forecast', () => {
  test('C-T43  viewer는 기본 비율 예측과 지금 규모·올리기 제안을 읽는다', async () => {
    const { eventId } = seed({ scale: 'SMALL' });
    const r = await forecast(eventId, identity.ops('viewer'));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({
      eventId,
      trigger: 'SALE_REVIEW',
      subscribers: 0,
      ratioMedian: 2,
      ratioUpper: 3,
      sampleCount: 0,
      defaultRatioUsed: true,
      expectedMedian: 0,
      expectedUpper: 0,
      suggestedScale: 'SMALL',
      currentScale: 'SMALL',
      raiseSuggested: false,
    });
    expect(body.computedAt).toBe(new Date(NOW_MS).toISOString());
  });

  test('C-T43 판매 승인 전 회차도 예측을 읽는다', async () => {
    const { eventId } = seed({ saleReview: 'SUBMITTED' });
    const r = await forecast(eventId, identity.ops('viewer'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ eventId, currentScale: 'SMALL', suggestedScale: 'SMALL' });
  });

  test('C-T43 신원이 없으면 401, 없는 회차는 404다', async () => {
    const { eventId } = seed();
    expect((await forecast(eventId, {})).statusCode).toBe(401);
    expect((await forecast(randomUUID(), identity.ops('viewer'))).statusCode).toBe(404);
  });
});

describe('POST /v1/ops/events/{eventId}/scale-changes', () => {
  test('C-T43  operator가 더 큰 규모로 올리면 규모와 판이 바뀐다', async () => {
    const { eventId } = seed({ scale: 'SMALL' });
    const r = await scaleChange(eventId, identity.ops('operator'), { scale: 'MEDIUM', reason: '수요 예측 상단 상승' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true });
    expect(repo.eventScales.get(eventId)).toBe('MEDIUM');
    expect(repo.eventVersions.get(eventId)).toBe(2);
  });

  test('C-T43  viewer는 올릴 수 없고, 같거나 낮은 규모는 422다', async () => {
    const { eventId } = seed({ scale: 'MEDIUM' });
    expect((await scaleChange(eventId, identity.ops('viewer'), { scale: 'LARGE', reason: '권한 없음' })).statusCode).toBe(403);
    const lower = await scaleChange(eventId, identity.ops('operator'), { scale: 'MEDIUM', reason: '같은 규모' });
    expect(lower.statusCode).toBe(422);
    expect(JSON.parse(lower.payload).type).toContain('scale-change-not-up');
  });

  test('C-T43  판매 승인 전이면 422, T-30분 안이면 409다', async () => {
    const draft = seed({ saleReview: 'SUBMITTED' });
    expect((await scaleChange(draft.eventId, identity.ops('operator'), { scale: 'MEDIUM', reason: '승인 전' })).statusCode).toBe(422);
    const soon = seed({ openAt: new Date(NOW_MS + 10 * 60_000) });
    const closed = await scaleChange(soon.eventId, identity.ops('operator'), { scale: 'MEDIUM', reason: '점검 시작' });
    expect(closed.statusCode).toBe(409);
    expect(JSON.parse(closed.payload).type).toContain('scale-change-closed');
  });

  test('C-T43 동시에 두 공연을 LARGE로 올리면 한 건만 통과한다', async () => {
    const a = seed({ scale: 'MEDIUM' });
    const b = seed({ scale: 'MEDIUM' });
    const [ra, rb] = await Promise.all([
      scaleChange(a.eventId, identity.ops('operator'), { scale: 'LARGE', reason: '동시 올리기 A' }),
      scaleChange(b.eventId, identity.ops('operator'), { scale: 'LARGE', reason: '동시 올리기 B' }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
  });

  test('C-T43 취소된 LARGE 회차는 간격 충돌로 세지 않는다', async () => {
    const open = new Date('2026-12-02T11:00:00.000Z');
    const { eventId } = seed({ openAt: open, scale: 'MEDIUM' });
    seed({ openAt: new Date(open.getTime() - 10 * 60_000), scale: 'LARGE', status: 'CANCELLED' });
    const r = await scaleChange(eventId, identity.ops('operator'), { scale: 'LARGE', reason: '취소 회차 제외' });
    expect(r.statusCode).toBe(200);
  });

  test('C-T43 LARGE 간격 충돌은 409이고 commander 예외로만 통과한다', async () => {
    const intervalOpen = new Date('2026-12-01T11:00:00.000Z');
    const { eventId } = seed({ openAt: intervalOpen, scale: 'MEDIUM' });
    seed({ openAt: new Date(intervalOpen.getTime() - 29 * 60_000), scale: 'LARGE' });
    const conflict = await scaleChange(eventId, identity.ops('operator'), { scale: 'LARGE', reason: '대형 전환' });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.payload).type).toContain('open-interval-conflict');

    const noException = await scaleChange(eventId, identity.ops('operator'), { scale: 'LARGE', reason: '간격 예외', intervalException: true });
    expect(noException.statusCode).toBe(403);
    expect(JSON.parse(noException.payload).type).toContain('commander-required');

    const allowed = await scaleChange(eventId, identity.ops('commander'), { scale: 'LARGE', reason: '간격 예외', intervalException: true });
    expect(allowed.statusCode).toBe(200);
    expect(repo.eventScales.get(eventId)).toBe('LARGE');
  });
});
