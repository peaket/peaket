// purchase-svc가 읽는 회차 판매 설정 사본의 내부 HTTP 경로 통합 시험(BAT-051, HOT-252, R-535).
// 실제 PostgreSQL 18에 마이그레이션을 적용하고 운영과 같은 core_app·core_partner·core_ops 역할로 서비스를 띄운 뒤,
// event_sale_config 행을 core_ops로 쓰고 internal 경로가 payload 그대로·404·no-store로 답하는지 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleSaleConfigStore } from '../src/modules/catalog/index.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
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
const PROMOTER = randomUUID();
const PLACE = randomUUID();
const PRODUCTION = randomUUID();
const EVENT = randomUUID();
const MISSING = randomUUID();
const KEY = 'lumen-fanclub-2026';

const config: EventSaleConfig = {
  eventId: EVENT,
  productionId: PRODUCTION,
  promoterId: PROMOTER,
  rev: 7,
  opensAtMs: Date.parse('2026-11-20T11:00:00.000Z'),
  startsAtMs: Date.parse('2026-12-24T10:00:00.000Z'),
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
  layoutVersion: 3,
  salePolicy: [{ version: 1, name: '팬클럽 선예매', rounds: 'ALL', rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } }],
  eligGates: [],
  eligLists: [KEY],
};

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-internal-config', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)에이' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  await admin.db.insert(production).values({ id: PRODUCTION, promoterId: PROMOTER, placeId: PLACE, title: '겨울 콘서트', genre: '콘서트' });
  await admin.db.insert(event).values({
    id: EVENT,
    productionId: PRODUCTION,
    promoterId: PROMOTER,
    openAt: new Date(config.opensAtMs),
    startsAt: new Date(config.startsAtMs),
    endsAt: new Date(config.startsAtMs + 2 * 3_600_000),
    perPersonLimit: 4,
    version: 3,
  });
  await new DrizzleSaleConfigStore(opsDb).put([config], []);
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

const get = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config` });

describe('GET /internal/v1/events/{eventId}/sale-config (실제 PostgreSQL)', () => {
  test('BAT051_ core_ops가 쓴 event_sale_config.payload를 salePolicy·eligLists까지 그대로 답하고 no-store다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = await get(EVENT);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toEqual(config);
  });

  test('BAT051_ 사본이 없는 회차는 404 not-found이고 no-store다(빈 설정을 만들지 않는다)', async () => {
    const r = await get(MISSING);
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ status: 404, type: expect.stringContaining('not-found') });
  });

  test('BAT051_ core_app 역할로도 event_sale_config을 읽을 수 있다(내부 경로가 core DB 직접 접속을 대신한다)', async () => {
    const rows = await appDb.db.execute(`select event_id from event_sale_config where event_id = '${EVENT}'::uuid`);
    expect(rows.rows).toHaveLength(1);
  });
});
