// 포트원 어댑터를 승인 실행기·UNKNOWN 조회 실행기에 붙여 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터(포트원 경로)로 돈다(P-T16의 시뮬레이터 몫, BUILD_ORDER HOT-140).
// 정본: docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현'. 실제 포트원 서버는 부르지 않는다(HOT-145). 명령은 pg PORTONE으로 실제 ConfirmPayment에 넣고, 어댑터만 시뮬레이터 주소를 본다.
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
  PortoneGateway,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, portoneConfirm, startGrpcStack, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const KEY = `sim_sk_${randomBytes(16).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;

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
const confirmBodies: string[] = [];

const basic = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const control = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${url}${path}`, { method, headers: { authorization: basic, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

const approvals = async (orderId: string): Promise<number> =>
  (await (await control('GET', '/sim/ledger')).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { order_ref: string })
    .filter((r) => r.order_ref === orderId).length;

async function counter(name: string, pg: string, outcome: string, from: PlatformMetrics = metrics): Promise<number> {
  const line = (await from.registry.metrics()).split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(`pg="${pg}"`) && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

async function drive(runner: PaymentConfirmRunner | PaymentUnknownResolver): Promise<void> {
  await runner.tick();
  await runner.whenIdle();
}

/** 시뮬레이터에서 인증하고 pg PORTONE으로 실제 ConfirmPayment를 넣는다 */
async function accepted(amount = 39_000): Promise<{ orderId: string; paymentId: string; paymentToken: string; txId: string; amount: number }> {
  const orderId = newId();
  const r = await control('POST', '/sim/portone/authenticate', { orderId, amount, orderName: '공연 티켓' });
  expect(r.status).toBe(200);
  const { paymentId, paymentToken, txId } = (await r.json()) as { paymentId: string; paymentToken: string; txId: string };
  const f = portoneConfirm({ orderId, amount, authenticatedAtMs: stack.clock.now() - 1_000 });
  const request = { ...f.request, portone: { payment_id: paymentId, tx_id: txId, payment_token: paymentToken } };
  await unary(stack.client, 'ConfirmPayment', request);
  return { orderId, paymentId, paymentToken, txId, amount };
}

/** 단독 조회 실행기를 따로 만든다(잘못된 상점 설정을 흉내 내는 어댑터용). 지표는 새 묶음에 적는다 */
function resolverWith(gateway: PortoneGateway): { resolver: PaymentUnknownResolver; localMetrics: PlatformMetrics } {
  const gateways = new StaticPaymentGateways([gateway]);
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: stack.clock, level: 'info', destination: new Writable({ write: (_c, _e, cb) => cb() }) });
  const localMetrics = new PlatformMetrics('payment-svc');
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: stack.clock, signals: new PromPgCallGuardSignals().register(localMetrics.registry), log: pgCallGuardLog(logger) });
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: stack.clock });
  const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(localMetrics.registry), clock: stack.clock, timer: { setInterval: () => 0, clearInterval: () => {} } });
  return { resolver, localMetrics };
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'portone-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'portone-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'portone-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'portone-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);

  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  stack = await startGrpcStack({ hot, batch });

  const counting: typeof fetch = async (input, init) => {
    const h = new Headers(init?.headers);
    seen.push({ path: `${init?.method} ${new URL(String(input)).pathname}`, authorization: h.get('authorization'), idemKey: h.get('idempotency-key') });
    if (new URL(String(input)).pathname.endsWith('/confirm')) confirmBodies.push(String(init?.body ?? ''));
    return fetch(input, init);
  };
  const gateways = new StaticPaymentGateways([new PortoneGateway({ baseUrl: url, secret: KEY, storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true, fetch: counting })]);
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
  confirmRunner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: stack.clock, podId: 'pod-portone', timer: silent });
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
  confirmBodies.length = 0;
});

describe('P-T16 포트원 어댑터 + 승인 실행기', () => {
  test('P-T16_pg PORTONE 명령이 포트원 어댑터로 승인 끝까지 가고 결제 토큰을 지운다(PortOne 머리, 따옴표 멱등키, 승인 1건, 지표 pg=PORTONE, 로그에 비밀 없음) [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-14.2.7] [ASVS v5.0.0-16.2.5]', async () => {
    const f = await accepted();
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg_confirm_token: f.paymentToken });

    await drive(confirmRunner);

    const { payments, events, jobs } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ pg: 'PORTONE', status: 'APPROVED', pg_payment_ref: f.paymentId, amount: f.amount, pg_confirm_token: null });
    expect(payments[0]!.approved_at?.getTime()).toBe(SIM_NOW_MS);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['APPROVED']));
    expect(jobs).toEqual([]);
    expect(await approvals(f.orderId)).toBe(1);
    expect(seen).toEqual([
      { path: `POST /payments/${f.paymentId}/confirm`, authorization: `PortOne ${KEY}`, idemKey: `"confirm-${f.orderId}"` },
      { path: `GET /payments/${f.paymentId}`, authorization: `PortOne ${KEY}`, idemKey: null },
    ]);
    expect(await counter('payment_confirm_total', 'PORTONE', 'approved')).toBe(1);
    const text = logs.join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(f.paymentToken);
  });

  test('P-T16_응답을 잃으면 UNKNOWN이고 토큰이 남다가 단독 조회가 확정하면 지운다(승인 1건) [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-14.2.7]', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: true })).status).toBe(204);

    await drive(confirmRunner);
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'PORTONE', status: 'UNKNOWN', pg_confirm_token: f.paymentToken });
    expect(await approvals(f.orderId)).toBe(1);

    stack.clock.advance(6_000);
    await drive(resolver);

    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'PORTONE', status: 'APPROVED', amount: f.amount, pg_confirm_token: null });
    expect(seen.map((s) => s.path)).toEqual([`POST /payments/${f.paymentId}/confirm`, `GET /payments/${f.paymentId}`]);
    expect(await approvals(f.orderId)).toBe(1);
    expect(await counter('payment_unknown_query_total', 'PORTONE', 'approved')).toBe(1);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  test('P-T16_금액이 다른 결제사 답은 거절로 끝나고 승인되지 않는다(INFORMATION_MISMATCH) [ASVS v5.0.0-2.2.3]', async () => {
    const f = await accepted();
    await admin.pool.query('update payment set amount = amount + 1 where order_id = $1', [f.orderId]);

    await drive(confirmRunner);

    const { payments } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ pg: 'PORTONE', status: 'FAILED', failure_category: 'VALIDATION', pg_confirm_token: null });
    expect(await approvals(f.orderId)).toBe(0);
  });

  test('P-T16_포트원 기록 없음은 실패로 끝내지 않고 UNKNOWN을 유지한다', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: false })).status).toBe(204);
    await drive(confirmRunner);
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'UNKNOWN' });

    expect((await control('POST', '/sim/reset')).status).toBe(204);
    stack.clock.advance(6_000);
    await drive(resolver);

    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'UNKNOWN', pg_confirm_token: f.paymentToken });
    expect(await counter('payment_unknown_query_total', 'PORTONE', 'not_found')).toBe(1);
  });

  test('P-T16_리뷰 고침 낮음: 잘못된 상점 설정은 기록 없음과 같은 답이라 승인된 결제도 실패로 끝내지 않고 UNKNOWN을 유지한다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: true })).status).toBe(204);
    await drive(confirmRunner);
    expect(await approvals(f.orderId)).toBe(1);

    const { resolver: wrongStore, localMetrics } = resolverWith(new PortoneGateway({ baseUrl: url, secret: KEY, storeId: 'store-wrong', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true }));
    stack.clock.advance(6_000);
    await drive(wrongStore);

    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'UNKNOWN', pg_confirm_token: f.paymentToken });
    expect(await counter('payment_unknown_query_total', 'PORTONE', 'not_found', localMetrics)).toBe(1);
    expect(await counter('payment_unknown_query_total', 'PORTONE', 'approved', localMetrics)).toBe(0);
  });

  test('P-T16_리뷰 고침 H4: 승인 본문에 원장의 결제 시도 ID를 싣는다 [ASVS v5.0.0-2.2.3]', async () => {
    const f = await accepted();
    await drive(confirmRunner);
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'APPROVED', pg_tx_id: f.txId });
    expect(JSON.parse(confirmBodies[0]!)).toMatchObject({ txId: f.txId });
  });

  test('P-T16_리뷰 고침 H4: 응답을 잃은 뒤 같은 결제 ID의 다른 시도가 승인되면 그 상태를 이 시도의 결과로 쓰지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
    const f = await accepted();
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: false })).status).toBe(204);
    await drive(confirmRunner);
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'UNKNOWN' });

    const again = await control('POST', '/sim/portone/authenticate', { orderId: f.orderId, amount: f.amount, orderName: '공연 티켓' });
    const second = (await again.json()) as { paymentId: string; paymentToken: string; txId: string };
    const paid = await fetch(`${url}/payments/${second.paymentId}/confirm`, {
      method: 'POST',
      headers: { authorization: `PortOne ${KEY}`, 'content-type': 'application/json', 'idempotency-key': `"confirm-second-attempt-${f.orderId}"` },
      body: JSON.stringify({ paymentToken: second.paymentToken, totalAmount: f.amount, currency: 'KRW', isTest: true }),
    });
    expect(paid.status).toBe(200);

    const before = await counter('payment_unknown_query_total', 'PORTONE', 'query_failed');
    stack.clock.advance(6_000);
    await drive(resolver);

    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'UNKNOWN', pg_confirm_token: f.paymentToken });
    expect(await counter('payment_unknown_query_total', 'PORTONE', 'query_failed')).toBe(before + 1);
  });
});
