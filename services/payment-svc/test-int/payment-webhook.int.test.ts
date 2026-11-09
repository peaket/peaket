// 웹훅 받기를 실제 HTTP 경로(플랫폼 createService의 Fastify inject), 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp)로 돈다.
// 정본: docs/features/payment.md §5 '웹훅 받기의 첫 구현'·P-T8·P-T16·P-T17·P-T30, docs/data.md 0005·§5·§5.1, docs/verification.md §4.1, specs/payment.qnt `query`, docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 표를 비운다. 시계는 스택의 가짜 시계 하나다(멈춰 있고 advance로만 간다).
// - 스택은 처음 부를 때 만든다(시험마다 같은 스택). 시뮬레이터 어댑터가 토스 경로의 본문을 읽는다(ci 환경의 조립과 같다).
// - 원장 행은 SQL로 넣는다. '곧바로 조회'만 시뮬레이터에 실제로 승인한 결제로 본다.
// - 저장 실패는 test_hooks 스키마의 트리거로 만든다.
import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, createService, type Database, ensureOutboxPartitions, type FakeClock, fakeClock, type PlatformService, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  deleteExpiredWebhookReceipts,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  DrizzleWebhookStore,
  paymentCommandLog,
  PaymentUnknownResolver,
  paymentUnknownLog,
  paymentWebhookLog,
  PgCallGuards,
  pgCallGuardLog,
  PortoneGateway,
  PromPaymentCommandSignals,
  PromPaymentUnknownSignals,
  PromPaymentWebhookSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_RECEIPT_RETENTION_MS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  webhookReceiptsDeleteTask,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { newId } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const WEBHOOK_KEY = randomBytes(32);
const FAR_FUTURE_MS = 3_600_000;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let webhookDb: Database;
let jobsDb: Database;
let app: SimulatorApp | undefined;
let simUrl: string;
let simKey: string;
const simQueries: string[] = [];

/** 쓰인 민감 값(로그에 실리지 않는지 볼 때) */
const SECRETS = { deposit: `deposit_${randomBytes(12).toString('hex')}`, paymentKey: `tsim_${randomBytes(12).toString('hex')}` };

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-webhook-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-webhook-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'payment-webhook-it-batch' });
  webhookDb = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-webhook-it' });
  jobsDb = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-webhook-it-jobs' });
  await ensureOutboxPartitions(admin, systemClock);
  await admin.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_key (dedup_key text primary key);
    create function test_hooks.fail_receipt() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_key f where f.dedup_key = new.dedup_key) then
        raise exception 'test-forced-failure';
      end if;
      return new;
    end $f$;
    create trigger test_fail_receipt before insert on public.webhook_receipt for each row execute function test_hooks.fail_receipt();
    create table test_hooks.settle_key (dedup_key text primary key);
    create function test_hooks.settle_payment() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.settle_key s where s.dedup_key = new.dedup_key) then
        update public.payment set status = 'APPROVED', approved_at = new.received_at where id = new.payment_id;
      end if;
      return new;
    end $f$;
    create trigger test_settle_payment before insert on public.webhook_receipt for each row execute function test_hooks.settle_payment();
  `);
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  app = buildSimulatorApp({ secretKey: simKey, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  simUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 180_000);

afterAll(async () => {
  const h = await built?.catch(() => undefined);
  await h?.svc.close().catch(() => undefined);
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), webhookDb?.close(), jobsDb?.close()]);
  pgc?.stop();
});

interface Harness {
  svc: PlatformService;
  clock: FakeClock;
  logs: string[];
  resolver: PaymentUnknownResolver;
  simulator: SimulatorPaymentGateway;
}

let built: Promise<Harness> | undefined;
const harness = (): Promise<Harness> => (built ??= buildHarness());

async function buildHarness(): Promise<Harness> {
  const clock = fakeClock({ now: Date.now() });
  const logs: string[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const counting: typeof fetch = async (input, init) => {
    const target = String(input);
    if (init?.method === 'GET' && target.includes('/v1/payments/')) simQueries.push(decodeURIComponent(target.slice(target.lastIndexOf('/') + 1)));
    return fetch(input, init);
  };
  const simulator = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client', fetch: counting });
  const portone = new PortoneGateway({ baseUrl: simUrl, secret: simKey, storeId: 'store-1', channelKey: 'channel-1', webhookSecrets: [`whsec_${WEBHOOK_KEY.toString('base64')}`], isTest: true, clock, fetch: counting });
  const gateways = new StaticPaymentGateways([simulator, portone]);
  const signals = new PromPaymentWebhookSignals();
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: batch });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
  const svc = await createService({
    name: 'payment-svc',
    module: AppModule.register({
      store,
      reader: store,
      log: paymentCommandLog(logger),
      signals: new PromPaymentCommandSignals(),
      webhook: { store: new DrizzleWebhookStore({ database: webhookDb }), gateways, log: paymentWebhookLog(logger, clock), signals, allowSimulator: true },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: destination,
    requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
  });
  signals.register(svc.metrics.registry);
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  const resolver = new PaymentUnknownResolver({
    queries: new DrizzleConfirmJobs({ database: jobsDb, clock }),
    gateways,
    guards: new PgCallGuards({ gateways, podCount: 1, clock, signals: new PromPgCallGuardSignals(), log: pgCallGuardLog(logger) }),
    log: paymentUnknownLog(logger),
    signals: new PromPaymentUnknownSignals(),
    clock,
    timer: silent,
  });
  return { svc, clock, logs, resolver, simulator };
}

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, webhook_receipt, outbox');
  await admin.pool.query('truncate test_hooks.fail_key, test_hooks.settle_key');
  simQueries.length = 0;
  const h = await built?.catch(() => undefined);
  if (h) {
    h.logs.length = 0;
    // 거절 줄의 1분 문을 시험마다 다시 연다(시계는 멈춰 있다)
    h.clock.advance(60_000);
  }
});

interface Seeded {
  paymentId: string;
  orderId: string;
  ref: string;
}

/** 원장 행 하나를 SQL로 넣는다. UNKNOWN의 다음 조회 시각은 기본 1시간 뒤다 */
async function seed(h: Harness, o: { pg?: string; status?: string; orderId?: string; ref?: string; amount?: number; nextQueryAtMs?: number } = {}): Promise<Seeded> {
  const paymentId = newId();
  const orderId = o.orderId ?? newId();
  const pg = o.pg ?? 'SIMULATOR';
  const status = o.status ?? 'UNKNOWN';
  const ref = o.ref ?? (pg === 'PORTONE' ? `pay-${orderId}` : `tsim_${randomUUID()}`);
  const at = new Date(h.clock.now());
  await admin.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, status_changed_at, next_query_at)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $10, $10, $11)`,
    [paymentId, orderId, newId(), newId(), pg, ref, o.amount ?? 39_000, status, `confirm-${orderId}`, at, status === 'UNKNOWN' ? new Date(o.nextQueryAtMs ?? h.clock.now() + FAR_FUTURE_MS) : null],
  );
  return { paymentId, orderId, ref };
}

const ledgerRow = async (paymentId: string): Promise<{ status: string; next_query_at: Date | null; approved_at: Date | null }> =>
  (await admin.pool.query('select status, next_query_at, approved_at from payment where id = $1', [paymentId])).rows[0];
const receipts = async (): Promise<{ pg: string; dedup_key: string; payment_id: string | null; received_at: Date }[]> => (await admin.pool.query('select * from webhook_receipt order by dedup_key')).rows;
const eventCount = async (): Promise<number> => Number((await admin.pool.query('select count(*)::int as n from payment_event')).rows[0].n);
const outboxCount = async (): Promise<number> => Number((await admin.pool.query('select count(*)::int as n from outbox')).rows[0].n);

const tossHeaders = (id: string = `wh_${randomUUID()}`): Record<string, string> => ({ 'content-type': 'application/json', 'tosspayments-webhook-transmission-id': id });
const tossBody = (paymentKey: string, orderId?: string, status = 'DONE'): string => JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-09T10:00:00.000+09:00', data: { paymentKey, ...(orderId === undefined ? {} : { orderId }), status, totalAmount: 1 } });
const portoneBody = (paymentId: string, type = 'Transaction.Paid'): string => JSON.stringify({ type, timestamp: '2026-11-09T01:00:00.000Z', data: { storeId: 'store-1', paymentId, transactionId: 'tx-1' } });

function portoneHeaders(h: Harness, body: string, o: { id?: string; ts?: number; key?: Buffer } = {}): Record<string, string> {
  const id = o.id ?? `msg_${randomUUID()}`;
  const ts = o.ts ?? Math.floor(h.clock.now() / 1000);
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${createHmac('sha256', o.key ?? WEBHOOK_KEY).update(`${id}.${ts}.${body}`).digest('base64')}` };
}

const post = (h: Harness, route: 'toss' | 'portone', headers: Record<string, string>, payload: string) => h.svc.http.inject({ method: 'POST', url: `/v1/webhooks/${route}`, headers, payload });

async function metric(h: Harness, pg: string, outcome: string): Promise<number> {
  const line = (await h.svc.metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`payment_webhook_received_total{pg="${pg}",outcome="${outcome}"}`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

const logKinds = (h: Harness, kind: string): Record<string, unknown>[] =>
  h.logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === kind);

describe('P-T17 포트원 웹훅 경로', () => {
  test('P-T17_같은 webhook-id면 시각만 바꾼 재전송이어도 조회 신호는 한 번이다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const row = await seed(h, { pg: 'PORTONE' });
    const body = portoneBody(row.ref);
    const before = await metric(h, 'PORTONE', 'query_signal');
    expect((await post(h, 'portone', portoneHeaders(h, body, { id: 'msg_same' }), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
    // 실행기가 잡아 뒤로 민 것처럼 시각을 밀어 두고 재전송한다
    const pushed = new Date(h.clock.now() + 15_000);
    await admin.pool.query('update payment set next_query_at = $1 where id = $2', [pushed, row.paymentId]);
    const later = Math.floor(h.clock.now() / 1000) + 60;
    expect((await post(h, 'portone', portoneHeaders(h, body, { id: 'msg_same', ts: later }), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(pushed.getTime());
    expect(await receipts()).toEqual([expect.objectContaining({ pg: 'PORTONE', dedup_key: 'PORTONE:msg_same', payment_id: row.paymentId })]);
    expect(await metric(h, 'PORTONE', 'query_signal')).toBe(before + 1);
  });

  test.each<[string, (h: Harness, body: string) => Record<string, string>]>([
    ['틀린 서명', (h, body) => portoneHeaders(h, body, { key: randomBytes(32) })],
    ['서명 머리 없음', (h, body) => Object.fromEntries(Object.entries(portoneHeaders(h, body)).filter(([k]) => k !== 'webhook-signature'))],
    ['5분 넘은 시각', (h, body) => portoneHeaders(h, body, { ts: Math.floor(h.clock.now() / 1000) - 301 })],
  ])('P-T17_%s이면 400이고 아무것도 쓰지 않으며 사유만 로그에 남긴다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.1] [ASVS v5.0.0-16.2.5]', async (_n, headersOf) => {
    const h = await harness();
    const row = await seed(h, { pg: 'PORTONE' });
    const body = portoneBody(row.ref);
    const res = await post(h, 'portone', headersOf(h, body), body);
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(await receipts()).toEqual([]);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
    const lines = logKinds(h, 'payment-webhook-invalid');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: 'portone', pg: 'PORTONE' });
    expect(h.logs.join('\n')).not.toContain(row.ref);
  });

  test('P-T17_지원하지 않는 사건은 200이고 아무것도 쓰지 않는다', async () => {
    const h = await harness();
    const row = await seed(h, { pg: 'PORTONE' });
    const body = portoneBody(row.ref, 'BillingKey.Issued');
    const before = await metric(h, 'PORTONE', 'ignored');
    expect((await post(h, 'portone', portoneHeaders(h, body), body)).statusCode).toBe(200);
    expect(await receipts()).toEqual([]);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
    expect(await metric(h, 'PORTONE', 'ignored')).toBe(before + 1);
  });

  test('P-T17_서명은 받은 원문 바이트로 검증한다(다시 직렬화하면 달라지는 본문도 받는다)', async () => {
    const h = await harness();
    const row = await seed(h, { pg: 'PORTONE' });
    const body = `{ "type" : "Transaction.Paid",\n  "timestamp":"2026-11-09T01:00:00.000Z", "data": {"storeId":"store-1", "paymentId":"${row.ref}", "transactionId":"tx-1", "note":"\\uD55C\\uAE00"} }`;
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);
    expect((await post(h, 'portone', portoneHeaders(h, body), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
    expect(logKinds(h, 'payment-webhook-invalid')).toEqual([]);
  });
});

describe('P-T8 중복과 본문 위조', () => {
  test('P-T8_같은 키의 웹훅 20개가 같은 순간에 와도 수신 기록 하나, 조회 신호 하나다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const row = await seed(h);
    const body = tossBody(row.ref, row.orderId);
    const [signal, duplicate] = [await metric(h, 'SIMULATOR', 'query_signal'), await metric(h, 'SIMULATOR', 'duplicate')];
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(h, 'toss', tossHeaders('wh_burst'), body)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    expect(await receipts()).toHaveLength(1);
    expect(await metric(h, 'SIMULATOR', 'query_signal')).toBe(signal + 1);
    expect(await metric(h, 'SIMULATOR', 'duplicate')).toBe(duplicate + 19);
  });

  test('P-T8_UNKNOWN에 웹훅이 오면 곧바로 조회하고 조회 답으로 승인이 된다', async () => {
    const h = await harness();
    const orderId = newId();
    const auth = await fetch(`${simUrl}/sim/authenticate`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ orderId, amount: 39_000, orderName: '공연 티켓' }) });
    const { paymentKey } = (await auth.json()) as { paymentKey: string };
    expect((await h.simulator.confirm({ orderId, paymentRef: paymentKey, amount: 39_000, idemKey: `confirm-${orderId}` })).outcome).toBe('APPROVED');
    const row = await seed(h, { orderId, ref: paymentKey, amount: 39_000 });
    const hooks = (await (await fetch(`${simUrl}/sim/webhooks?paymentKey=${encodeURIComponent(paymentKey)}`, { headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}` } })).json()) as { headers: Record<string, string>; body: unknown }[];
    const last = hooks.at(-1)!;
    expect((await post(h, 'toss', { 'content-type': 'application/json', ...last.headers }, JSON.stringify(last.body))).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
    const { claimed } = await h.resolver.tick();
    await h.resolver.whenIdle();
    expect(claimed).toBe(1);
    expect(simQueries).toEqual([paymentKey]);
    expect((await ledgerRow(row.paymentId)).status).toBe('APPROVED');
  });

  test('P-T8_위조한 승인 본문은 원장을 바꾸지 못한다(조회 답만 결과를 정한다)', async () => {
    const h = await harness();
    const orderId = newId();
    const auth = await fetch(`${simUrl}/sim/authenticate`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ orderId, amount: 39_000, orderName: '공연 티켓' }) });
    const { paymentKey } = (await auth.json()) as { paymentKey: string };
    const row = await seed(h, { orderId, ref: paymentKey, amount: 39_000 });
    const body = tossBody(paymentKey, orderId, 'DONE');
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    const after = await ledgerRow(row.paymentId);
    expect([after.status, after.approved_at]).toEqual(['UNKNOWN', null]);
    expect([await eventCount(), await outboxCount()]).toEqual([0, 0]);
    await h.resolver.tick();
    await h.resolver.whenIdle();
    expect((await ledgerRow(row.paymentId)).status).toBe('UNKNOWN');
  });

  test('P-T8_UNKNOWN이 아닌 원장은 위조 본문이 와도 그대로이고 조회 신호도 없다', async () => {
    const h = await harness();
    const row = await seed(h, { status: 'ACCEPTED' });
    const before = await metric(h, 'SIMULATOR', 'state_ignored');
    expect((await post(h, 'toss', tossHeaders(), tossBody(row.ref, row.orderId, 'DONE'))).statusCode).toBe(200);
    expect(await ledgerRow(row.paymentId)).toEqual({ status: 'ACCEPTED', next_query_at: null, approved_at: null });
    expect(await metric(h, 'SIMULATOR', 'state_ignored')).toBe(before + 1);
    expect(await receipts()).toEqual([expect.objectContaining({ payment_id: row.paymentId })]);
  });

  test('P-T8_다음 조회가 이미 더 이르면 그대로 둔다', async () => {
    const h = await harness();
    const earlier = h.clock.now() - 5_000;
    const row = await seed(h, { nextQueryAtMs: earlier });
    expect((await post(h, 'toss', tossHeaders(), tossBody(row.ref, row.orderId))).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(earlier);
  });

  test('P-T8_찾은 뒤에 UNKNOWN을 떠난 원장에는 조회 시각을 쓰지 않는다(갱신 문장의 상태 조건)', async () => {
    const h = await harness();
    const row = await seed(h);
    const pushed = h.clock.now() + FAR_FUTURE_MS;
    // 수신 기록을 넣는 순간에 다른 거래가 승인한 것처럼 상태만 바꾼다(찾기와 갱신 사이)
    await admin.pool.query('insert into test_hooks.settle_key values ($1)', ['SIMULATOR:wh_settled']);
    expect((await post(h, 'toss', tossHeaders('wh_settled'), tossBody(row.ref, row.orderId))).statusCode).toBe(200);
    const after = await ledgerRow(row.paymentId);
    expect(after.status).toBe('APPROVED');
    expect(after.next_query_at!.getTime()).toBe(pushed);
  });

  test('P-T8_리뷰 고침 H1: 서명 없는 토스 경로에서 원장을 못 찾으면 수신 기록을 쓰지 않고 지표만 오른다(전송 ID만 바꾼 위조로 표가 늘지 않는다) [ASVS v5.0.0-2.4.1]', async () => {
    const h = await harness();
    const before = await metric(h, 'SIMULATOR', 'ledger_not_found');
    for (let i = 0; i < 3; i += 1) expect((await post(h, 'toss', tossHeaders(`wh_forged_${i}`), tossBody('tsim_none', newId()))).statusCode).toBe(200);
    expect(await receipts()).toEqual([]);
    expect(await metric(h, 'SIMULATOR', 'ledger_not_found')).toBe(before + 3);
  });

  test('P-T8_리뷰 고침 H1: 서명을 본 포트원 경로에서 먼저 온 웹훅은 지금처럼 수신 기록을 남긴다', async () => {
    const h = await harness();
    const before = await metric(h, 'PORTONE', 'ledger_not_found');
    const body = portoneBody(`pay-${newId()}`);
    expect((await post(h, 'portone', portoneHeaders(h, body, { id: 'msg_early' }), body)).statusCode).toBe(200);
    expect(await receipts()).toEqual([expect.objectContaining({ pg: 'PORTONE', dedup_key: 'PORTONE:msg_early', payment_id: null })]);
    expect(await metric(h, 'PORTONE', 'ledger_not_found')).toBe(before + 1);
  });

  test('P-T8_리뷰 고침 M2: 전송 ID만 바꾼 반복 신호는 5초 안에 조회를 늘리지 않고, 5초가 지나면 다시 당긴다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = await harness();
    const jobs = new DrizzleConfirmJobs({ database: jobsDb, clock: h.clock });
    const row = await seed(h);
    const body = tossBody(row.ref, row.orderId);
    const [signal, skipped] = [await metric(h, 'SIMULATOR', 'query_signal'), await metric(h, 'SIMULATOR', 'query_signal_skipped')];
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect(await jobs.claimDueQueries('SIMULATOR', 10)).toHaveLength(1);
    // 잡은 바로 뒤에 다른 전송 ID로 다시 보낸다: 잡기로부터 5초 안이라 시각을 당기지 않는다
    const claimedAt = (await ledgerRow(row.paymentId)).next_query_at!.getTime();
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(claimedAt);
    expect(await jobs.claimDueQueries('SIMULATOR', 10)).toHaveLength(0);
    h.clock.advance(4_999);
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect(await jobs.claimDueQueries('SIMULATOR', 10)).toHaveLength(0);
    h.clock.advance(1);
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect(await jobs.claimDueQueries('SIMULATOR', 10)).toHaveLength(1);
    expect(await metric(h, 'SIMULATOR', 'query_signal')).toBe(signal + 2);
    expect(await metric(h, 'SIMULATOR', 'query_signal_skipped')).toBe(skipped + 2);
  });

  test('P-T8_리뷰 고침 M2: 직전 신호로부터 5초 안이면 잡히기 전이어도 다시 쓰지 않는다', async () => {
    const h = await harness();
    const row = await seed(h);
    const body = tossBody(row.ref, row.orderId);
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    const first = (await ledgerRow(row.paymentId)).next_query_at!.getTime();
    // 실행기 말고 다른 길(재시도 간격 다시 쓰기)이 뒤로 민 것처럼 시각을 밀어 둔다
    await admin.pool.query('update payment set next_query_at = $1 where id = $2', [new Date(first + FAR_FUTURE_MS), row.paymentId]);
    h.clock.advance(4_999);
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(first + FAR_FUTURE_MS);
  });

  test.each<[string, (h: Harness) => Promise<Seeded>, string]>([
    ['다음 조회가 이미 더 이르면', (h) => seed(h, { nextQueryAtMs: h.clock.now() - 1_000 }), 'wh_earlier'],
  ])('P-T8_리뷰 고침: 갱신이 0행이면(%s) query_signal을 올리지 않는다', async (_n, seeded, id) => {
    const h = await harness();
    const row = await seeded(h);
    const [signal, skipped] = [await metric(h, 'SIMULATOR', 'query_signal'), await metric(h, 'SIMULATOR', 'query_signal_skipped')];
    expect((await post(h, 'toss', tossHeaders(id), tossBody(row.ref, row.orderId))).statusCode).toBe(200);
    expect(await metric(h, 'SIMULATOR', 'query_signal')).toBe(signal);
    expect(await metric(h, 'SIMULATOR', 'query_signal_skipped')).toBe(skipped + 1);
  });

  test('P-T8_리뷰 고침: 찾은 뒤에 UNKNOWN을 떠나 갱신이 0행이면 query_signal을 올리지 않는다', async () => {
    const h = await harness();
    const row = await seed(h);
    await admin.pool.query('insert into test_hooks.settle_key values ($1)', ['SIMULATOR:wh_left']);
    const [signal, skipped] = [await metric(h, 'SIMULATOR', 'query_signal'), await metric(h, 'SIMULATOR', 'query_signal_skipped')];
    expect((await post(h, 'toss', tossHeaders('wh_left'), tossBody(row.ref, row.orderId))).statusCode).toBe(200);
    expect(await metric(h, 'SIMULATOR', 'query_signal')).toBe(signal);
    expect(await metric(h, 'SIMULATOR', 'query_signal_skipped')).toBe(skipped + 1);
  });
});

describe('원장 찾기 순서', () => {
  test('P-T8_주문 참조로 먼저 찾는다(같이 온 결제 참조의 다른 원장은 건드리지 않는다)', async () => {
    const h = await harness();
    const a = await seed(h);
    const b = await seed(h);
    expect((await post(h, 'toss', tossHeaders(), tossBody(b.ref, a.orderId))).statusCode).toBe(200);
    expect((await ledgerRow(a.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
    expect((await ledgerRow(b.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
  });

  test.each<[string, (ref: string) => string | undefined]>([
    ['주문 참조가 없으면', () => undefined],
    ['주문 참조가 UUID 모양이 아니면', () => 'not-a-uuid'],
    ['주문 참조로 못 찾으면', () => newId()],
  ])('P-T8_%s 결제 참조로 찾는다', async (_n, orderRefOf) => {
    const h = await harness();
    const row = await seed(h);
    expect((await post(h, 'toss', tossHeaders(), tossBody(row.ref, orderRefOf(row.ref)))).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
  });

  test('P-T16_입금 통보는 주문 ID로 원장을 찾아 신호만 내고 secret을 로그에 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const h = await harness();
    const row = await seed(h);
    const body = JSON.stringify({ createdAt: '2026-11-09T10:00:00.000000', secret: SECRETS.deposit, status: 'DONE', transactionKey: 't', orderId: row.orderId });
    expect((await post(h, 'toss', tossHeaders(), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
    expect(h.logs.join('\n')).not.toContain(SECRETS.deposit);
    expect(JSON.stringify(await receipts())).not.toContain(SECRETS.deposit);
  });
});

describe('P-T30 경로 대조', () => {
  test('P-T30_토스 경로에 포트원 결제 참조가 오면 조회 신호 없이 200이고 SEV2 로그가 남는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-16.3.3]', async () => {
    const h = await harness();
    const row = await seed(h, { pg: 'PORTONE' });
    const before = await metric(h, 'SIMULATOR', 'pg_mismatch');
    expect((await post(h, 'toss', tossHeaders(), tossBody(row.ref))).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
    expect(await receipts()).toEqual([expect.objectContaining({ payment_id: null })]);
    expect(await metric(h, 'SIMULATOR', 'pg_mismatch')).toBe(before + 1);
    expect(logKinds(h, 'payment-webhook-pg-mismatch')).toEqual([expect.objectContaining({ severity: 'SEV3', route: 'toss', ledgerPg: 'PORTONE', orderId: row.orderId })]);
  });

  test('P-T30_포트원 경로에 다른 결제사의 원장 주문이 오면 조회 신호 없이 200이고 SEV2 로그가 남는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-16.3.3]', async () => {
    const h = await harness();
    const row = await seed(h, { pg: 'SIMULATOR' });
    const body = portoneBody(`pay-${row.orderId}`);
    expect((await post(h, 'portone', portoneHeaders(h, body), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
    expect(logKinds(h, 'payment-webhook-pg-mismatch')).toEqual([expect.objectContaining({ severity: 'SEV2', route: 'portone', pg: 'PORTONE', ledgerPg: 'SIMULATOR', orderId: row.orderId })]);
  });
});

describe('한도와 실패', () => {
  test('P-T8_저장이 실패하면 503이고 쓴 것이 없으며, 다시 보내면 조회 신호를 낸다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const row = await seed(h);
    const body = tossBody(row.ref, row.orderId);
    await admin.pool.query('insert into test_hooks.fail_key values ($1)', ['SIMULATOR:wh_fail']);
    const res = await post(h, 'toss', tossHeaders('wh_fail'), body);
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 503 });
    expect(await receipts()).toEqual([]);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now() + FAR_FUTURE_MS);
    const lines = logKinds(h, 'payment-webhook-store-failed');
    expect(lines).toEqual([expect.objectContaining({ route: 'toss', pg: 'SIMULATOR', code: 'P0001' })]);
    expect(lines[0]!.msg).not.toContain(row.ref);
    expect(JSON.stringify(lines)).not.toContain('wh_fail');
    await admin.pool.query('truncate test_hooks.fail_key');
    expect((await post(h, 'toss', tossHeaders('wh_fail'), body)).statusCode).toBe(200);
    expect((await ledgerRow(row.paymentId)).next_query_at!.getTime()).toBe(h.clock.now());
  });

  test('P-T17_본문이 상한을 넘으면 413이고 쓰지 않는다. 상한과 같으면 받는다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.4.1]', async () => {
    const h = await harness();
    const row = await seed(h);
    const base = tossBody(row.ref, row.orderId);
    const padded = (size: number): string => base.replace('"data":', `"pad":"${'x'.repeat(size - base.length - 9)}","data":`);
    const over = padded(WEBHOOK_MAX_BODY_BYTES + 1);
    expect(Buffer.byteLength(over)).toBe(WEBHOOK_MAX_BODY_BYTES + 1);
    expect((await post(h, 'toss', tossHeaders(), over)).statusCode).toBe(413);
    expect(await receipts()).toEqual([]);
    const exact = padded(WEBHOOK_MAX_BODY_BYTES);
    expect(Buffer.byteLength(exact)).toBe(WEBHOOK_MAX_BODY_BYTES);
    expect((await post(h, 'toss', tossHeaders(), exact)).statusCode).toBe(200);
    expect(await receipts()).toHaveLength(1);
  });

  test.each<['toss' | 'portone']>([['toss'], ['portone']])('P-T17_리뷰 고침 M4: %s 경로는 상한을 넘은 본문을 해석하기 전에 413으로 막는다(JSON이 아니어도 400이 아니다) [ASVS v5.0.0-2.4.1]', async (route) => {
    const h = await harness();
    const res = await post(h, route, { 'content-type': 'application/json' }, `{${'x'.repeat(WEBHOOK_MAX_BODY_BYTES)}`);
    expect(res.statusCode).toBe(413);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(await receipts()).toEqual([]);
  });

  test('P-T17_리뷰 고침 M4: 앱 포트의 요청 받기 시한은 5초다(느린 요청이 연결을 오래 쥐지 못한다) [ASVS v5.0.0-2.4.1]', async () => {
    const h = await harness();
    expect(h.svc.http.server.requestTimeout).toBe(5_000);
  });

  test.each<[string, Record<string, string>, string, number]>([
    ['JSON이 아닌 본문', { 'content-type': 'application/json' }, '{', 400],
    ['JSON 밖의 형식', { 'content-type': 'text/plain' }, '{}', 415],
  ])('P-T17_%s은 어댑터까지 오지 않고 플랫폼 해석기가 답한다 [ASVS v5.0.0-2.2.1]', async (_n, headers, payload, status) => {
    const h = await harness();
    expect((await post(h, 'toss', { ...tossHeaders(), ...headers }, payload)).statusCode).toBe(status);
    expect(await receipts()).toEqual([]);
  });

  test('P-T17_플랫폼 본문 상한(1MiB)을 넘어도 413이다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = await harness();
    expect((await post(h, 'toss', tossHeaders(), JSON.stringify({ pad: 'x'.repeat(1_100_000) }))).statusCode).toBe(413);
    expect(await receipts()).toEqual([]);
  });
});

describe('수신 기록 지우기', () => {
  test('P-T17_보관 기한이 지난 행만 묶음으로 지운다', async () => {
    const h = await harness();
    const now = h.clock.now();
    const put = (key: string, at: number) => admin.pool.query('insert into webhook_receipt (pg, dedup_key, payment_id, received_at) values ($1, $2, null, $3)', ['TOSS', key, new Date(at)]);
    await put('old-1', now - WEBHOOK_RECEIPT_RETENTION_MS - 1);
    await put('old-2', now - WEBHOOK_RECEIPT_RETENTION_MS - 1_000);
    await put('old-3', now - WEBHOOK_RECEIPT_RETENTION_MS - 2_000);
    await put('edge', now - WEBHOOK_RECEIPT_RETENTION_MS + 1);
    await put('new', now);
    await expect(deleteExpiredWebhookReceipts(webhookDb, { clock: h.clock, batchSize: 2, ignoreWindow: true, sleep: async () => {} })).resolves.toMatchObject({ deleted: 3, stopped: 'done' });
    expect((await receipts()).map((r) => r.dedup_key)).toEqual(['edge', 'new']);
  });

  test('P-T17_멈춤 신호를 받으면 다음 묶음을 시작하지 않는다', async () => {
    const h = await harness();
    await admin.pool.query('insert into webhook_receipt (pg, dedup_key, payment_id, received_at) values ($1, $2, null, $3)', ['TOSS', 'old', new Date(h.clock.now() - WEBHOOK_RECEIPT_RETENTION_MS - 1)]);
    const stop = new AbortController();
    stop.abort();
    await expect(deleteExpiredWebhookReceipts(webhookDb, { clock: h.clock, signal: stop.signal, ignoreWindow: true })).resolves.toMatchObject({ deleted: 0, stopped: 'aborted' });
    expect(await receipts()).toHaveLength(1);
  });

  // 한국 시각 10:00은 정비 시간(04:00~06:00) 밖, 05:00은 안이다
  const OUTSIDE_WINDOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
  const INSIDE_WINDOW_MS = Date.parse('2026-11-08T20:00:00.000Z');
  const putOld = (key: string, nowMs: number) => admin.pool.query('insert into webhook_receipt (pg, dedup_key, payment_id, received_at) values ($1, $2, null, $3)', ['TOSS', key, new Date(nowMs - WEBHOOK_RECEIPT_RETENTION_MS - 1)]);

  test('P-T17_리뷰 고침 M5: 정비 시간 밖이면 지우지 않고 window로 멈춘다', async () => {
    await putOld('old', OUTSIDE_WINDOW_MS);
    await expect(deleteExpiredWebhookReceipts(webhookDb, { clock: fakeClock({ now: OUTSIDE_WINDOW_MS }) })).resolves.toMatchObject({ deleted: 0, stopped: 'window' });
    expect(await receipts()).toHaveLength(1);
  });

  test('P-T17_리뷰 고침 M5: 지키는 선(복제 지연·CPU)이 멈추라면 그 까닭으로 멈춘다', async () => {
    await putOld('old', INSIDE_WINDOW_MS);
    await expect(deleteExpiredWebhookReceipts(webhookDb, { clock: fakeClock({ now: INSIDE_WINDOW_MS }), guard: async () => '읽기 복제본 지연 1.4초' })).resolves.toMatchObject({ deleted: 0, stopped: 'guard', reason: '읽기 복제본 지연 1.4초' });
    expect(await receipts()).toHaveLength(1);
  });

  test('P-T17_리뷰 고침 M5: 묶음 사이에 0.5초 쉰다', async () => {
    for (const key of ['a', 'b', 'c']) await putOld(key, INSIDE_WINDOW_MS);
    const pauses: number[] = [];
    await deleteExpiredWebhookReceipts(webhookDb, {
      clock: fakeClock({ now: INSIDE_WINDOW_MS }),
      batchSize: 2,
      sleep: async (ms: number) => {
        pauses.push(ms);
      },
    });
    expect(pauses).toEqual([500]);
    expect(await receipts()).toEqual([]);
  });

  test('P-T17_리뷰 고침 M5: 정비 일은 다 못 지우고 멈추면 실패로 남겨 다음에 이어 한다', async () => {
    await putOld('old', INSIDE_WINDOW_MS);
    const task = webhookReceiptsDeleteTask(webhookDb, fakeClock({ now: INSIDE_WINDOW_MS }), { guard: async () => '쓰기 인스턴스 CPU 경보' });
    expect([task.name, task.when]).toEqual(['webhook-receipts-delete', 'window']);
    await expect(task.run()).rejects.toThrow(/guard: 쓰기 인스턴스 CPU 경보/);
  });
});
