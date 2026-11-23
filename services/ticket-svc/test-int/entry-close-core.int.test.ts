// F-05-6 서비스 사이 한 줄: ticket-svc 입장 기록 마감 → core-svc 내부 경로 entry-closed → ticket-svc 판매 설정 읽기(BUILD_ORDER GAT-180, O-T29 ③).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 'core 알림'(비었을 때만, 판매 설정 사본 entryClosedAtMs, 내부 토큰),
// docs/api/guidelines.md §8.1, 계획 docs/review/plans/F-05-6.md §8 '서비스 사이 한 줄'.
// ticket-svc는 시작 파일 start()로, core-svc는 그 서비스 모듈(AppModule)을 실제 포트로 띄운다(의존 선언 밖 상대 경로, CLAUDE.md:
// core-svc를 고치면 ticket-svc도 타입 검사한다). 두 서비스는 서로 다른 PostgreSQL 18 컨테이너를 쓰고, core는 운영과 같은 역할 로그인으로 접속한다.
// 시계는 실제 시계다. 판정은 바깥에서 본다: ticket entry_close 행, core event.entry_closed_at, core 내부 판매 설정 읽기, ticket의 HttpCoreEventPolicy.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { createDatabase, createExternalHttpClient, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateCore } from '../../core-svc/scripts/migrate.mjs';
import { AppModule as CoreAppModule } from '../../core-svc/src/app.module.js';
import { event, place, production, promoter } from '../../core-svc/src/modules/catalog/adapters/db/schema.js';
import type { EventSaleConfig } from '../../core-svc/src/modules/catalog/domain/event-sale-config.js';
import { DrizzleSaleConfigStore } from '../../core-svc/src/modules/catalog/index.js';
import { FakeIdentity, testMedia } from '../../core-svc/test/support.js';
import { startPostgres as startCorePostgres, type PostgresContainer as CorePostgres } from '../../core-svc/test-int/postgres.js';
import { loginFor } from '../../core-svc/test-int/roles.js';
import { migrateTicket } from '../scripts/migrate.mjs';
import { HttpCoreEventPolicy } from '../src/modules/scanner/adapters/http-core-event-policy.js';
import { start, type StartedService, type StartOptions } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
const INTERNAL = 'f056-cross-internal-token';
const PROMOTER = randomUUID();
const PLACE = randomUUID();
const PRODUCTION = randomUUID();
const POLL = { timeout: 20_000, interval: 100 };
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

let ticketPg: PostgresContainer;
let corePg: CorePostgres;
let ticketDb: Database;
let coreAdmin: Database;
let coreApp: Database;
let corePartner: Database;
let coreOps: Database;
let core: Awaited<ReturnType<typeof createService>>;
let coreUrl = '';
let ticket: StartedService;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** core에 회차·판매 설정 사본(entryClosedAtMs null), ticket에 그 회차 티켓(발권 때 받은 회차 시작)을 심는다 */
async function seedEvent(endsAtMs: number): Promise<string> {
  const eventId = randomUUID();
  const startsAtMs = endsAtMs - 3 * 3_600_000;
  await coreAdmin.db.insert(event).values({
    id: eventId,
    productionId: PRODUCTION,
    promoterId: PROMOTER,
    openAt: new Date(startsAtMs - 30 * 86_400_000),
    startsAt: new Date(startsAtMs),
    endsAt: new Date(endsAtMs),
    perPersonLimit: 4,
    version: 1,
  });
  const config: EventSaleConfig = {
    eventId,
    productionId: PRODUCTION,
    promoterId: PROMOTER,
    rev: 2,
    opensAtMs: startsAtMs - 30 * 86_400_000,
    startsAtMs,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: 4,
    saleEndsAtMs: startsAtMs - 86_400_000,
    reentryAllowed: false,
    entryOpensAtMs: startsAtMs - 3_600_000,
    endsAtMs,
    entryClosedAtMs: null,
    layoutVersion: 1,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  };
  await new DrizzleSaleConfigStore(coreOps).put([config], []);
  await ticketDb.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, event_starts_at, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', $6, now())`,
    [randomUUID(), randomUUID(), randomUUID(), eventId, randomUUID(), new Date(startsAtMs)],
  );
  return eventId;
}

beforeAll(async () => {
  [ticketPg, corePg] = await Promise.all([startPostgres(), startCorePostgres()]);
  await Promise.all([migrateTicket(ticketPg.url), migrateCore(corePg.url)]);
  ticketDb = createDatabase({ url: ticketPg.url, applicationName: 'ticket-svc-entry-close-core-int', max: 4 });
  coreAdmin = createDatabase({ url: corePg.url, applicationName: 'core-svc-entry-close-core-int', max: 4 });
  await ensureOutboxPartitions(coreAdmin, systemClock);
  coreApp = await loginFor(coreAdmin, corePg, 'core_app_login', 'core_app', 4);
  corePartner = await loginFor(coreAdmin, corePg, 'core_partner_login', 'core_partner', 2);
  coreOps = await loginFor(coreAdmin, corePg, 'core_ops_login', 'core_ops', 4);
  await coreAdmin.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)서비스사이' });
  await coreAdmin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 2', region: '서울', createdBy: randomUUID() });
  await coreAdmin.db.insert(production).values({ id: PRODUCTION, promoterId: PROMOTER, placeId: PLACE, title: '마감 잇기 공연', genre: '콘서트' });
  // core-svc 내부 입구는 모듈을 만들 때 PEAKET_INTERNAL_TOKEN을 읽는다(afterAll에서 되돌린다)
  vi.stubEnv('PEAKET_INTERNAL_TOKEN', INTERNAL);
  const corePort = await freePort();
  core = await createService({
    name: 'core-svc',
    module: CoreAppModule.register({ database: coreApp, notifyDatabase: coreApp, partnerDatabase: corePartner, opsDatabase: coreOps, media: testMedia() }),
    env: { PEAKET_ENV: 'ci', PORT: String(corePort), PEAKET_MANAGEMENT_PORT: String(await freePort()), PEAKET_LOG_LEVEL: 'fatal' },
    clock: systemClock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  await core.listen();
  coreUrl = `http://127.0.0.1:${corePort}`;
  const options: StartOptions & { entryCloseEveryMs: number } = {
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: ticketPg.url,
      PEAKET_CORE_HTTP_URL: coreUrl,
      PEAKET_INTERNAL_TOKEN: INTERNAL,
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: quiet(),
    entryCloseEveryMs: 200,
  };
  ticket = await start(options);
}, 240_000);

afterAll(async () => {
  await ticket?.close().catch(() => {});
  await core?.close().catch(() => {});
  for (const d of [coreOps, corePartner, coreApp, coreAdmin, ticketDb]) await d?.close().catch(() => {});
  vi.unstubAllEnvs();
  corePg?.stop();
  ticketPg?.stop();
});

describe('ticket-svc 마감 → core-svc entry-closed → 판매 설정 읽기(O-T29 ③)', () => {
  test('O-T29 ③ 역할 유효 끝이 지난 회차를 ticket-svc가 마감하면 core event.entry_closed_at과 판매 설정 entryClosedAtMs가 그 마감 시각이 되고, ticket의 판매 설정 읽기가 그 값을 본다', async () => {
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000;
    const eventId = await seedEvent(ends);
    const synced = async (): Promise<boolean> =>
      ((await ticketDb.pool.query<{ core_synced_at: Date | null }>('select core_synced_at from entry_close where event_id = $1', [eventId])).rows[0]?.core_synced_at ?? null) !== null;
    await expect.poll(synced, POLL).toBe(true);
    const closedAt = (await ticketDb.pool.query<{ closed_at: Date }>('select closed_at from entry_close where event_id = $1', [eventId])).rows[0]!.closed_at.getTime();
    const coreRow = (await coreAdmin.pool.query<{ at: Date | null }>('select entry_closed_at as at from event where id = $1', [eventId])).rows[0]!;
    expect(coreRow.at?.getTime()).toBe(closedAt);
    const read = await fetch(`${coreUrl}/internal/v1/events/${eventId}/sale-config`, { headers: { 'x-peaket-internal-token': INTERNAL } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { entryClosedAtMs: number | null }).entryClosedAtMs).toBe(closedAt);
    const policy = new HttpCoreEventPolicy({ client: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 300, clock: systemClock }), clock: systemClock, internalToken: INTERNAL });
    expect((await policy.get(eventId))?.entryClosesAtMs).toBe(closedAt);
  });
});
