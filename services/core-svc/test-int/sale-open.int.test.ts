// 승인 뒤 판매 열기·대기열 사본(S-T41 ⑥⑨, BAT-616 LCH-080, ADR-0327).
// 실제 PostgreSQL·Valkey에 승인 HTTP를 걸고, purchase-svc 판매 열기는 대역으로 두어 차례·성공/실패에 따른 q:cfg·q:epoch 쓰기를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createHotRedis, createService, type Database, ensureOutboxPartitions, type HotRedis, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  CompositeSaleConfigStore,
  DrizzleSaleConfigMaintenanceStore,
  DrizzleSaleConfigStore,
  DrizzleSaleStore,
  NoopSaleConfigFacts,
  PublishSaleConfigs,
  QueueSaleConfigStore,
  type SaleOpen,
  type SaleOpenInput,
  type SaleOpenResult,
  saleConfigMaintenanceTasks,
} from '../src/modules/catalog/index.js';
import { event, eventSaleConfig, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const clock: Clock = { now: () => NOW, monotonicMs: () => performance.now() };
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PLACE = randomUUID();
const general = { version: 1, name: '일반', rounds: 'ALL' as const, rule: { then: { limitPerPerson: 4 } } };
const KEEP_AFTER_SALE_END_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// 사본 키의 만료(PEXPIREAT)는 실제 시계로 잡힌다. 고정 날짜를 쓰면 그날이 지나 키가 사라지므로 시작 시각을 실행 시각에서 잡는다
const BASE_MS = Date.now() + 7 * DAY_MS;
const startsAtMs = (days: number): number => BASE_MS + days * DAY_MS;

class StubSaleOpen implements SaleOpen {
  readonly calls: SaleOpenInput[] = [];
  handler: (i: SaleOpenInput) => Promise<SaleOpenResult> = async () => 'opened';
  async open(i: SaleOpenInput): Promise<SaleOpenResult> {
    this.calls.push(i);
    return this.handler(i);
  }
}

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let redis: HotRedis;
let svc: Awaited<ReturnType<typeof createService>>;
let composite: CompositeSaleConfigStore;
let saleOpen: StubSaleOpen;

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'rejected') throw p.reason as Error;
  if (v.status === 'rejected') throw v.reason as Error;
  pg = p.value;
  valkey = v.value;
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-sale-open-it', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  redis = await createHotRedis({ url: valkey.url });
  saleOpen = new StubSaleOpen();
  composite = new CompositeSaleConfigStore(new DrizzleSaleConfigStore(opsDb), new QueueSaleConfigStore(redis));
  await admin.db.insert(promoter).values({ id: TENANT, legalName: '(주)피켓공연' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc-sale-open',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia(), saleConfigStore: composite, saleOpen }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await redis?.close().catch(() => undefined);
  await Promise.allSettled([appDb?.close(), partnerDb?.close(), opsDb?.close(), admin?.close()]);
  valkey?.stop();
  pg?.stop();
});

const ops = () => identity.ops('operator');
const approval = (id: string, scales: { eventId: string; scale: string }[]) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/sale-reviews/${id}/approvals`,
    headers: { ...ops(), 'content-type': 'application/json' },
    payload: JSON.stringify({ scales, placeId: PLACE }),
  });

/** 판매 승인 대기 공연 하나. startsAtMs를 따로 주어 시작 시각 차례를 시험이 정한다(오픈은 시작 3일 전) */
async function makeSubmitted(startsAt: number[]): Promise<{ productionId: string; eventIds: string[] }> {
  const productionId = randomUUID();
  await admin.db.insert(production).values({ id: productionId, promoterId: TENANT, placeId: PLACE, title: `겨울 콘서트-${productionId.slice(0, 8)}`, genre: '콘서트', saleReview: 'SUBMITTED', salePolicy: [general], salePolicyVersion: 1 });
  const eventIds: string[] = [];
  for (const startsAtMsI of startsAt) {
    const eventId = randomUUID();
    const startsAtDate = new Date(startsAtMsI);
    await admin.db.insert(event).values({
      id: eventId,
      productionId,
      promoterId: TENANT,
      openAt: new Date(startsAtDate.getTime() - 3 * 86_400_000),
      startsAt: startsAtDate,
      endsAt: new Date(startsAtDate.getTime() + 9_000_000),
      perPersonLimit: 4,
      version: 3,
    });
    eventIds.push(eventId);
  }
  return { productionId, eventIds };
}

const hashOf = (v: unknown): Record<string, string> => {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)]));
  return {};
};
const cfgOf = async (eventId: string) => hashOf(await redis.command(['HGETALL', `q:{event:${eventId}}:cfg`], { key: `q:{event:${eventId}}:cfg` }));
const epochOf = async (eventId: string) => hashOf(await redis.command(['HGETALL', `q:{event:${eventId}}:epoch`], { key: `q:{event:${eventId}}:epoch` }));
const configRow = async (eventId: string) => (await admin.db.select().from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)))[0];

describe('승인 뒤 판매 열기·대기열 사본(실제 PostgreSQL·Valkey)', () => {
  test('S-T41 ⑥_ 승인은 비취소 회차를 시작 시각 오름차순으로 한 번씩 sale-open하고, opened·exists만 q:cfg·q:epoch를 쓴다(Approval 재호출은 부수 효과 0)', async () => {
    const m = await makeSubmitted([startsAtMs(1), startsAtMs(0)]);
    await redis.command(['DEL', `q:{event:${m.eventIds[0]}}:cfg`, `q:{event:${m.eventIds[1]}}:cfg`, `q:{event:${m.eventIds[0]}}:epoch`, `q:{event:${m.eventIds[1]}}:epoch`], { key: `q:{event:${m.eventIds[0]}}:cfg` });
    saleOpen.calls.length = 0;
    // 두 번째 회차는 이미 열린 것으로 답해 exists도 사본을 쓰는지 본다
    saleOpen.handler = async (i) => (i.eventId === m.eventIds[0] ? 'opened' : 'exists');
    const r = await approval(m.productionId, [
      { eventId: m.eventIds[0]!, scale: 'SMALL' },
      { eventId: m.eventIds[1]!, scale: 'MEDIUM' },
    ]);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true, events: 2 });

    // 시작 시각 오름차순(둘째 회차가 먼저)으로 회차마다 한 번
    expect(saleOpen.calls.map((c) => c.eventId)).toEqual([m.eventIds[1], m.eventIds[0]]);
    for (const eventId of m.eventIds) {
      expect(saleOpen.calls.filter((c) => c.eventId === eventId)).toHaveLength(1);
      const cfg = await cfgOf(eventId);
      expect(cfg.rev).toBe('4');
      expect(Number(cfg.startsAtMs)).toBeGreaterThan(0);
      expect(cfg.config).toBeTruthy();
      const row = await configRow(eventId);
      expect(row?.rev).toBe(4);
      const epoch = await epochOf(eventId);
      // 대기열 세대 키의 칸은 node뿐이다(epoch 칸은 좌석 저장소 s:{event:E}:epoch의 것, ADR-0181·data.md)
      expect(epoch).toEqual({ node: 'standalone' });
    }

    // 같은 승인을 다시 보내면 409이고 sale-open 호출·사본·행이 늘지 않는다
    const before = saleOpen.calls.length;
    const rowBefore = await configRow(m.eventIds[0]!);
    const again = await approval(m.productionId, [
      { eventId: m.eventIds[0]!, scale: 'SMALL' },
      { eventId: m.eventIds[1]!, scale: 'MEDIUM' },
    ]);
    expect(again.statusCode).toBe(409);
    expect(saleOpen.calls.length).toBe(before);
    expect(await configRow(m.eventIds[0]!)).toEqual(rowBefore);

    // 정비 일이 같은 승인을 다시 써도 rev·값·행이 늘지 않는다(같은 rev는 덮지 않는다)
    const cfgBefore = await cfgOf(m.eventIds[0]!);
    const epochBefore = await epochOf(m.eventIds[0]!);
    saleOpen.handler = async () => 'exists';
    const publish = new PublishSaleConfigs(new DrizzleSaleStore(opsDb), composite, new NoopSaleConfigFacts(), clock, saleOpen);
    const task = saleConfigMaintenanceTasks(new DrizzleSaleConfigMaintenanceStore(opsDb), publish).find((t) => t.name === 'sale-config-publish')!;
    await task.run(undefined);
    expect(await cfgOf(m.eventIds[0]!)).toEqual(cfgBefore);
    expect(await epochOf(m.eventIds[0]!)).toEqual(epochBefore);
    const rowAfter = await configRow(m.eventIds[0]!);
    expect(rowAfter?.rev).toBe(rowBefore?.rev);
    expect(rowAfter?.payload).toEqual(rowBefore?.payload);
  });

  test('S-T41 ⑥_ 취소 회차는 sale-open을 부르지 않고 UPCOMING·사본에도 넣지 않는다(B11)', async () => {
    const m = await makeSubmitted([startsAtMs(8), startsAtMs(9)]);
    await admin.pool.query(`update event set status = 'CANCELLED' where id = $1`, [m.eventIds[1]]);
    saleOpen.calls.length = 0;
    saleOpen.handler = async () => 'opened';
    expect((await approval(m.productionId, [{ eventId: m.eventIds[0]!, scale: 'SMALL' }, { eventId: m.eventIds[1]!, scale: 'SMALL' }])).statusCode).toBe(200);
    expect(saleOpen.calls.map((c) => c.eventId)).toEqual([m.eventIds[0]]);
    expect(await cfgOf(m.eventIds[1]!)).toEqual({});
    expect(await epochOf(m.eventIds[1]!)).toEqual({});
    expect(await configRow(m.eventIds[1]!)).toBeUndefined();
    expect((await cfgOf(m.eventIds[0]!)).rev).toBe('4');
  });

  test('S-T41 ⑨_ 열기가 실패(예외·no-layout)하면 승인은 200이고 q:cfg가 없으며, 정비 일이 다시 돌면 열고 사본을 쓴다', async () => {
    const failed = await makeSubmitted([startsAtMs(2), startsAtMs(3)]);
    const noLayout = await makeSubmitted([startsAtMs(4)]);
    for (const m of [failed, noLayout]) {
      for (const id of m.eventIds) await redis.command(['DEL', `q:{event:${id}}:cfg`, `q:{event:${id}}:epoch`], { key: `q:{event:${id}}:cfg` });
    }
    saleOpen.calls.length = 0;
    saleOpen.handler = async (i) => {
      if (failed.eventIds.includes(i.eventId)) throw new Error('purchase-svc 판매 열기 503');
      if (noLayout.eventIds.includes(i.eventId)) return 'no-layout';
      return 'opened';
    };
    expect((await approval(failed.productionId, failed.eventIds.map((eventId) => ({ eventId, scale: 'SMALL' })))).statusCode).toBe(200);
    expect((await approval(noLayout.productionId, noLayout.eventIds.map((eventId) => ({ eventId, scale: 'SMALL' })))).statusCode).toBe(200);
    for (const m of [failed, noLayout]) {
      for (const id of m.eventIds) {
        expect(await cfgOf(id), id).toEqual({});
        expect(await epochOf(id), id).toEqual({});
        expect(await configRow(id), id).toBeUndefined();
      }
    }
    expect(saleOpen.calls.filter((c) => c.eventId === failed.eventIds[0]).length).toBeGreaterThanOrEqual(1);

    // purchase가 회복되면 정비 일이 열고 사본을 쓴다(열기 성공 전에는 쓰지 않는다)
    saleOpen.handler = async () => 'opened';
    const publish = new PublishSaleConfigs(new DrizzleSaleStore(opsDb), composite, new NoopSaleConfigFacts(), clock, saleOpen);
    const task = saleConfigMaintenanceTasks(new DrizzleSaleConfigMaintenanceStore(opsDb), publish).find((t) => t.name === 'sale-config-publish')!;
    await task.run(undefined);
    for (const m of [failed, noLayout]) {
      for (const id of m.eventIds) {
        const cfg = await cfgOf(id);
        expect(cfg.rev, id).toBe('4');
        expect(await configRow(id), id).toBeDefined();
        expect((await epochOf(id)).node, id).toBe('standalone');
      }
    }
    // 실패했던 회차의 판매 종료가 지나지 않았으므로 TTL은 시작 24시간 전 + 1일이다
    const cfg = await cfgOf(failed.eventIds[0]!);
    expect(Number(cfg.startsAtMs)).toBe(startsAtMs(2));
    expect(Number(cfg.config ? JSON.parse(cfg.config).saleEndsAtMs : 0)).toBe(startsAtMs(2) - DAY_MS);
    const ttl = Number(await redis.command(['PEXPIRETIME', `q:{event:${failed.eventIds[0]}}:cfg`], { key: `q:{event:${failed.eventIds[0]}}:cfg` }));
    expect(Math.abs(ttl - (startsAtMs(2) - DAY_MS + KEEP_AFTER_SALE_END_MS))).toBeLessThan(5_000);
  });
});
