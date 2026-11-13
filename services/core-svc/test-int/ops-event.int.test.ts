// 관제 수요 예측·규모 올리기 통합 시험(BUILD_ORDER BAT-620, LCH-090, ADR-0078 결정 1).
// 실제 PostgreSQL 18 컨테이너에서 event.scale 저장, pg_advisory_xact_lock 직렬화, LARGE 30분 간격,
// 수요 예측 표본 경계(10개 미만/이상)와 10만·50만 경계를 운영과 같은 DB 역할(core_app·core_partner·core_ops)로 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSaleStore, type DemandForecastSource, type ForecastHistoryRow } from '../src/modules/catalog/index.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

class TestForecastSource implements DemandForecastSource {
  readonly data = new Map<string, { subscribers: number; history: readonly ForecastHistoryRow[] }>();

  async subscribers(eventId: string): Promise<number> {
    return this.data.get(eventId)?.subscribers ?? 0;
  }

  async history(eventId: string): Promise<readonly ForecastHistoryRow[]> {
    return this.data.get(eventId)?.history ?? [];
  }
}

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
const identity = new FakeIdentity();
const source = new TestForecastSource();
const now = Date.parse('2026-11-13T00:00:00Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const PLACE = randomUUID();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 8);
  await admin.db.insert(promoter).values({ id: A, legalName: '(주)에이' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia({ demandSource: source }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await partnerDb?.close();
  await opsDb?.close();
  await admin?.close();
  pg?.stop();
});

interface Made {
  productionId: string;
  eventId: string;
}

/** 판매 승인된 공연 하나와 회차 하나. openAt은 startsAt보다 앞이어야 한다 */
async function makeApproved(o: { openAt: Date; scale: 'LARGE' | 'MEDIUM' | 'SMALL'; startsAt?: Date; status?: 'SCHEDULED' | 'CANCELLED'; saleReview?: 'APPROVED' | 'SUBMITTED' }): Promise<Made> {
  const productionId = randomUUID();
  const eventId = randomUUID();
  const startsAt = o.startsAt ?? new Date(o.openAt.getTime() + 24 * 3_600_000);
  const saleReview = o.saleReview ?? 'APPROVED';
  await admin.db.insert(production).values({
    id: productionId,
    promoterId: A,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview,
    saleApprovedAt: saleReview === 'APPROVED' ? new Date(now) : null,
    salePolicy: [],
    salePolicyVersion: 1,
  });
  await admin.db.insert(event).values({
    id: eventId,
    productionId,
    promoterId: A,
    openAt: o.openAt,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2.5 * 3_600_000),
    perPersonLimit: 4,
    scale: o.scale,
    status: o.status ?? 'SCHEDULED',
    version: 1,
  });
  return { productionId, eventId };
}

const scaleChange = (eventId: string, role: 'operator' | 'commander', body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/events/${eventId}/scale-changes`, headers: { ...identity.ops(role), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const forecast = (eventId: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/events/${eventId}/demand-forecast`, headers: identity.ops('viewer') });
const eventRow = async (id: string) => (await admin.db.select().from(event).where(eq(event.id, id)))[0]!;

describe('규모 올리기(실제 DB, core_ops)', () => {
  test('C-T43 event.scale을 저장하고 30분 안의 다른 LARGE와 충돌하며 commander 예외로 통과한다', async () => {
    const a = await makeApproved({ openAt: new Date('2026-11-20T11:00:00.000Z'), scale: 'MEDIUM' });
    const raised = await scaleChange(a.eventId, 'operator', { scale: 'LARGE', reason: '수요 상단 상승' });
    expect(raised.statusCode).toBe(200);
    expect(await eventRow(a.eventId)).toMatchObject({ scale: 'LARGE', version: 2 });

    const b = await makeApproved({ openAt: new Date('2026-11-20T11:29:00.000Z'), scale: 'MEDIUM' });
    const conflict = await scaleChange(b.eventId, 'operator', { scale: 'LARGE', reason: '30분 안' });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.payload).type).toContain('open-interval-conflict');
    expect((await eventRow(b.eventId)).scale).toBe('MEDIUM');

    const allowed = await scaleChange(b.eventId, 'commander', { scale: 'LARGE', reason: '간격 예외', intervalException: true });
    expect(allowed.statusCode).toBe(200);
    expect((await eventRow(b.eventId)).scale).toBe('LARGE');
  });

  test('C-T43 취소된 LARGE 회차는 30분 간격 충돌로 세지 않는다', async () => {
    const openAt = new Date('2027-01-09T11:00:00.000Z');
    const target = await makeApproved({ openAt, scale: 'MEDIUM' });
    await makeApproved({ openAt: new Date(openAt.getTime() - 10 * 60_000), scale: 'LARGE', status: 'CANCELLED' });
    const r = await scaleChange(target.eventId, 'operator', { scale: 'LARGE', reason: '취소 회차 제외' });
    expect(r.statusCode).toBe(200);
    expect((await eventRow(target.eventId)).scale).toBe('LARGE');
  });

  test('C-T43 withScaleChangeLock은 두 트랜잭션을 겹치지 않게 한다', async () => {
    const store = new DrizzleSaleStore(opsDb);
    let inside = 0;
    let maxInside = 0;
    const hold = () => new Promise((resolve) => setTimeout(resolve, 150));
    await Promise.all([
      store.withScaleChangeLock(A, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await hold();
        inside--;
      }),
      store.withScaleChangeLock(A, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await hold();
        inside--;
      }),
    ]);
    expect(maxInside).toBe(1);
  });

  test('C-T43 동시에 두 공연을 LARGE로 올리면 advisory lock이 한 건만 통과시킨다', async () => {
    const openAt = new Date('2027-01-10T11:00:00.000Z');
    const a = await makeApproved({ openAt, scale: 'MEDIUM' });
    const b = await makeApproved({ openAt, scale: 'MEDIUM' });
    const [ra, rb] = await Promise.all([
      scaleChange(a.eventId, 'operator', { scale: 'LARGE', reason: '동시 A' }),
      scaleChange(b.eventId, 'operator', { scale: 'LARGE', reason: '동시 B' }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const scales = [(await eventRow(a.eventId)).scale, (await eventRow(b.eventId)).scale];
    expect(scales.filter((s) => s === 'LARGE')).toHaveLength(1);
  });
});

describe('수요 예측(실제 DB, core_partner 읽기)', () => {
  const history10 = (subscribers: number) => Array.from({ length: 10 }, (_, i) => ({ subscribers30m: subscribers, entrants: subscribers * (i + 1) }));

  test('C-T43 판매 승인 전 회차도 예측을 읽는다', async () => {
    const m = await makeApproved({ openAt: new Date('2027-02-09T11:00:00.000Z'), scale: 'SMALL', saleReview: 'SUBMITTED' });
    source.data.set(m.eventId, { subscribers: 0, history: [] });
    const r = await forecast(m.eventId);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ eventId: m.eventId, currentScale: 'SMALL', defaultRatioUsed: true });
  });

  test('C-T43 표본 10개 미만은 기본 비율(2.0·3.0)을 쓰고 10만 경계를 넘으면 MEDIUM이다', async () => {
    const m = await makeApproved({ openAt: new Date('2027-02-10T11:00:00.000Z'), scale: 'SMALL' });
    source.data.set(m.eventId, { subscribers: 34_000, history: history10(34_000).slice(0, 3) });
    const r = await forecast(m.eventId);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({
      subscribers: 34_000,
      ratioMedian: 2,
      ratioUpper: 3,
      sampleCount: 3,
      defaultRatioUsed: true,
      expectedMedian: 68_000,
      expectedUpper: 102_000,
      suggestedScale: 'MEDIUM',
      currentScale: 'SMALL',
      raiseSuggested: true,
    });
  });

  test('C-T43 표본 10개 이상은 지난 회차 비율을 쓰고 10만·50만 경계에 정확히 걸린다', async () => {
    const atMedium = await makeApproved({ openAt: new Date('2027-02-11T11:00:00.000Z'), scale: 'SMALL' });
    source.data.set(atMedium.eventId, { subscribers: 12_500, history: history10(12_500) });
    expect(JSON.parse((await forecast(atMedium.eventId)).payload)).toMatchObject({
      ratioMedian: 5.5,
      ratioUpper: 8,
      sampleCount: 10,
      defaultRatioUsed: false,
      expectedMedian: 68_750,
      expectedUpper: 100_000,
      suggestedScale: 'MEDIUM',
    });

    const atLarge = await makeApproved({ openAt: new Date('2027-02-12T11:00:00.000Z'), scale: 'MEDIUM' });
    source.data.set(atLarge.eventId, { subscribers: 62_500, history: history10(62_500) });
    expect(JSON.parse((await forecast(atLarge.eventId)).payload)).toMatchObject({
      expectedMedian: 343_750,
      expectedUpper: 500_000,
      suggestedScale: 'LARGE',
      currentScale: 'MEDIUM',
      raiseSuggested: true,
    });
  });
});
