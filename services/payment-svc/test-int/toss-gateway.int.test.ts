// 토스 어댑터를 승인 실행기·UNKNOWN 조회 실행기에 붙여 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터로 돈다(P-T16의 시뮬레이터 몫, BUILD_ORDER PRF-184).
// 정본: docs/features/payment.md §2.1 '토스 어댑터의 첫 구현'·§2 '승인 실행기의 첫 구현'·'UNKNOWN 해소의 첫 구현'.
// 실제 토스 서버는 부르지 않는다(HOT-145). 명령은 pg TOSS로 실제 ConfirmPayment에 넣고, 어댑터만 시뮬레이터 주소를 본다. 시계는 스택의 가짜 시계 하나이고 실행기는 손으로 돌린다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  DrizzleConfirmJobs,
  PaymentConfirmRunner,
  paymentConfirmLog,
  PaymentUnknownResolver,
  paymentUnknownLog,
  PgCallGuards,
  pgCallGuardLog,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, startGrpcStack, tossConfirm, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const KEY = `sim_sk_${randomBytes(16).toString('hex')}`;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let app: SimulatorApp;
let url: string;
let stack: GrpcStack;
let confirmRunner: PaymentConfirmRunner;
let resolver: PaymentUnknownResolver;
let metrics: PlatformMetrics;
const logs: string[] = [];
const seen: { path: string; authorization: string | null; idemKey: string | null }[] = [];

const auth = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const control = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

const approvals = async (orderId: string): Promise<number> =>
  (await (await control('GET', '/sim/ledger')).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { order_ref: string })
    .filter((r) => r.order_ref === orderId).length;

/** pg, outcome 이름표가 맞는 카운터 값 */
async function counter(name: string, pg: string, outcome: string): Promise<number> {
  const line = (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(`pg="${pg}"`) && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

async function drive(runner: PaymentConfirmRunner | PaymentUnknownResolver): Promise<void> {
  await runner.tick();
  await runner.whenIdle();
}

/** 시뮬레이터에서 인증하고 pg TOSS로 실제 ConfirmPayment를 넣는다 */
async function accepted(amount = 39_000): Promise<{ orderId: string; paymentKey: string; amount: number }> {
  const orderId = newId();
  const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓' });
  expect(r.status).toBe(200);
  const { paymentKey } = (await r.json()) as { paymentKey: string };
  const f = tossConfirm({ pg: 'TOSS', orderId, paymentKey, amount, authenticatedAtMs: stack.clock.now() - 1_000 });
  await unary(stack.client, 'ConfirmPayment', f.request);
  return { orderId, paymentKey, amount };
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'toss-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'toss-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'toss-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'toss-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);

  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  stack = await startGrpcStack({ hot, batch });

  const counting: typeof fetch = async (input, init) => {
    const h = new Headers(init?.headers);
    seen.push({ path: `${init?.method} ${new URL(String(input)).pathname}`, authorization: h.get('authorization'), idemKey: h.get('idempotency-key') });
    return fetch(input, init);
  };
  const gateways = new StaticPaymentGateways([new TossPaymentGateway({ baseUrl: url, secretKey: KEY, clientKey: 'sim_ck_test_client', fetch: counting })]);
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: stack.clock, level: 'info', destination });
  metrics = new PlatformMetrics('payment-svc');
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: stack.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger) });
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: stack.clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  confirmRunner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: stack.clock, podId: 'pod-toss', timer: silent });
  resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock: stack.clock, timer: silent });
}, 180_000);

afterAll(async () => {
  await stack?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
  seen.length = 0;
});

describe('P-T16 토스 어댑터 + 승인 실행기', () => {
  test('P-T16_리뷰 고침 H2: 결제사가 일시 오류 코드로 답하면 FAILED로 쓰지 않고 UNKNOWN이다(승인 0건, 단독 조회가 정한다) [ASVS v5.0.0-16.5.3]', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'decline', code: 'PROVIDER_ERROR' })).status).toBe(204);

    await drive(confirmRunner);

    const { payments, jobs } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ pg: 'TOSS', status: 'UNKNOWN' });
    expect(jobs).toEqual([]);
    expect(await approvals(f.orderId)).toBe(0);
  });


  test('P-T16_pg TOSS 명령이 토스 어댑터로 승인 끝까지 간다(Basic 키, 멱등키, 승인 1건, 지표 pg=TOSS, 로그에 키 없음) [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-16.2.5]', async () => {
    const f = await accepted();

    await drive(confirmRunner);

    const { payments, events, jobs } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ pg: 'TOSS', status: 'APPROVED', pg_payment_ref: f.paymentKey, amount: f.amount });
    expect(payments[0]!.approved_at?.getTime()).toBe(SIM_NOW_MS);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['APPROVED']));
    expect(jobs).toEqual([]);
    expect(await approvals(f.orderId)).toBe(1);
    expect(seen).toEqual([{ path: 'POST /v1/payments/confirm', authorization: auth, idemKey: `confirm-${f.orderId}` }]);
    expect(await counter('payment_confirm_total', 'TOSS', 'approved')).toBe(1);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  test('P-T16_응답을 잃으면 UNKNOWN이고 단독 조회가 토스 어댑터로 승인을 확정한다(승인 1건) [ASVS v5.0.0-16.5.3]', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: true })).status).toBe(204);

    await drive(confirmRunner);
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'TOSS', status: 'UNKNOWN' });
    expect(await approvals(f.orderId)).toBe(1);

    stack.clock.advance(6_000);
    await drive(resolver);

    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'TOSS', status: 'APPROVED', amount: f.amount });
    expect(seen.map((s) => s.path)).toEqual(['POST /v1/payments/confirm', `GET /v1/payments/${f.paymentKey}`]);
    expect(await approvals(f.orderId)).toBe(1);
    expect(await counter('payment_unknown_query_total', 'TOSS', 'approved')).toBe(1);
    expect(logs.join('\n')).not.toContain(KEY);
  });
});
