// 결제사 서킷(BUILD_ORDER PRF-200)을 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소·실행기·차단기로 돈다. Kafka 모듈은 불러오지 않는다.
// 정본: docs/features/payment.md §2 '결제사 서킷의 첫 구현'·P-T43(이 단계 몫)·P-T40, docs/data.md 마이그레이션 0010, docs/security/asvs/payment.md.
// 약속: 컨테이너 하나를 파일 전체가 쓰고 시험마다 표를 비운다. 시계는 접수·저장소·실행기·판정 창이 함께 쓰는 가짜 시계이고, 차단기의 '열린 뒤 시험까지' 타이머만 실시간이다(openMs를 작게 준다).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { BreakerPgCircuits } from '../src/modules/payment/adapters/pg-circuit.js';
import { PromPaymentResolutionSignals } from '../src/modules/payment/adapters/prom-payment-resolution-signals.js';
import {
  CONFIRM_LEASE_MS,
  CONFIRM_SENT_EVENT_TYPE,
  DrizzleConfirmJobs,
  PaymentConfirmRunner,
  paymentConfirmLog,
  paymentUnknownLog,
  PaymentUnknownResolver,
  PgCallGuards,
  pgCallGuardLog,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, startGrpcStack, tossConfirm, type TossFixture, unary, until } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let app: SimulatorApp;
let simUrl: string;
let simKey: string;
let stacked: Promise<GrpcStack> | undefined;

const control = (method: string, path: string, body?: unknown) =>
  fetch(`${simUrl}${path}`, { method, headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-circuit-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-circuit-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'payment-circuit-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-circuit-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  app = buildSimulatorApp({ secretKey: simKey, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  simUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, payment_entry_pause, payment_entry_trial');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));

async function rig(openMs = 200) {
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
  const gateway = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client' });
  const gateways = new StaticPaymentGateways([gateway]);
  const circuits = new BreakerPgCircuits({ service: 'payment-svc', registry: metrics.registry, logger, clock: s.clock, overrides: { minCalls: 3, failureRatePercent: 50, openMs } }).register(metrics.registry);
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger), circuits });
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  const resolution = new PromPaymentResolutionSignals().register(metrics.registry);
  const runner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: 'pod-circuit', timer: silent, resolution });
  const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock: s.clock, timer: silent, resolution });
  return { s, logs, circuits, runner, resolver, jobs, metrics: () => metrics.registry.metrics() };
}

async function accepted(s: GrpcStack): Promise<TossFixture & { paymentId: string }> {
  const orderId = newId();
  const amount = 39_000;
  const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓' });
  expect(r.status).toBe(200);
  const paymentKey = ((await r.json()) as { paymentKey: string }).paymentKey;
  const f = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount, authenticatedAtMs: s.clock.now() - 1_000 });
  const reply = await unary(s.client, 'ConfirmPayment', f.request);
  return { ...f, paymentId: reply.payment_id as string };
}

const statusOf = async (f: { orderId: string }): Promise<string> => (await ledgerOf(admin, f.orderId)).payments[0]!.status;
const approvals = async (orderId: string): Promise<number> =>
  (await (await control('GET', '/sim/ledger')).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { order_ref: string })
    .filter((r) => r.order_ref === orderId).length;

async function drive(runner: PaymentConfirmRunner | PaymentUnknownResolver): Promise<number> {
  const { claimed } = await runner.tick();
  await runner.whenIdle();
  return claimed;
}

describe('P-T43: 결제사 서킷 열림과 닫힘', () => {
  test('P-T43_시뮬레이터 500 연속으로 서킷이 열려 승인이 표에서 기다리고(UNKNOWN 없음), 없는 결제 조회가 시험 호출로 성공해 닫힌 뒤 이어서 승인 1건이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 3, kind: 'pg-error', applied: false })).status).toBe(204);

    const failing = await Promise.all([accepted(r.s), accepted(r.s), accepted(r.s)]);
    await drive(r.runner);
    for (const f of failing) expect(await statusOf(f)).toBe('UNKNOWN');
    expect(r.circuits.of('SIMULATOR').state()).toBe('open');
    expect(await r.metrics()).toContain('payment_pg_circuit_open{pg="SIMULATOR"} 1');

    // 열린 동안 새 명령은 잡지 않고 표에 남는다(UNKNOWN을 쓰지 않는다, 부른 적이 없다)
    const waiting = await accepted(r.s);
    expect(await drive(r.runner)).toBe(0);
    expect(await statusOf(waiting)).toBe('ACCEPTED');
    expect(await approvals(waiting.orderId)).toBe(0);

    // 반 열림이 되어도 고객 승인은 시험으로 내보내지 않는다(리뷰 고침 M4). 조회할 UNKNOWN이 때가 되지 않았으므로 없는 결제 조회가 시험 호출이고, 닫힌 뒤 이어서 승인된다
    await until(() => r.circuits.of('SIMULATOR').state() === 'half_open', '반 열림', 5_000, 10);
    expect(await drive(r.runner)).toBe(0);
    expect(await statusOf(waiting)).toBe('ACCEPTED');
    expect(await drive(r.resolver)).toBe(0);
    expect(r.circuits.of('SIMULATOR').state()).toBe('closed');
    expect(await drive(r.runner)).toBe(1);
    expect(await statusOf(waiting)).toBe('APPROVED');
    expect(await approvals(waiting.orderId)).toBe(1);
    expect(await r.metrics()).toContain('payment_pg_circuit_open{pg="SIMULATOR"} 0');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M4: 때가 된 UNKNOWN이 있으면 그 단독 조회가 시험 호출이 되어 서킷을 닫는다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 3, kind: 'pg-error', applied: true })).status).toBe(204);
    const failing = await Promise.all([accepted(r.s), accepted(r.s), accepted(r.s)]);
    await drive(r.runner);
    expect(r.circuits.of('SIMULATOR').state()).toBe('open');

    await until(() => r.circuits.of('SIMULATOR').state() === 'half_open', '반 열림', 5_000, 10);
    r.s.clock.advance(60_000);
    expect(await drive(r.resolver)).toBe(1);
    expect(r.circuits.of('SIMULATOR').state()).toBe('closed');
    expect((await Promise.all(failing.map(statusOf))).filter((s) => s === 'APPROVED')).toHaveLength(1);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M4: 없는 결제 조회가 500이면 다시 열리고 승인은 계속 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 3, kind: 'pg-error', applied: false })).status).toBe(204);
    await Promise.all([accepted(r.s), accepted(r.s), accepted(r.s)]);
    await drive(r.runner);
    const waiting = await accepted(r.s);

    await until(() => r.circuits.of('SIMULATOR').state() === 'half_open', '반 열림', 5_000, 10);
    expect((await control('POST', '/sim/faults', { op: 'query', times: 1, kind: 'pg-error', applied: false })).status).toBe(204);
    await drive(r.resolver);
    expect(r.circuits.of('SIMULATOR').state()).toBe('open');
    expect(await drive(r.runner)).toBe(0);
    expect(await statusOf(waiting)).toBe('ACCEPTED');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_여유가 없어 때를 넘겨 잡힌 명령은 경로 지표가 retry_queue이고, 제때 잡힌 명령은 direct다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    const direct = await accepted(r.s);
    await drive(r.runner);
    expect(await statusOf(direct)).toBe('APPROVED');

    const queued = await accepted(r.s);
    r.s.clock.advance(2_000);
    await drive(r.runner);
    expect(await statusOf(queued)).toBe('APPROVED');

    const text = await r.metrics();
    expect(text).toContain('payment_confirm_resolution_seconds_count{pg="SIMULATOR",path="direct"} 1');
    expect(text).toContain('payment_confirm_resolution_seconds_count{pg="SIMULATOR",path="retry_queue"} 1');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_서킷으로 미룬 명령은 queued_at을 남기고 attempts를 올리지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    const f = await accepted(r.s);
    const claimed = await r.jobs.claimDue('SIMULATOR', 1, 'pod-circuit', CONFIRM_LEASE_MS);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.queued).toBeUndefined();

    expect(await r.jobs.reschedule(claimed[0]!, r.s.clock.now() + 1_000, { countRetry: false, queued: true })).toBe(true);
    const row = (await ledgerOf(admin, f.orderId)).jobs[0]!;
    expect(row.attempts).toBe(0);
    const { rows } = await admin.pool.query<{ queued_at: Date | null }>('select queued_at from payment_confirm_job where payment_id = $1', [f.paymentId]);
    expect(rows[0]!.queued_at).not.toBeNull();
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M5: UNKNOWN을 거쳐 해소된 건은 경로 지표가 retry_queue다(명령이 큐를 거치지 않았어도) [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    const f = await accepted(r.s);
    await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'pg-error', applied: true });
    await drive(r.runner);
    expect(await statusOf(f)).toBe('UNKNOWN');

    r.s.clock.advance(60_000);
    expect(await drive(r.resolver)).toBe(1);

    expect(await statusOf(f)).toBe('APPROVED');
    const text = await r.metrics();
    expect(text).toContain('payment_confirm_resolution_seconds_count{pg="SIMULATOR",path="retry_queue"} 1');
    expect(text).not.toContain('payment_confirm_resolution_seconds_count{pg="SIMULATOR",path="direct"}');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T40_리뷰 고침 L7: 표시 지우기는 임대가 맞을 때만, 미루기와 함께 한다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    const f = await accepted(r.s);
    const sentCount = async (): Promise<number> => (await admin.pool.query('select 1 from payment_event where payment_id = $1 and type = $2', [f.paymentId, CONFIRM_SENT_EVENT_TYPE])).rows.length;

    const [first] = await r.jobs.claimDue('SIMULATOR', 1, 'pod-circuit', CONFIRM_LEASE_MS);
    expect(await r.jobs.markSent(first!)).toBe('MARKED');
    expect(await sentCount()).toBe(1);
    expect(await r.jobs.reschedule(first!, r.s.clock.now(), { countRetry: false, queued: true, clearSent: true })).toBe(true);
    expect(await sentCount()).toBe(0);

    // 지운 뒤 다시 잡으면 표시를 처음부터 쓴다(같은 순번을 다시 쓸 수 있다). 임대를 잃은 쓰기는 표시를 지우지 않는다
    const [second] = await r.jobs.claimDue('SIMULATOR', 1, 'pod-circuit', CONFIRM_LEASE_MS);
    expect(await r.jobs.markSent(second!)).toBe('MARKED');
    expect(await r.jobs.reschedule({ ...second!, owner: 'pod-other' }, r.s.clock.now(), { countRetry: false, queued: true, clearSent: true })).toBe(false);
    expect(await sentCount()).toBe(1);
    r.circuits.shutdown();
  }, 30_000);
});

describe('P-T43: 마이그레이션 0010', () => {
  test('P-T43_표와 CHECK: 채널은 ALL만, 단계·사유·판 번호와 시험 결과 값을 묶는다 [ASVS v5.0.0-16.5.3]', async () => {
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('TOSS', 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', now(), 1)`);
    await expect(admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('TOSS', 'CARD', 'PROBING', 'PG_FAILURE', 'SYSTEM', now(), 1)`)).rejects.toThrow(/payment_entry_pause_channel_check/);
    await expect(admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('PORTONE', 'ALL', 'WHAT', 'PG_FAILURE', 'SYSTEM', now(), 1)`)).rejects.toThrow(/payment_entry_pause_stage_check/);
    await admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_result, first_result_at, first_call_ms) values ($1, 'SIMULATOR', now(), 'APPROVED', now(), 120)`, [newId()]);
    await expect(admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_result) values ($1, 'SIMULATOR', now(), 'NOPE')`, [newId()])).rejects.toThrow(/payment_entry_trial_first_result_check/);
    const { rows } = await admin.pool.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'payment_confirm_job' and column_name = 'queued_at'`);
    expect(rows.map((x) => x.column_name)).toEqual(['queued_at']);
  }, 30_000);
});
