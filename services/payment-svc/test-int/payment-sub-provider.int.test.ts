// 포트원 채널의 하위 결제사 검사(BUILD_ORDER PRF-203, P-T46)를 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터 둘(토스형·포트원형)로 돈다.
// 정본: docs/features/payment.md §2.2 '대체 채널의 하위 결제사'·'하위 결제사 검사의 첫 구현'·'장애 시 전환'·P-T46, docs/data.md §2 ④·§5.
//
// 약속:
// - Kafka 모듈을 불러오지 않는다. 명령 12의 전송(OPS-290)은 없어 쓰임새 AssignEventPg를 바로 부르고, 명령 6은 전환 쓰기 쓰임새(applySwitch)로 쓴다.
// - 시계는 접수·저장소·실행기·캐시가 함께 쓰는 멈춘 가짜 시계다. 1초 캐시는 advance로 넘긴다.
// - 포트원형 시뮬레이터의 채널 표(채널 키 → 하위 결제사)는 제어 API로 바꾼다. payment-svc 설정의 채널 표는 시험마다 정한다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  AssignEventPg,
  CachedEntryPauseReader,
  CachedPgChannelObservations,
  CachedPgSelectionReader,
  channelTableOf,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePgChannelObserved,
  DrizzlePgSelection,
  DrizzlePgSelectionBatch,
  GetNewPaymentPause,
  PaymentConfirmRunner,
  paymentCheckoutLog,
  paymentConfirmLog,
  PgCallGuards,
  pgCallGuardLog,
  PgChannelObserver,
  pgChannelLog,
  PgFallbackSameProviderError,
  PortoneFallbackExclusions,
  PortoneGateway,
  portoneChannelMapOf,
  type PortoneChannelMap,
  PrepareCheckout,
  PromPaymentCheckoutSignals,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  PromPgChannelSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { PaymentNewPausedError } from '../src/modules/payment/domain/entry-pause.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, portoneConfirm, startGrpcStack, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-10T01:00:00.000Z');
const CHANNEL = 'channel-kcp';
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let portoneSim: { app: SimulatorApp; url: string; key: string };
let stacked: Promise<GrpcStack> | undefined;

async function startSim(): Promise<{ app: SimulatorApp; url: string; key: string }> {
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET, portoneChannels: { [CHANNEL]: 'KCP_V2' } });
  return { app, url: await app.listen({ host: '127.0.0.1', port: 0 }), key };
}

const control = (sim: { url: string; key: string }, method: string, path: string, body?: unknown) =>
  fetch(`${sim.url}${path}`, { method, headers: { authorization: `Basic ${Buffer.from(`${sim.key}:`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-sub-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-sub-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-sub-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-sub-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);
  portoneSim = await startSim();
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await portoneSim?.app.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, event_pg_config, pg_switch, payment_pg_channel_observed, payment_entry_pause');
  expect((await control(portoneSim, 'PUT', '/sim/portone/channels', { channels: { [CHANNEL]: 'KCP_V2' } })).status).toBe(204);
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));

/** payment-svc 한 벌. 토스 어댑터는 tossUrl(토스형 시뮬레이터)을 보고, 포트원 어댑터는 포트원형 시뮬레이터를 본다. portone은 설정의 채널 표다 */
async function rig(o: { portone: PortoneChannelMap; tossUrl?: string; tossKey?: string }) {
  const s = await stack();
  const logs: string[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: s.clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const channelSignals = new PromPgChannelSignals().register(metrics.registry);
  const channelLog = pgChannelLog(logger, s.clock);
  const observations = new CachedPgChannelObservations({ reader: new DrizzlePgChannelObserved({ database: hot }), clock: s.clock, signals: channelSignals });
  const observer = new PgChannelObserver({ portone: o.portone, observations, store: new DrizzlePgChannelObserved({ database: batch }), clock: s.clock, signals: channelSignals, log: channelLog });
  const gateways = new StaticPaymentGateways([
    new TossPaymentGateway({ baseUrl: o.tossUrl ?? 'http://127.0.0.1:9', secretKey: o.tossKey ?? 'sim_sk_unused_toss_key_000', clientKey: 'sim_ck_test_client' }),
    new PortoneGateway({ baseUrl: portoneSim.url, secret: portoneSim.key, storeId: 'store-sim', channelKey: CHANNEL, webhookSecrets: [WEBHOOK_SECRET], isTest: true, onChannel: (c) => observer.observe(c) }),
  ]);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const entry = new DrizzleEntryPause({ database: hot });
  const selection = new DrizzlePgSelection({ database: hot });
  const pauses = new CachedEntryPauseReader({ reader: entry, clock: s.clock, signals: checkoutSignals });
  const fallbackExclusions = new PortoneFallbackExclusions({ portone: o.portone, observations });
  const prepare = new PrepareCheckout({
    selection: new CachedPgSelectionReader({ reader: selection, clock: s.clock }),
    pauses,
    trials: entry,
    gateways,
    channels: channelTableOf(gateways),
    defaults: { primary: 'TOSS', fallback: 'PORTONE' },
    webOrigin: 'https://www.it.example',
    virtualAccountReady: true,
    clock: s.clock,
    log: paymentCheckoutLog(logger),
    signals: checkoutSignals,
    fallbackExclusions,
  });
  // 정지 조회의 빼기 읽기는 수를 센다(기준 결제사가 열려 있으면 읽지 않아야 한다)
  let exclusionReads = 0;
  const countedExclusions: typeof fallbackExclusions = Object.assign(Object.create(fallbackExclusions) as typeof fallbackExclusions, {
    read: (base: Parameters<typeof fallbackExclusions.read>[0], budget?: Parameters<typeof fallbackExclusions.read>[1]) => {
      exclusionReads += 1;
      return fallbackExclusions.read(base, budget);
    },
  });
  const pauseQuery = new GetNewPaymentPause({ selection: new DrizzlePgSelectionBatch({ database: hot }), pauses, channels: channelTableOf(gateways), defaults: { primary: 'TOSS', fallback: 'PORTONE' }, fallbackExclusions: countedExclusions });
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger) });
  const runner = new PaymentConfirmRunner({ jobs: new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock }), gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: 'pod-sub', timer: { setInterval: () => 0, clearInterval: () => undefined } });
  const assign = new AssignEventPg({ store: selection, portone: o.portone });
  return { s, logs, metrics: () => metrics.registry.metrics(), prepare, pauseQuery, exclusionReads: () => exclusionReads, runner, observer, assign, selection };
}

const checkoutOf = (eventId: string, orderId = newId()) => ({ orderKind: 'TICKET', orderId, attemptId: newId(), eventId, amount: 39_000, orderName: '통합 공연 티켓', payMethod: 'CARD' });
const assignmentOf = async (eventId: string) => (await admin.pool.query<{ pg_primary: string; pg_fallback: string | null; updated_at: Date }>('select pg_primary, pg_fallback, updated_at from event_pg_config where event_id = $1', [eventId])).rows;
const observedRows = async () => (await admin.pool.query<{ channel_key: string; pg_provider: string; observed_at: Date }>('select * from payment_pg_channel_observed order by channel_key')).rows;
const mapWith = (provider: string): PortoneChannelMap => portoneChannelMapOf({ channelKey: CHANNEL }, { [CHANNEL]: provider });

function metricLine(text: string, name: string, labels: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  return Number(line?.split(' ').at(-1) ?? 0);
}

/** 포트원형 시뮬레이터에서 그 채널로 인증하고 pg PORTONE 승인 명령을 넣은 뒤 실행기로 승인한다 */
async function payByPortone(r: Awaited<ReturnType<typeof rig>>, orderId: string, channelKey = CHANNEL): Promise<void> {
  const auth = await control(portoneSim, 'POST', '/sim/portone/authenticate', { orderId, amount: 39_000, orderName: '공연 티켓', channelKey });
  expect(auth.status).toBe(200);
  const { paymentId, paymentToken, txId } = (await auth.json()) as { paymentId: string; paymentToken: string; txId: string };
  const f = portoneConfirm({ orderId, amount: 39_000, authenticatedAtMs: r.s.clock.now() - 1_000 });
  await unary(r.s.client, 'ConfirmPayment', { ...f.request, portone: { payment_id: paymentId, tx_id: txId, payment_token: paymentToken } });
  await r.runner.tick();
  await r.runner.whenIdle();
  await r.observer.whenIdle();
}

describe('P-T46 ①②: 명령 12의 회차 지정', () => {
  test('P-T46 ① 기본 토스페이먼츠 회차의 대체로 하위 결제사 TOSSPAYMENTS인 포트원 채널을 지정하면 pg-fallback-same-provider로 거절되고 표는 앞 지정 그대로다 [ASVS v5.0.0-16.5.3]', async () => {
    const eventId = newId();
    const before = new Date(SIM_NOW_MS - 60_000);
    await admin.pool.query(`insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, 'TOSS', null, $2)`, [eventId, before]);
    const r = await rig({ portone: mapWith('TOSSPAYMENTS') });

    const err = await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PgFallbackSameProviderError);
    expect(err).toMatchObject({ problem: 'pg-fallback-same-provider', status: 422, conflict: { provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' } });
    expect(await assignmentOf(eventId)).toEqual([{ pg_primary: 'TOSS', pg_fallback: null, updated_at: before }]);
  });

  test.each([
    ['TOSS_BRANDPAY', 'SAME_PROVIDER'],
    ['TOSSPAY', 'UNCONFIRMED'],
  ])('P-T46 ② 하위 결제사 %s 채널도 거절되고 행을 만들지 않는다', async (provider, reason) => {
    const eventId = newId();
    const r = await rig({ portone: mapWith(provider) });
    const err = await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ problem: 'pg-fallback-same-provider', conflict: { provider, reason } });
    expect(await assignmentOf(eventId)).toEqual([]);
  });

  test('P-T46 ① 반대 방향(기본 포트원 토스 계열 채널, 대체 토스페이먼츠)도 거절되고 행을 만들지 않는다', async () => {
    const eventId = newId();
    const r = await rig({ portone: mapWith('TOSSPAYMENTS') });
    await expect(r.assign.execute({ eventId, primary: 'PORTONE', fallback: 'TOSS', updatedAtMs: r.s.clock.now() })).rejects.toBeInstanceOf(PgFallbackSameProviderError);
    expect(await assignmentOf(eventId)).toEqual([]);
  });

  test('P-T46 ⑤ 하위 결제사가 다른 채널은 지정되고, 늦게 온 옛 지정은 새 지정을 덮지 않는다', async () => {
    const eventId = newId();
    const r = await rig({ portone: mapWith('KCP_V2') });
    const at = r.s.clock.now();
    await expect(r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: at })).resolves.toEqual({ written: true });
    await expect(r.assign.execute({ eventId, primary: 'PORTONE', fallback: 'TOSS', updatedAtMs: at - 1 })).resolves.toEqual({ written: false });
    await expect(r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: at })).resolves.toEqual({ written: false });
    expect(await assignmentOf(eventId)).toEqual([{ pg_primary: 'TOSS', pg_fallback: 'PORTONE', updated_at: new Date(at) }]);
  });
});

describe('P-T46 ④: 결제 답의 하위 결제사 대조', () => {
  test('P-T46 ④ 설정은 KCP_V2인데 결제 답의 channel.pgProvider가 TOSSPAYMENTS면 결제는 승인되고 SEV2·지표·관측 표가 남으며, 그 채널은 전환의 대체 후보에서 빠져 기준 결제사로 간다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    const eventId = newId();
    await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() });
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'PORTONE', switched: true, checkout: { portone: { channelKey: CHANNEL } } });

    expect((await control(portoneSim, 'PUT', '/sim/portone/channels', { channels: { [CHANNEL]: 'TOSSPAYMENTS' } })).status).toBe(204);
    const orderId = newId();
    await payByPortone(r, orderId);

    expect((await ledgerOf(admin, orderId)).payments[0]!.status).toBe('APPROVED');
    const rows = await observedRows();
    expect(rows).toEqual([{ channel_key: CHANNEL, pg_provider: 'TOSSPAYMENTS', observed_at: new Date(r.s.clock.now()) }]);
    const lines = r.logs.filter((l) => l.includes('pg-channel-provider-mismatch'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', severity: 'SEV2', pg: 'PORTONE', configured: 'KCP_V2', observed: 'TOSSPAYMENTS', payMethods: ['CARD', 'EASY_PAY', 'TRANSFER', 'VIRTUAL_ACCOUNT', 'MOBILE'] });
    expect(lines[0]).not.toContain(CHANNEL);
    expect(lines[0]).not.toContain(orderId);
    expect(metricLine(await r.metrics(), 'payment_pg_channel_observed_total', 'outcome="mismatch"')).toBe(1);
    expect(metricLine(await r.metrics(), 'payment_pg_channel_observed_total', 'outcome="match"')).toBe(0);

    r.s.clock.advance(1_001);
    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'TOSS', switched: false });
  });

  test('P-T46 ④ 같은 관측 값을 다시 봐도 표를 다시 쓰지 않고 SEV2도 다시 내지 않으며, 설정을 관측 값(TOSSPAYMENTS)으로 고쳐도 규칙에 걸려 대체 후보에서 빠진다', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    expect((await control(portoneSim, 'PUT', '/sim/portone/channels', { channels: { [CHANNEL]: 'TOSSPAYMENTS' } })).status).toBe(204);
    await payByPortone(r, newId());
    const first = await observedRows();
    r.s.clock.advance(2_000);
    await payByPortone(r, newId());
    expect(await observedRows()).toEqual(first);
    expect(r.logs.filter((l) => l.includes('pg-channel-provider-mismatch'))).toHaveLength(1);

    // 설정을 관측 값으로 고친 파드(같은 관측 표)에서는 관측 값이 설정과 같아도 하위 결제사 규칙이 그 채널을 뺀다(고치기 전의 지정과 전환은 SQL로 둔다, 코드 리뷰 F1)
    const fixed = await rig({ portone: mapWith('TOSSPAYMENTS') });
    const eventId = newId();
    await admin.pool.query(`insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, 'TOSS', 'PORTONE', now())`, [eventId]);
    await fixed.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: fixed.s.clock.now() });
    expect(await fixed.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'TOSS', switched: false });
  });

  test('P-T46 ④ 결제 답의 하위 결제사가 설정과 같으면 관측 표를 쓰지 않고 SEV2도 없다', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    await payByPortone(r, newId());
    expect(await observedRows()).toEqual([]);
    expect(r.logs.filter((l) => l.includes('pg-channel-provider-mismatch'))).toEqual([]);
    expect(metricLine(await r.metrics(), 'payment_pg_channel_observed_total', 'outcome="match"')).toBe(1);
    expect(metricLine(await r.metrics(), 'payment_pg_channel_observed_total', 'outcome="mismatch"')).toBe(0);
  });
});

describe('P-T46 ④: 코드 리뷰 고침(PRF-203)', () => {
  test('P-T46 ④ 설정 값이 처음부터 TOSSPAYMENTS인 채널(옛 회차 지정·전환 대상 PORTONE)은 관측 표가 비어도 하위 결제사 규칙으로 전환의 대체 후보에서 빠져 기준 결제사로 간다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig({ portone: mapWith('TOSSPAYMENTS') });
    const eventId = newId();
    await admin.pool.query(`insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, 'TOSS', 'PORTONE', now())`, [eventId]);
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', toPg: 'PORTONE', version: 1, changedAtMs: r.s.clock.now() });
    expect(await observedRows()).toEqual([]);
    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'TOSS', switched: false });
  });

  test('P-T46 ④ 전환으로 고를 포트원 카드 채널이 빠졌고 기준 결제사(토스)가 정지면 결제창 준비는 새 결제 일시 정지이고 정지 조회도 그 회차를 정지로 돌려준다(홀드 남은 시간이 멈춘다)', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    const eventId = newId();
    await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() });
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    const since = new Date(r.s.clock.now() - 60_000);
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('TOSS', 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', $1, 1)`, [since]);
    await admin.pool.query(`insert into payment_pg_channel_observed (channel_key, pg_provider, observed_at) values ($1, 'TOSSPAYMENTS', $2)`, [CHANNEL, new Date(r.s.clock.now())]);

    await expect(r.prepare.execute(checkoutOf(eventId))).rejects.toBeInstanceOf(PaymentNewPausedError);
    expect(await r.pauseQuery.execute([eventId])).toEqual([{ eventId, pausedSinceMs: since.getTime() }]);
  });

  test('P-T46 ⑤ 전환 대상이 포트원이고 기준 결제사(토스)가 정지여도 빠진 포트원 채널이 없으면 정지 조회는 그 회차를 돌려주지 않는다(전환이 결제를 받는다, 코드 리뷰)', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    const eventId = newId();
    await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() });
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('TOSS', 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', $1, 1)`, [new Date(r.s.clock.now() - 60_000)]);

    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'PORTONE', switched: true });
    expect(await r.pauseQuery.execute([eventId])).toEqual([]);
    expect(r.exclusionReads()).toBe(1);
  });

  test('P-T46 ⑤ 기준 결제사(토스)가 열려 있으면 정지 조회는 빠진 포트원 채널이 있어도 관측 표를 읽지 않고 그 회차를 돌려주지 않는다(코드 리뷰)', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    const eventId = newId();
    await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() });
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    await admin.pool.query(`insert into payment_pg_channel_observed (channel_key, pg_provider, observed_at) values ($1, 'TOSSPAYMENTS', $2)`, [CHANNEL, new Date(r.s.clock.now())]);

    expect(await r.pauseQuery.execute([eventId])).toEqual([]);
    expect(r.exclusionReads()).toBe(0);
  });

  test('P-T46 ④ 설정과 다른 관측 값(TOSSPAYMENTS)이 남은 채널은 뒤에 설정과 같은 답(KCP_V2, 옛 결제의 조회 등)이 와도 행이 그대로이고 여전히 대체 후보에서 빠진다', async () => {
    const r = await rig({ portone: mapWith('KCP_V2') });
    const at = new Date(r.s.clock.now() - 5_000);
    await admin.pool.query(`insert into payment_pg_channel_observed (channel_key, pg_provider, observed_at) values ($1, 'TOSSPAYMENTS', $2)`, [CHANNEL, at]);
    await payByPortone(r, newId());
    expect(await observedRows()).toEqual([{ channel_key: CHANNEL, pg_provider: 'TOSSPAYMENTS', observed_at: at }]);
    expect(metricLine(await r.metrics(), 'payment_pg_channel_observed_total', 'outcome="match"')).toBe(1);

    const eventId = newId();
    await r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() });
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    r.s.clock.advance(1_001);
    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'TOSS', switched: false });
  });
});

describe('P-T46 ⑤: 전환', () => {
  test('P-T46 ⑤ 하위 결제사가 다른 채널(KCP_V2)을 대체로 두고 토스형 시뮬레이터를 멈춘 뒤 명령 6으로 전환하면 새 결제 시도가 포트원형으로 열리고 승인된다', async () => {
    const toss = await startSim();
    const r = await rig({ portone: mapWith('KCP_V2'), tossUrl: toss.url, tossKey: toss.key });
    const eventId = newId();
    await expect(r.assign.execute({ eventId, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: r.s.clock.now() })).resolves.toEqual({ written: true });
    expect(await r.prepare.execute(checkoutOf(eventId))).toMatchObject({ pg: 'TOSS', switched: false });

    await toss.app.close();
    await expect(fetch(`${toss.url}/v1/payments/x`)).rejects.toThrow();
    await r.selection.applySwitch({ scope: eventId, active: true, fromPg: 'TOSS', version: 1, changedAtMs: r.s.clock.now() });
    r.s.clock.advance(1_001);

    const orderId = newId();
    const answer = await r.prepare.execute(checkoutOf(eventId, orderId));
    expect(answer).toMatchObject({ pg: 'PORTONE', switched: true, checkout: { portone: { channelKey: CHANNEL, paymentId: `pay-${orderId}` } } });

    await payByPortone(r, orderId);
    expect((await ledgerOf(admin, orderId)).payments[0]).toMatchObject({ pg: 'PORTONE', status: 'APPROVED' });
    const ledger = (await (await control(portoneSim, 'GET', '/sim/ledger')).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { order_ref: string });
    expect(ledger.filter((x) => x.order_ref === orderId)).toHaveLength(1);
    expect(await observedRows()).toEqual([]);
  });
});
