// 결제 수단 연결값 통합 시험(P-T50의 시뮬레이터 몫, BUILD_ORDER HOT-145, docs/features/payment.md §2.1 '결제 수단 연결값의 첫 구현').
// 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터(토스·포트원 경로)로 돈다. 실제 결제사 서버는 부르지 않는다.
// ⑤ 취소 사건과 분석 적재 0건은 그 단계가 만들 때 본다(P-T50 표의 몫).
import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { PayRefKeyRing } from '../src/modules/payment/adapters/pay-ref-key-ring.js';
import { PromPaymentMethodRefSignals } from '../src/modules/payment/adapters/prom-payment-method-ref-signals.js';
import {
  DrizzleConfirmJobs,
  type PaymentMethodRefs,
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
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, portoneConfirm, startGrpcStack, tossConfirm, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const KEY = `sim_sk_${randomBytes(16).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const LABEL_KEY = randomBytes(32);
const CARD = { number: '43301234****123*', issuerCode: '61', cardType: '신용' };

const refOf = (value: string): string => `k1.${createHmac('sha256', LABEL_KEY).update(value, 'utf8').digest('base64url')}`;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let app: SimulatorApp;
let url: string;
let stack: GrpcStack;
let metrics: PlatformMetrics;
const logs: string[] = [];
let makeRunner: (refs: PaymentMethodRefs | undefined) => PaymentConfirmRunner;
let makeResolver: (refs: PaymentMethodRefs | undefined) => PaymentUnknownResolver;
const ring = new PayRefKeyRing({ key: LABEL_KEY, version: 1 });

const auth = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const control = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function drive(runner: PaymentConfirmRunner | PaymentUnknownResolver): Promise<void> {
  await runner.tick();
  await runner.whenIdle();
}

type Pg = 'TOSS' | 'PORTONE';
type Instrument = { method?: string; card?: Record<string, unknown> | null };
interface Accepted {
  orderId: string;
  eventId: string;
  amount: number;
}

/** 시뮬레이터 결제창 인증 뒤 pg에 맞는 ConfirmPayment를 넣는다 */
async function accepted(pg: Pg, instrument: Instrument, amount = 39_000): Promise<Accepted> {
  const orderId = newId();
  if (pg === 'TOSS') {
    const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓', ...instrument });
    expect(r.status).toBe(200);
    const { paymentKey } = (await r.json()) as { paymentKey: string };
    const f = tossConfirm({ pg: 'TOSS', orderId, paymentKey, amount, authenticatedAtMs: stack.clock.now() - 1_000 });
    await unary(stack.client, 'ConfirmPayment', f.request);
    return { orderId, eventId: f.eventId, amount };
  }
  const r = await control('POST', '/sim/portone/authenticate', { orderId, amount, orderName: '공연 티켓', ...instrument });
  expect(r.status).toBe(200);
  const { paymentId, paymentToken, txId } = (await r.json()) as { paymentId: string; paymentToken: string; txId: string };
  const f = portoneConfirm({ orderId, amount, authenticatedAtMs: stack.clock.now() - 1_000 });
  await unary(stack.client, 'ConfirmPayment', { ...f.request, portone: { payment_id: paymentId, tx_id: txId, payment_token: paymentToken } });
  return { orderId, eventId: f.eventId, amount };
}

type Row = { payment_method_ref: string | null; card_bin: string | null; status: string };
const rowOf = async (f: Accepted): Promise<Row> => (await admin.pool.query<Row>('select payment_method_ref, card_bin, status from payment where order_id = $1', [f.orderId])).rows[0]!;
const eventsOf = async (f: Accepted): Promise<Record<string, unknown>[]> =>
  (await admin.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by seq', [f.eventId])).rows.map((r) => JSON.parse(r.payload.toString('utf8')) as Record<string, unknown>);

/** 원장·수출 사건·로그 어디에도 가린 번호와 카드 번호 앞자리 묶음이 없다 */
async function expectNoMaskedNumber(f: Accepted, masked: string): Promise<void> {
  const row = (await admin.pool.query('select * from payment where order_id = $1', [f.orderId])).rows[0] as Record<string, unknown>;
  const history = (await ledgerOf(admin, f.orderId)).events;
  const payload = JSON.stringify(await eventsOf(f));
  for (const text of [JSON.stringify(row), JSON.stringify(history), payload, logs.join('\n')]) {
    expect(text).not.toContain(masked);
    expect(text).not.toContain('****');
  }
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'ref-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'ref-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'ref-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'ref-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);

  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  stack = await startGrpcStack({ hot, batch });

  const gateways = new StaticPaymentGateways([
    new TossPaymentGateway({ baseUrl: url, secretKey: KEY, clientKey: 'sim_ck_test_client' }),
    new PortoneGateway({ baseUrl: url, secret: KEY, storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true }),
  ]);
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
  const confirmSignals = new PromPaymentConfirmSignals().register(metrics.registry);
  const unknownSignals = new PromPaymentUnknownSignals().register(metrics.registry);
  const methodRefSignals = new PromPaymentMethodRefSignals().register(metrics.registry);
  makeRunner = (refs) => new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: confirmSignals, clock: stack.clock, podId: `pod-${randomUUID()}`, timer: silent, ...(refs ? { methodRefs: refs } : {}), methodRefSignals });
  makeResolver = (refs) => new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: unknownSignals, clock: stack.clock, timer: silent, ...(refs ? { methodRefs: refs } : {}), methodRefSignals });
}, 180_000);

afterAll(async () => {
  await stack?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job');
  await admin.pool.query('delete from outbox');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
  // 시계가 멈춰 있어 호출 토큰이 다시 차지 않는다. 시험마다 1초 밀어 채운다(포트원은 승인 한 건이 토큰 2개다)
  stack.clock.advance(1_000);
});

describe.each<[Pg, string, string]>([
  ['TOSS', '433012|123|HYUNDAI|CREDIT', '433012|456|HYUNDAI|CREDIT'],
  ['PORTONE', '433012|123|61|CREDIT', '433012|456|61|CREDIT'],
])('P-T50 %s 시뮬레이터 + 승인 실행기', (pg, sameValue, otherValue) => {
  test(`P-T50_${pg}_① 같은 시험 카드로 두 계정이 결제하면 같은 값이고 원장·사건·BatchGet이 일치하며 6자리 BIN을 싣는다 [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-16.2.5]`, async () => {
    const a = await accepted(pg, { card: CARD });
    const b = await accepted(pg, { card: CARD });
    await drive(makeRunner(ring));

    for (const f of [a, b]) {
      const row = await rowOf(f);
      expect(row).toEqual({ status: 'APPROVED', payment_method_ref: refOf(sameValue), card_bin: '433012' });
      const events = await eventsOf(f);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'APPROVED', paymentMethodRef: row.payment_method_ref, cardBin: '433012', refMissing: false });
      const reply = await unary(stack.client, 'BatchGetPayments', { order_ids: [f.orderId] });
      expect((reply.payments as Record<string, unknown>[])[0]).toMatchObject({ order_id: f.orderId, status: 'PAYMENT_STATUS_APPROVED', event_key: events[0]!.eventKey });
      await expectNoMaskedNumber(f, CARD.number);
    }
  });

  test(`P-T50_${pg}_② BIN이 같고 끝자리가 다르면 값이 다르다`, async () => {
    const a = await accepted(pg, { card: CARD });
    const b = await accepted(pg, { card: { ...CARD, number: '43301234****456*' } });
    await drive(makeRunner(ring));
    expect((await rowOf(a)).payment_method_ref).toBe(refOf(sameValue));
    expect((await rowOf(b)).payment_method_ref).toBe(refOf(otherValue));
    expect((await rowOf(a)).payment_method_ref).not.toBe((await rowOf(b)).payment_method_ref);
    expect((await rowOf(b)).card_bin).toBe('433012');
  });

  // 시뮬레이터의 가상계좌는 승인이 아니라 입금 대기다(BUILD_ORDER HOT-151)
  test.each([
    ['계좌이체', 'APPROVED'],
    ['가상계좌', 'AWAITING_DEPOSIT'],
  ])(`P-T50_${pg}_③ %s 결제는 두 칸이 비고 refMissing 거짓이다 [ASVS v5.0.0-2.2.1]`, async (method, status) => {
    const f = await accepted(pg, { method, card: null });
    await drive(makeRunner(ring));
    expect(await rowOf(f)).toEqual({ status, payment_method_ref: null, card_bin: null });
    const [event] = await eventsOf(f);
    expect(event).toMatchObject({ type: status, refMissing: false });
    expect(event).not.toHaveProperty('paymentMethodRef');
    expect(event).not.toHaveProperty('cardBin');
  });

  test(`P-T50_${pg}_⑥ 결과 모름을 조회로 승인 확정하면 조회 답의 카드로 같은 값을 쓰고 RESOLVED에도 싣는다 [ASVS v5.0.0-16.5.3]`, async () => {
    const f = await accepted(pg, { card: CARD });
    expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'drop', applied: true })).status).toBe(204);
    await drive(makeRunner(ring));
    expect(await rowOf(f)).toEqual({ status: 'UNKNOWN', payment_method_ref: null, card_bin: null });

    stack.clock.advance(6_000);
    await drive(makeResolver(ring));

    expect(await rowOf(f)).toEqual({ status: 'APPROVED', payment_method_ref: refOf(sameValue), card_bin: '433012' });
    const events = await eventsOf(f);
    expect(events.map((e) => e.type)).toEqual(['UNKNOWN', 'APPROVED', 'RESOLVED']);
    expect(events[0]).toMatchObject({ refMissing: false });
    expect(events[0]).not.toHaveProperty('paymentMethodRef');
    for (const e of events.slice(1)) expect(e).toMatchObject({ paymentMethodRef: refOf(sameValue), cardBin: '433012', refMissing: false });
    await expectNoMaskedNumber(f, CARD.number);
  });

  test(`P-T50_${pg}_라벨 키가 없으면 결제는 승인되고 두 칸이 비며 refMissing 참이다 [ASVS v5.0.0-16.5.2]`, async () => {
    const f = await accepted(pg, { card: CARD });
    await drive(makeRunner(undefined));
    expect(await rowOf(f)).toEqual({ status: 'APPROVED', payment_method_ref: null, card_bin: null });
    const [event] = await eventsOf(f);
    expect(event).toMatchObject({ type: 'APPROVED', refMissing: true });
    expect(event).not.toHaveProperty('paymentMethodRef');
  });
});

describe('P-T50 포트원 카드 칸의 빠짐', () => {
  test('P-T50_④ bin이 8자리면 cardBin은 앞 6자리이고 issuer가 빠지면 빈 글자로 계산한다', async () => {
    const eight = await accepted('PORTONE', { card: { ...CARD, bin: '43301234' } });
    const noIssuer = await accepted('PORTONE', { card: { ...CARD, issuerCode: null, bin: '433012' } });
    await drive(makeRunner(ring));
    expect(await rowOf(eight)).toEqual({ status: 'APPROVED', payment_method_ref: refOf('433012|123|61|CREDIT'), card_bin: '433012' });
    expect(await rowOf(noIssuer)).toEqual({ status: 'APPROVED', payment_method_ref: refOf('433012|123||CREDIT'), card_bin: '433012' });
  });

  test('P-T50_BIN을 주지 않는 카드는 두 칸이 비고 refMissing 거짓이다', async () => {
    const f = await accepted('PORTONE', { card: { ...CARD, bin: null } });
    await drive(makeRunner(ring));
    expect(await rowOf(f)).toEqual({ status: 'APPROVED', payment_method_ref: null, card_bin: null });
    expect((await eventsOf(f))[0]).toMatchObject({ refMissing: false });
  });

  test('P-T50_가린 번호 모양이 틀리면 결제는 승인되고 두 칸이 비며 refMissing 참이고 지표를 센다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-16.5.2]', async () => {
    const f = await accepted('PORTONE', { card: { ...CARD, number: '1234567812345678', bin: '12345678' } });
    await drive(makeRunner(ring));
    expect(await rowOf(f)).toEqual({ status: 'APPROVED', payment_method_ref: null, card_bin: null });
    expect((await eventsOf(f))[0]).toMatchObject({ refMissing: true });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/inv_ref_missing_total\{[^}]*label="pay"[^}]*reason="CARD_SHAPE"[^}]*\} [1-9]/);
    // 지표·로그에 값이 없다
    expect(logs.join('\n')).not.toContain('1234567812345678');
    expect(text).not.toContain('1234567812345678');
  });
});
