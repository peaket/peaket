// 새 결제 일시 정지 읽기(BUILD_ORDER PRF-201, P-T43)를 실제 PostgreSQL 18과 실제 gRPC 서버로 돈다.
// 정본: docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현'·§9, ADR-0085·0105, docs/data.md `payment_entry_pause`, docs/api/proto/peaket/payment/v1/payment.proto.
//
// 약속:
// - Kafka 모듈을 불러오지 않는다(릴레이·kafka.ts 없이 저장소와 쓰임새만 묶는다).
// - 정지 행과 시험 행은 SQL로 직접 넣는다(쓰는 코드는 판정자 PRF-202다).
// - 시계는 멈춘 가짜 시계다. 캐시 1초 [가정]는 clock.advance로 넘긴다. 부르는 쪽은 계약 설명자로 만든 클라이언트다.
// - 실제 결제사를 부르지 않는다(결제창 값 만들기는 HTTP를 부르지 않는다).
import 'reflect-metadata';
import { createDatabase, createPlatformLogger, type Database, fakeClock, type FakeClock, PlatformMetrics } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  CachedEntryPauseReader,
  CachedPgSelectionReader,
  channelTableOf,
  DrizzleEntryPause,
  DrizzlePaymentStore,
  DrizzlePgSelection,
  DrizzlePgSelectionBatch,
  ENTRY_PAUSE_CACHE_TTL_MS,
  GetNewPaymentPause,
  paymentCheckoutLog,
  paymentCommandLog,
  paymentPackage,
  paymentServiceHandlers,
  PrepareCheckout,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, msOf, newId, paymentClient, type PaymentClient, unary } from './support.js';

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;

interface Stack {
  client: PaymentClient;
  clock: FakeClock;
  metrics(): Promise<string>;
  close(): Promise<void>;
}

/** 파드 하나(재시작을 보려고 시험마다 새로 만든다). 어댑터는 TOSS·SIMULATOR뿐이라 PORTONE은 채널이 없다 */
async function startPod(): Promise<Stack> {
  const clock = fakeClock({ now: Date.now() });
  const metrics = new PlatformMetrics('payment-svc');
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'fatal' });
  const signals = new PromPaymentCommandSignals();
  signals.register(metrics.registry);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: hot });
  const gateways = new StaticPaymentGateways([new TossPaymentGateway({ baseUrl: 'https://api.tosspayments.com', secretKey: 'test_sk_integration', clientKey: 'test_ck_integration' }), new SimulatorPaymentGateway({ baseUrl: 'http://sim.test', secretKey: 'sim_sk_it', clientKey: 'sim_ck_it' })]);
  const selection = new CachedPgSelectionReader({ reader: new DrizzlePgSelection({ database: hot }), clock });
  const entry = new DrizzleEntryPause({ database: hot });
  const pauses = new CachedEntryPauseReader({ reader: entry, clock, signals: checkoutSignals });
  const channels = channelTableOf(gateways);
  const defaults = { primary: 'TOSS', fallback: 'SIMULATOR' } as const;
  const handlers = paymentServiceHandlers(
    {
      accept: new AcceptPaymentCommand({ store, clock, log: paymentCommandLog(logger), signals }),
      batchGet: new BatchGetPaymentStates({ reader: store, signals }),
      prepareCheckout: new PrepareCheckout({ selection, pauses, trials: entry, gateways, channels, defaults, webOrigin: 'https://www.it.example', virtualAccountReady: true, clock, log: paymentCheckoutLog(logger), signals: checkoutSignals }),
      getNewPaymentPause: new GetNewPaymentPause({ selection: new DrizzlePgSelectionBatch({ database: batch }), pauses, channels, defaults }),
    },
    () => undefined,
  );
  const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  const client = paymentClient(`127.0.0.1:${server.port}`);
  return {
    client,
    clock,
    metrics: () => metrics.registry.metrics(),
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-pause-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-pause-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-pause-it-batch' });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close()]);
  pgc?.stop();
});

const stacks: Stack[] = [];
const pod = async (): Promise<Stack> => {
  const s = await startPod();
  stacks.push(s);
  return s;
};
const tickTtl = (s: Stack): void => s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);

beforeEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.close()));
  await admin.pool.query('truncate payment_entry_pause, payment_entry_trial, event_pg_config, pg_switch');
});

const SINCE = new Date('2026-11-09T03:00:00.123Z');
const putPause = (o: { pg?: string; stage?: string; reason?: string; since?: Date; trialStartedAt?: Date | null } = {}) =>
  admin.pool.query(
    `insert into payment_entry_pause (pg, channel, stage, reason, actor, since, trial_started_at, version) values ($1, 'ALL', $2, $3, 'SYSTEM', $4, $5, 1) on conflict (pg, channel) do update set stage = excluded.stage, reason = excluded.reason, since = excluded.since, trial_started_at = excluded.trial_started_at`,
    [o.pg ?? 'TOSS', o.stage ?? 'PROBING', o.reason ?? 'PG_FAILURE', o.since ?? SINCE, o.trialStartedAt === undefined ? (o.stage === 'TRIAL' ? new Date(Date.now() - 60_000) : null) : o.trialStartedAt],
  );
const openPause = (pg = 'TOSS') => admin.pool.query(`update payment_entry_pause set stage = 'OPEN' where pg = $1`, [pg]);
const admit = (orderId: string, pg = 'TOSS', at: Date = new Date()) => admin.pool.query('insert into payment_entry_trial (order_id, pg, admitted_at) values ($1, $2, $3)', [orderId, pg, at]);
const putConfig = (eventId: string, primary: string, fallback: string | null = null) => admin.pool.query('insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, $2, $3, now())', [eventId, primary, fallback]);
const putSwitch = (scope: string, toPg: string, version = 1) => admin.pool.query(`insert into pg_switch (scope, active, from_pg, to_pg, version, changed_at) values ($1, true, 'TOSS', $2, $3, $4)`, [scope, toPg, version, SINCE]);

const requestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ order_kind: 'ORDER_KIND_TICKET', order_id: newId(), attempt_id: newId(), event_id: newId(), amount: { krw: 55_000 }, order_name: '통합 공연 티켓', pay_method: 'CARD', ...over });
const prepare = (s: Stack, request: object) => unary(s.client, 'PrepareCheckout', request);
const pausesOf = async (s: Stack, ids: string[]) => (await unary(s.client, 'GetNewPaymentPause', { event_ids: ids })).pauses as { event_id: string; paused_since: unknown }[];

const FAILED_PRECONDITION = 9;

describe('PrepareCheckout과 정지 행', () => {
  test('P-T43_열린 동안은 값을 주고, 행을 넣으면 1초 안에 503(FAILED_PRECONDITION)이고, 해제하면 다시 통과한다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.2]', async () => {
    const s = await pod();
    await expect(prepare(s, requestOf())).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
    await putPause();
    // 캐시 수명 안에는 이전 값이다
    await expect(prepare(s, requestOf())).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
    tickTtl(s);
    const err = await failure(prepare(s, requestOf()));
    expect(err.code).toBe(FAILED_PRECONDITION);
    expect(err.details).toBe('new-payment-paused');
    await openPause();
    tickTtl(s);
    await expect(prepare(s, requestOf())).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
    expect(await s.metrics()).toMatch(/payment_checkout_prepared_total\{pg="TOSS",outcome="new_payment_paused"\} 1/);
  });

  test('P-T43_파드를 다시 띄운 뒤에도 정지 행을 읽는다(메모리에만 있지 않다)', async () => {
    await putPause();
    const s = await pod();
    const err = await failure(prepare(s, requestOf()));
    expect(err.details).toBe('new-payment-paused');
  });

  test('P-T43_시험 재개에서 받은 주문의 재호출만 다시 통과하고 받지 않은 주문은 503이다 [ASVS v5.0.0-2.3.2]', async () => {
    await putPause({ stage: 'TRIAL' });
    const orderId = newId();
    await admit(orderId);
    const s = await pod();
    await expect(prepare(s, requestOf({ order_id: orderId }))).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
    expect((await failure(prepare(s, requestOf()))).details).toBe('new-payment-paused');
  });

  test('P-T43_리뷰 고침 L4: 앞 시험 재개에서 받은 주문의 행은 다음 시험 재개를 통과시키지 않는다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.2]', async () => {
    await putPause({ stage: 'TRIAL', trialStartedAt: new Date(Date.now() - 60_000) });
    const stale = newId();
    const current = newId();
    await admit(stale, 'TOSS', new Date(Date.now() - 120_000));
    await admit(current, 'TOSS', new Date(Date.now() - 1_000));
    const s = await pod();
    expect((await failure(prepare(s, requestOf({ order_id: stale })))).details).toBe('new-payment-paused');
    await expect(prepare(s, requestOf({ order_id: current }))).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
  });

  test('P-T43_리뷰 고침 L4: 시험 시작 시각이 비어 있으면 받은 주문이어도 통과시키지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    await putPause({ stage: 'TRIAL', trialStartedAt: null });
    const orderId = newId();
    await admit(orderId);
    const s = await pod();
    expect((await failure(prepare(s, requestOf({ order_id: orderId })))).details).toBe('new-payment-paused');
  });

  test('P-T43_재생(pinned_pg)은 정지를 보지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    await putPause();
    const s = await pod();
    await expect(prepare(s, requestOf({ pinned_pg: 'PG_PROVIDER_TOSS' }))).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
  });

  test('P-T43_다른 결제사의 정지는 이 회차를 막지 않는다', async () => {
    await putPause({ pg: 'SIMULATOR' });
    const s = await pod();
    await expect(prepare(s, requestOf())).resolves.toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
  });

  test('P-T43_채널이 없는 결제사를 고른 회차는 new-payment-paused다 [ASVS v5.0.0-16.5.3]', async () => {
    const eventId = newId();
    await putConfig(eventId, 'PORTONE');
    const s = await pod();
    expect((await failure(prepare(s, requestOf({ event_id: eventId })))).details).toBe('new-payment-paused');
  });
});

describe('GetNewPaymentPause', () => {
  test('P-T43_회차와 시작 시각을 돌려주고, 시험 재개에도 남고, 해제하면 빠진다 [ASVS v5.0.0-15.3.1]', async () => {
    const paused = newId();
    const other = newId();
    await putConfig(other, 'SIMULATOR');
    await putPause();
    const s = await pod();
    let pauses = await pausesOf(s, [paused, other]);
    expect(pauses.map((p) => p.event_id)).toEqual([paused]);
    expect(msOf(pauses[0]!.paused_since)).toBe(SINCE.getTime());

    await putPause({ stage: 'TRIAL' });
    tickTtl(s);
    expect((await pausesOf(s, [paused])).map((p) => p.event_id)).toEqual([paused]);

    await openPause();
    tickTtl(s);
    expect(await pausesOf(s, [paused])).toEqual([]);
  });

  test('P-T43_채널이 없는 회차는 paused_since 0으로 돌려준다 [ASVS v5.0.0-16.5.3]', async () => {
    const eventId = newId();
    await putConfig(eventId, 'PORTONE');
    const s = await pod();
    const pauses = await pausesOf(s, [eventId]);
    expect(pauses.map((p) => p.event_id)).toEqual([eventId]);
    expect(msOf(pauses[0]!.paused_since)).toBe(0);
  });

  test('P-T43_틀린 회차 ID는 INVALID_ARGUMENT다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = await pod();
    expect((await failure(pausesOf(s, ['not-a-uuid']))).code).toBe(3);
  });

  test('P-T43_리뷰 고침 M1: 회차 200개를 트랜잭션 하나로 읽고 회차 하나씩 읽은 값과 같다 [ASVS v5.0.0-2.3.2]', async () => {
    const assigned = newId();
    const switched = newId();
    const bare = newId();
    const ids = [assigned, switched, bare, ...Array.from({ length: 197 }, () => newId())];
    await putConfig(assigned, 'SIMULATOR', 'TOSS');
    await putConfig(switched, 'TOSS');
    await putSwitch(switched, 'SIMULATOR', 3);
    await putSwitch('PLATFORM', 'TOSS', 7);
    const spy = vi.spyOn(batch, 'transaction');
    const states = await new DrizzlePgSelectionBatch({ database: batch }).readMany(ids, { remainingMs: 2_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(states.size).toBe(200);
    const single = new DrizzlePgSelection({ database: hot });
    for (const id of [assigned, switched, bare]) expect(states.get(id)).toEqual(await single.read(id));
    expect(states.get(assigned)?.assignment).toEqual({ primary: 'SIMULATOR', fallback: 'TOSS' });
    expect(states.get(switched)?.eventSwitch).toMatchObject({ scope: switched, active: true, toPg: 'SIMULATOR', version: 3 });
    expect(states.get(bare)).toEqual({ platformSwitch: expect.objectContaining({ scope: 'PLATFORM', toPg: 'TOSS', version: 7 }) });
  });
});
