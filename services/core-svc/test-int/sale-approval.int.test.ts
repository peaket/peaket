// 판매 승인·반려·회차 판매 설정 사본 통합 시험(판매 승인 LCH-080, S-T41).
// 실제 PostgreSQL 18 컨테이너에 마이그레이션 0010·0011·0012를 적용하고, 운영과 같은 DB 역할(core_app·core_partner·core_ops)로
// 관제 승인 HTTP 경로와 정비 일 `sale-config-publish`를 돌린다. 승인 트랜잭션이 pending_revision을 공개본으로 옮기고
// event_sale_config.payload에 salePolicy·eligGates·eligLists를 쓰는지, 반려가 상태만 바꾸는지 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  DrizzleSaleConfigMaintenanceStore,
  DrizzleSaleConfigStore,
  DrizzleSaleStore,
  NoopSaleConfigFacts,
  PublishSaleConfigs,
  saleConfigMaintenanceTasks,
} from '../src/modules/catalog/index.js';
import { event, eventSaleConfig, place, production, promoter, saleEligibilityList } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Svc;
const identity = new FakeIdentity();
const now = Date.parse('2026-11-13T00:00:00Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const PLACE = randomUUID();
const KEY = 'lumen-fanclub-2026';

const presale: SalePolicyRule = {
  version: 1,
  name: '팬클럽 선예매',
  rounds: 'ALL',
  during: { from: '2026-11-20T10:00:00.000Z', to: '2026-11-20T12:00:00.000Z' },
  rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
};
const general: SalePolicyRule = { version: 1, name: '일반', rounds: 'ALL', rule: { then: { limitPerPerson: 4 } } };

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values({ id: A, legalName: '(주)에이' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
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
  addedEventId: string;
}

/** 승인 대기 공연 하나(공개본 규칙 general, pending_revision에 presale·회차 고침·더한 회차) */
async function makeSubmitted(): Promise<Made> {
  const productionId = randomUUID();
  const eventId = randomUUID();
  const addedEventId = randomUUID();
  await admin.db.insert(production).values({
    id: productionId,
    promoterId: A,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: 'SUBMITTED',
    salePolicy: [general],
    salePolicyVersion: 2,
    pendingRevision: {
      salePolicy: [presale, general],
      eventChanges: { [eventId]: { perPersonLimit: 2, lobbyShuffle: false } },
      addedEvents: [
        {
          eventId: addedEventId,
          openAt: '2026-11-21T11:00:00.000Z',
          startsAt: '2026-12-25T10:00:00.000Z',
          endsAt: '2026-12-25T12:30:00.000Z',
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
  });
  await admin.db.insert(event).values({
    id: eventId,
    productionId,
    promoterId: A,
    openAt: new Date('2026-11-20T11:00:00.000Z'),
    startsAt: new Date('2026-12-24T10:00:00.000Z'),
    endsAt: new Date('2026-12-24T12:30:00.000Z'),
    perPersonLimit: 4,
    version: 3,
  });
  await admin.db.insert(saleEligibilityList).values({
    id: randomUUID(),
    productionId,
    promoterId: A,
    key: KEY,
    name: 'LUMEN 팬클럽 2026',
    memberCount: 0,
    fileSha256: Buffer.alloc(32, 7),
    version: 1,
    uploadedAt: new Date(now),
    uploadedBy: randomUUID(),
    destroyDueAt: new Date('2026-12-26T10:00:00.000Z'),
  });
  return { productionId, eventId, addedEventId };
}

const ops = () => identity.ops('operator');
const approval = (id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/approvals`, headers: { ...ops(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const rejection = (id: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${id}/rejections`, headers: { ...ops(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const productionRow = async (id: string) => (await admin.db.select().from(production).where(eq(production.id, id)))[0]!;
const eventRow = async (id: string) => (await admin.db.select().from(event).where(eq(event.id, id)))[0]!;
const configRow = async (id: string) => (await admin.db.select().from(eventSaleConfig).where(eq(eventSaleConfig.eventId, id)))[0]!;

describe('판매 승인 실행(실제 DB, core_ops)', () => {
  test('S-T41 승인은 pending 규칙·회차 고침·더한 회차·규모를 공개본에 옮기고 설정 사본을 쓴다', async () => {
    const m = await makeSubmitted();
    const r = await approval(m.productionId, {
      scales: [
        { eventId: m.eventId, scale: 'SMALL' },
        { eventId: m.addedEventId, scale: 'MEDIUM' },
      ],
      placeId: PLACE,
      accessibleSeatingCheck: true,
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true, events: 2 });

    const p = await productionRow(m.productionId);
    expect(p.saleReview).toBe('APPROVED');
    expect(p.saleApprovedAt?.getTime()).toBe(now);
    expect(p.salePolicy).toEqual([presale, general]);
    expect(p.pendingRevision).toBeNull();
    expect(p.accessibleSeatingCheck).toBe(true);

    const fixed = await eventRow(m.eventId);
    expect(fixed).toMatchObject({ perPersonLimit: 2, lobbyShuffle: false, scale: 'SMALL', version: 4 });
    const added = await eventRow(m.addedEventId);
    expect(added).toMatchObject({ perPersonLimit: 4, scale: 'MEDIUM', version: 1, status: 'SCHEDULED' });

    const c = await configRow(m.eventId);
    expect(c.rev).toBe(4);
    expect(c.payload).toMatchObject({
      eventId: m.eventId,
      productionId: m.productionId,
      promoterId: A,
      saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
      salePolicy: [presale, general],
      eligGates: [{ fromMs: Date.parse('2026-11-20T11:00:00.000Z'), toMs: Date.parse('2026-11-20T12:00:00.000Z'), lists: [KEY] }],
      eligLists: [KEY],
    });
    expect((await configRow(m.addedEventId)).rev).toBe(2);
  });

  test('S-T41 반려는 상태만 REJECTED로 바꾸고 pending 규칙·공개본을 그대로 둔다', async () => {
    const m = await makeSubmitted();
    const r = await rejection(m.productionId, { reason: '판매자 정보 보완' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true });

    const p = await productionRow(m.productionId);
    expect(p.saleReview).toBe('REJECTED');
    expect(p.saleApprovedAt).toBeNull();
    expect(p.salePolicy).toEqual([general]);
    expect(p.pendingRevision).toMatchObject({ salePolicy: [presale, general] });
    expect(await configRow(m.eventId)).toBeUndefined();
  });

  test('S-T41 정비 일 sale-config-publish가 승인 공연의 사본을 다시 쓴다', async () => {
    const productionId = randomUUID();
    const eventId = randomUUID();
    await admin.db.insert(production).values({
      id: productionId,
      promoterId: A,
      placeId: PLACE,
      title: '정비 대상 공연',
      genre: '콘서트',
      saleReview: 'APPROVED',
      saleApprovedAt: new Date('2026-11-12T00:00:00Z'),
      salePolicy: [presale, general],
      salePolicyVersion: 3,
    });
    await admin.db.insert(event).values({
      id: eventId,
      productionId,
      promoterId: A,
      openAt: new Date('2026-11-22T11:00:00.000Z'),
      startsAt: new Date('2026-12-26T10:00:00.000Z'),
      endsAt: new Date('2026-12-26T12:30:00.000Z'),
      version: 1,
    });
    await admin.db.insert(saleEligibilityList).values({
      id: randomUUID(),
      productionId,
      promoterId: A,
      key: KEY,
      name: 'LUMEN 팬클럽 2026',
      memberCount: 0,
      fileSha256: Buffer.alloc(32, 7),
      version: 1,
      uploadedAt: new Date(now),
      uploadedBy: randomUUID(),
      destroyDueAt: new Date('2026-12-27T10:00:00.000Z'),
    });

    const publish = new PublishSaleConfigs(new DrizzleSaleStore(opsDb), new DrizzleSaleConfigStore(opsDb), new NoopSaleConfigFacts(), clock);
    const [task] = saleConfigMaintenanceTasks(new DrizzleSaleConfigMaintenanceStore(opsDb), publish);
    await expect(task!.run()).resolves.toMatchObject({ failed: 0 });
    const c = await configRow(eventId);
    expect(c.rev).toBe(3);
    expect(c.payload).toMatchObject({ salePolicy: [presale, general], eligLists: [KEY] });
  });
});
