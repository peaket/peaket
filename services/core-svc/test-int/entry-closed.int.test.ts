// F-05-6 입장 기록 마감의 core 알림 내부 경로 통합 시험(BUILD_ORDER GAT-180, O-T29 ③).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 'core 알림'(비었을 때만 쓴다, 같은 트랜잭션에서 판매 설정 사본의 entryClosedAtMs,
// 사본 rev는 올리지 않는다, 이미 값이 있으면 지금 값 200, closedAt < ends_at + 2시간이면 422, 없는 회차 404), docs/api/guidelines.md §8.1(내부 토큰),
// docs/data.md event.entry_closed_at·event_sale_config, 계획 docs/review/plans/F-05-6.md §4(PUT internal/v1/events/:eventId/entry-closed → 200 { entryClosedAt }).
// 실제 PostgreSQL 18에 마이그레이션을 적용하고 운영과 같은 core_app·core_partner·core_ops 역할로 서비스를 띄운다(internal-sale-config.int.test.ts와 같은 조립).
// 판정은 바깥에서 본다: 응답 + event 행(entry_closed_at) + event_sale_config 행(rev 칸·payload) + GET sale-config 응답.
// ends_at은 분 경계가 아닌 값(…:17:43.219Z)으로 골라, 역할 유효 끝(ends_at + 7,200,000ms)을 분·초 단위로 반올림하는 결함이 드러나게 한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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
const now = Date.parse('2026-12-25T03:00:00.000Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const TOKEN = 'f056-core-internal-token';
const PROMOTER = randomUUID();
const PLACE = randomUUID();
const PRODUCTION = randomUUID();
/** 정본 '역할 유효 끝은 ends_at + 2시간'(offline-gate §7.3)을 밀리초로 적었다. 코드 상수를 가져오지 않는다 */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
const STARTS_AT = Date.parse('2026-12-24T10:00:00.000Z');
/** 분 경계가 아닌 공연 종료 예정 시각 */
const ENDS_AT = Date.parse('2026-12-24T12:17:43.219Z');
const ROLE_END = ENDS_AT + ROLE_END_AFTER_ENDS_MS;

/** 회차 하나를 만들고 판매 설정 사본(rev 7·entryClosedAtMs null)을 core_ops로 쓴다 */
async function seedEvent(o: { withConfig?: boolean } = {}): Promise<{ eventId: string; config: EventSaleConfig }> {
  const eventId = randomUUID();
  await admin.db.insert(event).values({
    id: eventId,
    productionId: PRODUCTION,
    promoterId: PROMOTER,
    openAt: new Date(Date.parse('2026-11-20T11:00:00.000Z')),
    startsAt: new Date(STARTS_AT),
    endsAt: new Date(ENDS_AT),
    perPersonLimit: 4,
    version: 3,
  });
  const config: EventSaleConfig = {
    eventId,
    productionId: PRODUCTION,
    promoterId: PROMOTER,
    rev: 7,
    opensAtMs: Date.parse('2026-11-20T11:00:00.000Z'),
    startsAtMs: STARTS_AT,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: 4,
    saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
    reentryAllowed: false,
    entryOpensAtMs: Date.parse('2026-12-24T09:00:00.000Z'),
    endsAtMs: ENDS_AT,
    entryClosedAtMs: null,
    layoutVersion: 3,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  };
  if (o.withConfig !== false) await new DrizzleSaleConfigStore(opsDb).put([config], []);
  return { eventId, config };
}

const put = (eventId: string, body: unknown, token: string | null = TOKEN) =>
  svc.http.inject({
    method: 'PUT',
    url: `/internal/v1/events/${eventId}/entry-closed`,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) },
    payload: JSON.stringify(body),
  });

const getConfig = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config`, headers: { 'x-peaket-internal-token': TOKEN } });

/** event.entry_closed_at(밀리초, 없으면 null) */
async function eventClosedAt(eventId: string): Promise<number | null> {
  const r = await admin.pool.query<{ at: Date | null }>('select entry_closed_at as at from event where id = $1', [eventId]);
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.at ? r.rows[0]!.at.getTime() : null;
}

/** event_sale_config 행의 rev 칸과 payload */
async function configRow(eventId: string): Promise<{ rev: number; payload: Record<string, unknown> }> {
  const r = await admin.pool.query<{ rev: number; payload: Record<string, unknown> }>('select rev, payload from event_sale_config where event_id = $1', [eventId]);
  expect(r.rows).toHaveLength(1);
  return { rev: Number(r.rows[0]!.rev), payload: r.rows[0]!.payload };
}

/** 오프셋이 붙은 ISO(+09:00). 정본 본문 closedAt은 ISO(오프셋)이다 */
const kst = (ms: number): string => {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.toISOString().slice(0, 23)}+09:00`;
};

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-entry-closed', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 6);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 6);
  await admin.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)마감' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  await admin.db.insert(production).values({ id: PRODUCTION, promoterId: PROMOTER, placeId: PLACE, title: '겨울 콘서트', genre: '콘서트' });
  // 내부 토큰을 요구하는 설정으로 띄운다(guidelines §8.1). 환경 변수는 afterAll에서 되돌린다
  vi.stubEnv('PEAKET_INTERNAL_TOKEN', TOKEN);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
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
  vi.unstubAllEnvs();
  pg?.stop();
});

describe('PUT /internal/v1/events/{eventId}/entry-closed (실제 PostgreSQL, O-T29 ③)', () => {
  test('O-T29 ③-1 비어 있으면 그 값을 event.entry_closed_at과 판매 설정 사본 entryClosedAtMs에 쓰고 200 { entryClosedAt }이며, 사본 rev와 다른 칸은 그대로다', async () => {
    const { eventId, config } = await seedEvent();
    const before = await configRow(eventId);
    expect(before.rev).toBe(7);
    const closedAt = ROLE_END + 61_017;
    const r = await put(eventId, { closedAt: kst(closedAt) });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload) as { entryClosedAt: string };
    expect(Object.keys(body)).toEqual(['entryClosedAt']);
    expect(Date.parse(body.entryClosedAt)).toBe(closedAt);
    expect(await eventClosedAt(eventId)).toBe(closedAt);
    const after = await configRow(eventId);
    // rev는 올리지 않는다(판매 설정 값이 아니다). 칸 rev와 payload.rev 둘 다
    expect(after.rev).toBe(7);
    expect(after.payload).toEqual({ ...before.payload, entryClosedAtMs: closedAt });
    // 내부 읽기 경로(ticket·purchase가 읽는 곳)도 같은 값을 준다
    const read = await getConfig(eventId);
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.payload)).toEqual({ ...config, entryClosedAtMs: closedAt });
  });

  test('O-T29 ③-2 이미 값이 있으면 다른 값을 보내도 바꾸지 않고 지금 값을 200으로 돌려준다(사본도 그대로)', async () => {
    const { eventId } = await seedEvent();
    const first = ROLE_END + 5_000;
    expect((await put(eventId, { closedAt: new Date(first).toISOString() })).statusCode).toBe(200);
    const snapshot = await configRow(eventId);
    const r = await put(eventId, { closedAt: new Date(first + 86_400_000).toISOString() });
    expect(r.statusCode).toBe(200);
    expect(Date.parse((JSON.parse(r.payload) as { entryClosedAt: string }).entryClosedAt)).toBe(first);
    expect(await eventClosedAt(eventId)).toBe(first);
    expect(await configRow(eventId)).toEqual(snapshot);
    // 같은 값을 다시 보내도 결과가 같다
    const again = await put(eventId, { closedAt: new Date(first).toISOString() });
    expect(again.statusCode).toBe(200);
    expect(Date.parse((JSON.parse(again.payload) as { entryClosedAt: string }).entryClosedAt)).toBe(first);
  });

  test('O-T29 ③-3 서로 다른 두 값을 동시에 보내면 저장은 하나이고 두 답이 그 저장된 값과 같다', async () => {
    for (let round = 0; round < 5; round++) {
      const { eventId } = await seedEvent();
      const a = ROLE_END + 1_000 + round;
      const b = ROLE_END + 9_000_000 + round;
      const [ra, rb] = await Promise.all([put(eventId, { closedAt: new Date(a).toISOString() }), put(eventId, { closedAt: new Date(b).toISOString() })]);
      expect([ra.statusCode, rb.statusCode], `round ${round}`).toEqual([200, 200]);
      const stored = await eventClosedAt(eventId);
      expect([a, b], `round ${round}`).toContain(stored);
      expect(Date.parse((JSON.parse(ra.payload) as { entryClosedAt: string }).entryClosedAt), `round ${round}`).toBe(stored);
      expect(Date.parse((JSON.parse(rb.payload) as { entryClosedAt: string }).entryClosedAt), `round ${round}`).toBe(stored);
      // 사본도 같은 값 하나(이긴 쪽과 진 쪽이 사본에 따로 쓰지 않는다)
      expect((await configRow(eventId)).payload.entryClosedAtMs, `round ${round}`).toBe(stored);
    }
  });

  test('O-T29 ③-4 closedAt이 ends_at + 7,200,000ms보다 1ms 이르면 422이고 아무것도 쓰지 않으며, 그 경계와 같으면 200이다', async () => {
    const { eventId } = await seedEvent();
    const before = await configRow(eventId);
    const early = await put(eventId, { closedAt: new Date(ROLE_END - 1).toISOString() });
    expect(early.statusCode).toBe(422);
    expect(JSON.parse(early.payload)).toMatchObject({ status: 422 });
    expect(await eventClosedAt(eventId)).toBeNull();
    expect(await configRow(eventId)).toEqual(before);
    const edge = await put(eventId, { closedAt: new Date(ROLE_END).toISOString() });
    expect(edge.statusCode).toBe(200);
    expect(Date.parse((JSON.parse(edge.payload) as { entryClosedAt: string }).entryClosedAt)).toBe(ROLE_END);
    expect(await eventClosedAt(eventId)).toBe(ROLE_END);
    expect((await configRow(eventId)).payload.entryClosedAtMs).toBe(ROLE_END);
  });

  test('O-T29 ③-5 없는 회차는 404이고, 본문 형식이 틀리면(빠짐·오프셋 없는 시각·글자·숫자) 정확히 400이며 쓰지 않는다. 이어 보낸 정상 본문은 200이다(시험 리뷰 RV-04)', async () => {
    const missing = await put(randomUUID(), { closedAt: new Date(ROLE_END).toISOString() });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.payload)).toMatchObject({ status: 404 });
    const { eventId } = await seedEvent();
    for (const body of [{}, { closedAt: '2026-12-24T14:17:43.219' }, { closedAt: 'tomorrow' }, { closedAt: ROLE_END }]) {
      const r = await put(eventId, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.payload), JSON.stringify(body)).toMatchObject({ status: 400 });
    }
    expect(await eventClosedAt(eventId)).toBeNull();
    expect((await configRow(eventId)).payload.entryClosedAtMs).toBeNull();
    const ok = await put(eventId, { closedAt: new Date(ROLE_END + 1).toISOString() });
    expect(ok.statusCode).toBe(200);
    expect(await eventClosedAt(eventId)).toBe(ROLE_END + 1);
  });

  test('O-T29 ③-7 회차는 있는데 판매 설정 사본 행이 없으면 event.entry_closed_at만 쓰고 200이며 사본은 만들지 않는다(정본 §7.3 core 알림, 시험 리뷰 RV-14)', async () => {
    const { eventId } = await seedEvent({ withConfig: false });
    const closedAt = ROLE_END + 9_001;
    const r = await put(eventId, { closedAt: kst(closedAt) });
    expect(r.statusCode).toBe(200);
    expect(Date.parse((JSON.parse(r.payload) as { entryClosedAt: string }).entryClosedAt)).toBe(closedAt);
    expect(await eventClosedAt(eventId)).toBe(closedAt);
    const rows = await admin.pool.query('select 1 from event_sale_config where event_id = $1', [eventId]);
    expect(rows.rows).toHaveLength(0);
  });

  test('O-T29 ③-6 내부 토큰이 없거나 틀리면 401이고 쓰지 않는다', async () => {
    const { eventId } = await seedEvent();
    expect((await put(eventId, { closedAt: new Date(ROLE_END).toISOString() }, null)).statusCode).toBe(401);
    expect((await put(eventId, { closedAt: new Date(ROLE_END).toISOString() }, 'wrong-token')).statusCode).toBe(401);
    expect(await eventClosedAt(eventId)).toBeNull();
    expect((await configRow(eventId)).payload.entryClosedAtMs).toBeNull();
  });
});
