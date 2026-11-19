// 결제 후 일반 취소의 가상계좌 갈래(P-T71 ①~⑥, BUILD_ORDER GAT-090, BAT-420-rest, 시험 담당 l3-b420-test)를 실제 PostgreSQL 18·실제 gRPC 서버·
// 실제 결제사 어댑터(시뮬레이터 토스 모양 SimulatorPaymentGateway, PortoneGateway)·실제 HTTP 시뮬레이터로 돈다. 결제사 HTTP는 받은 본문을 기록하는 fetch로 감싼다.
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(가상계좌였는지·계약·결제 후 일반 취소의 가상계좌 갈래·'구현에서 정한 것' ①~⑤), §11 P-T71.
// 원장 행은 시험이 넣는다(입금 확정까지 간 가상계좌 = 수출 사건 AWAITING_DEPOSIT·APPROVED가 있는 APPROVED 행, 입금 흐름 자체는 payment-deposit.int.test.ts).
// 시뮬레이터 쪽 결제는 인증·승인·입금 HTTP로 실제로 만든다(가상계좌는 입금까지 해 DONE).
// 계좌 글 누설: 시험 계좌번호(110987654321)·예금주(김환불)를 결제 DB의 모든 표 모든 행과 로그에서 찾는다.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, fakeClock, PlatformMetrics } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  CancelConfirmedPayment,
  CancelPayment,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  GetPaymentDetail,
  NoKeyVirtualAccountCipher,
  paymentPackage,
  paymentServiceHandlers,
  PortoneGateway,
  PromPaymentDepositSignals,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type PaymentClient, paymentClient, putPayment, unary } from './support.js';

const NOW = Date.parse('2026-11-19T01:00:00.000Z');
const KEY = `sim_sk_${randomBytes(16).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const AMOUNT = 60_000;
/** 시험 계좌(다른 값과 겹치지 않는 글, 계획 §5). 요청에는 하이픈을 넣어 보내고 결제사 본문에는 숫자만 가야 한다(정본 ②) */
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT_DIGITS = '110987654321';
const HOLDER = '김환불';
const REFUND_ACCOUNT = { bank_code: '88', account_number: ACCOUNT_NO, holder_name: HOLDER };

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let app: SimulatorApp;
let simUrl: string;
let client: PaymentClient | undefined;
let server: { port: number; close(): Promise<void> } | undefined;
let metrics: PlatformMetrics;
const logs: string[] = [];
const clock = fakeClock({ now: NOW });

/** 어댑터가 보낸 HTTP 한 번 */
interface Sent {
  call: string;
  body: unknown;
  status: number | 'dropped';
}
const sent: Sent[] = [];

const basic = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const control = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: basic }): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${simUrl}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> };
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'refund-account-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'refund-account-it-hot' });
  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => clock.now() }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
  simUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const recording: typeof fetch = async (input, init) => {
    const call = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    const raw = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const body: unknown = raw === undefined ? undefined : JSON.parse(raw);
    try {
      const res = await fetch(input, init);
      sent.push({ call, body, status: res.status });
      return res;
    } catch (err) {
      sent.push({ call, body, status: 'dropped' });
      throw err;
    }
  };
  const gateways = new StaticPaymentGateways([
    new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: KEY, clientKey: 'sim_ck_test_client', fetch: recording }),
    new PortoneGateway({ baseUrl: simUrl, secret: KEY, storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true, fetch: recording }),
  ]);
  metrics = new PlatformMetrics('payment-svc');
  const depositSignals = new PromPaymentDepositSignals().register(metrics.registry);
  const jobs = new DrizzleConfirmJobs({ database: hot, clock });
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: hot });
  const confirmed = new CancelConfirmedPayment({ store: jobs, gateways, guards: { of: () => ({ circuitClosed: () => true, tryTakeToken: () => true }) as never }, clock, refundAccountSignals: depositSignals });
  const cancelPayment = new CancelPayment({ execute: async () => Promise.reject(new Error('입금 전 취소 갈래가 아니다')) } as never, confirmed, jobs);
  const getPayment = new GetPaymentDetail({ reader: store, signals: depositSignals, cipher: new NoKeyVirtualAccountCipher(), depositLog: { infoMissing: () => {}, accountUnsaved: () => {}, accountUnopened: () => {} }, depositSignals, clock });
  const logger = createPlatformLogger({
    service: 'payment-svc',
    env: 'local',
    version: 'test',
    clock,
    level: 'debug',
    destination: new Writable({
      write: (chunk, _e, cb) => {
        for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
        cb();
      },
    }),
  });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: paymentPackage().PaymentService.service,
        handlers: paymentServiceHandlers(
          {
            accept: { execute: async () => Promise.reject(new Error('이 시험은 승인 명령을 부르지 않는다')) } as never,
            batchGet: { execute: async () => Promise.reject(new Error('이 시험은 결과 당기기를 부르지 않는다')) } as never,
            getPayment,
            cancelPayment,
          },
          (method, err) => logger.error({ method, err }, 'payment-grpc-failed'),
        ),
      },
    ],
  });
  client = paymentClient(`127.0.0.1:${server.port}`);
}, 180_000);

afterAll(async () => {
  client?.close();
  await server?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_cancel, payment_event, payment_confirm_job');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
  sent.length = 0;
  logs.length = 0;
});

const DEPOSITED = [
  { seq: 1, type: 'AWAITING_DEPOSIT', exported: true },
  { seq: 2, type: 'APPROVED', exported: true },
] as const;

/** 시뮬레이터 토스 모양 결제(가상계좌면 입금까지)와 그에 맞춘 원장 행 */
async function tossPaid(o: { virtual: boolean }): Promise<{ paymentId: string; paymentKey: string; orderId: string }> {
  const orderId = randomUUID();
  const a = await control('POST', '/sim/authenticate', { orderId, amount: AMOUNT, orderName: '공연 티켓', ...(o.virtual ? { method: '가상계좌' } : {}) });
  const paymentKey = a.body.paymentKey as string;
  const confirmed = await control('POST', '/v1/payments/confirm', { paymentKey, orderId, amount: AMOUNT });
  expect(confirmed.body.status).toBe(o.virtual ? 'WAITING_FOR_DEPOSIT' : 'DONE');
  if (o.virtual) expect((await control('POST', `/sim/deposits/${paymentKey}`)).body.status).toBe('DONE');
  const seeded = await putPayment(admin, { status: 'APPROVED', pg: 'SIMULATOR', amount: AMOUNT, approvedAtMs: NOW - 60_000, events: o.virtual ? DEPOSITED : [{ seq: 1, type: 'APPROVED', exported: true }] });
  await admin.pool.query('update payment set pg_payment_ref = $2, order_id = $3 where id = $1', [seeded.paymentId, paymentKey, orderId]);
  return { paymentId: seeded.paymentId, paymentKey, orderId };
}

/** 시뮬레이터 포트원 모양 가상계좌 결제(입금까지)와 원장 행 */
async function portoneVirtualPaid(): Promise<{ paymentId: string; portonePaymentId: string }> {
  const orderId = randomUUID();
  const auth = await control('POST', '/sim/portone/authenticate', { orderId, amount: AMOUNT, orderName: '공연 티켓', method: '가상계좌' });
  expect(auth.status).toBe(200);
  const { paymentId: portonePaymentId, paymentToken, txId } = auth.body as { paymentId: string; paymentToken: string; txId: string };
  const c = await control('POST', `/payments/${portonePaymentId}/confirm`, { paymentToken, totalAmount: AMOUNT, currency: 'KRW', isTest: true }, { authorization: `PortOne ${KEY}`, 'idempotency-key': `"confirm-${orderId}"` });
  expect(c.status).toBe(200);
  expect((await control('POST', `/sim/deposits/${portonePaymentId}`)).body.status).toBe('DONE');
  const seeded = await putPayment(admin, { status: 'APPROVED', pg: 'PORTONE', amount: AMOUNT, approvedAtMs: NOW - 60_000, events: DEPOSITED });
  await admin.pool.query('update payment set pg_payment_ref = $2, pg_tx_id = $3 where id = $1', [seeded.paymentId, portonePaymentId, txId]);
  return { paymentId: seeded.paymentId, portonePaymentId };
}

/** CancelPayment 답의 결과·누적 취소액(remaining_cancellable은 시뮬레이터 토스 모양에서 비어 견주지 않는다) */
const cancel = async (paymentId: string, cancellationId: string, o: { amount?: number; account?: Record<string, string>; attempt?: number } = {}) => {
  const r = await unary(client!, 'CancelPayment', {
    payment_id: paymentId,
    cancellation_id: cancellationId,
    reason: '관객 취소',
    amount: { krw: o.amount ?? 25_000 },
    ...(o.attempt === undefined ? {} : { refund_attempt: o.attempt }),
    ...(o.account ? { refund_account: o.account } : {}),
  });
  return { result: r.result, cancelled_amount: r.cancelled_amount };
};
const ledger = async (paymentId: string) => (await admin.pool.query('select status, cancelled_amount from payment where id = $1', [paymentId])).rows[0] as { status: string; cancelled_amount: number };
const cancelRows = async (paymentId: string) =>
  (await admin.pool.query('select idempotency_key, amount, expected_balance, status from payment_cancel where payment_id = $1 order by created_at', [paymentId])).rows as { idempotency_key: string; amount: number; expected_balance: number; status: string }[];
const eventTypes = async (paymentId: string) => (await admin.pool.query('select type from payment_event where payment_id = $1 order by seq', [paymentId])).rows.map((r) => (r as { type: string }).type);
const simBalance = async (key: string) => Number((await control('GET', `/v1/payments/${key}`)).body.balanceAmount);
const calls = (prefix: string) => sent.filter((s) => s.call.startsWith(prefix));

/** 결제 DB의 모든 공개 표·모든 행을 글로 읽어 계좌 글이 있는지 본다 */
async function leakIn(): Promise<string[]> {
  const tables = (await admin.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map((r) => (r as { table_name: string }).table_name);
  const found: string[] = [];
  for (const t of tables) {
    const rows = (await admin.pool.query(`select t::text as line from "${t}" t`)).rows as { line: string }[];
    for (const r of rows) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (r.line.includes(needle)) found.push(`${t}:${needle}`);
  }
  for (const l of logs) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (l.includes(needle)) found.push(`log:${needle}`);
  return found;
}

const metric = async (pg: string): Promise<number> => {
  const line = (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`payment_cancel_refund_account_ignored_total{pg="${pg}"}`));
  return Number(line?.split(' ').at(-1) ?? Number.NaN);
};

describe('P-T71 결제 후 일반 취소의 가상계좌 갈래 [실제 PostgreSQL·gRPC·어댑터·시뮬레이터]', () => {
  test('P-T71 ① 토스 모양: 계좌를 실은 가상계좌 취소는 결제사 본문 refundReceiveAccount에 그 계좌(숫자만)가 정확히 실리고 25,000원이 한 번 나가며, DB 모든 행·로그에 계좌 글이 없다 [ASVS v5.0.0-14.2.4]', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    const r = await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT });
    expect(r).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 25_000 } });
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`)).toEqual([
      { call: `POST /v1/payments/${p.paymentKey}/cancel`, body: { cancelReason: '관객 취소', cancelAmount: 25_000, refundReceiveAccount: { bank: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER } }, status: 200 },
    ]);
    expect(await simBalance(p.paymentKey)).toBe(35_000);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 25_000 });
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'CANCELED' }]);
    expect(await leakIn()).toEqual([]);
  });

  test('P-T71 ① 포트원: 계좌를 실은 가상계좌 취소는 refundAccount에 bank SHINHAN·number·holderName이 실리고 currentCancellableAmount 60,000과 함께 한 번 나가며 계좌 글이 남지 않는다 [ASVS v5.0.0-14.2.4]', async () => {
    const p = await portoneVirtualPaid();
    const cancellationId = randomUUID();
    const r = await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT });
    expect(r).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 25_000 } });
    expect(calls(`POST /payments/${p.portonePaymentId}/cancel`)).toEqual([
      {
        call: `POST /payments/${p.portonePaymentId}/cancel`,
        body: { storeId: 'store-sim', reason: '관객 취소', amount: 25_000, currentCancellableAmount: 60_000, refundAccount: { bank: 'SHINHAN', number: ACCOUNT_DIGITS, holderName: HOLDER } },
        status: 200,
      },
    ]);
    expect(await simBalance(p.portonePaymentId)).toBe(35_000);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 25_000 });
    expect(await leakIn()).toEqual([]);
  });

  test('P-T71 ② 계좌 없는 가상계좌 취소는 결제사 호출 0·payment_cancel 0행·사건 그대로이고 CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED다(시뮬레이터 잔액 60,000 그대로)', async () => {
    const p = await tossPaid({ virtual: true });
    const before = await eventTypes(p.paymentId);
    const r = await cancel(p.paymentId, randomUUID());
    expect(r).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(sent).toEqual([]);
    expect(await cancelRows(p.paymentId)).toEqual([]);
    expect(await eventTypes(p.paymentId)).toEqual(before);
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
    // 모양이 틀린 계좌(21자리)도 계좌 없음과 같다(정본 ②)
    const bad = await cancel(p.paymentId, randomUUID(), { account: { ...REFUND_ACCOUNT, account_number: '1'.repeat(21) } });
    expect(bad).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(sent.filter((s) => s.call.endsWith('/cancel'))).toEqual([]);
    expect(await cancelRows(p.paymentId)).toEqual([]);
  });

  test('P-T71 ③ 계좌를 실어 보낸 취소가 결제사 커밋 뒤 끊긴 행을 계좌 없이 다시 부르면 결제사 취소 0·조회 1이고, 반영이라 CANCELLED·행 CANCELED·돈은 한 번이다', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'drop', applied: true })).status).toBe(204);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    // 끊김이 실제로 있었고 끊긴 자리는 결제사 커밋 뒤였다
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`).map((s) => s.status)).toEqual(['dropped']);
    expect(await simBalance(p.paymentKey)).toBe(35_000);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'REQUESTED' }]);
    sent.length = 0;

    expect(await cancel(p.paymentId, cancellationId)).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 25_000 } });
    expect(calls('POST ')).toEqual([]);
    expect(calls(`GET /v1/payments/${p.paymentKey}`)).toHaveLength(1);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'CANCELED' }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 25_000 });
    expect(await simBalance(p.paymentKey)).toBe(35_000);
  });

  test('P-T71 ③ 결제사가 반영하기 전에 끊긴 행을 계좌 없이 다시 부르면 결제사 취소 0·조회 1이고 REFUND_ACCOUNT_REQUIRED이며 행은 진행 중(REQUESTED) 그대로다', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'drop', applied: false })).status).toBe(204);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`).map((s) => s.status)).toEqual(['dropped']);
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
    sent.length = 0;

    expect(await cancel(p.paymentId, cancellationId)).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(calls('POST ')).toEqual([]);
    expect(calls(`GET /v1/payments/${p.paymentKey}`)).toHaveLength(1);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'REQUESTED' }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  // BAT-420-rest 리뷰 반영 RV-03(정본 변경 반영, 시험 담당 l3-b420-test): 정본 §6 '구현에서 정한 것' ④가 '같은 취소 ID = 같은 답'으로 바뀌어 다시 부름의 답을 REJECTED에서 REFUND_ACCOUNT_REQUIRED로 고쳤다
  test('P-T71 ④ 결제사가 계좌를 거절하면(000으로 시작하는 계좌번호, INVALID_REFUND_ACCOUNT_NUMBER) 행 FAILED·REFUND_ACCOUNT_REQUIRED이고 돈은 나가지 않으며, 같은 취소 ID를 맞는 계좌로 다시 불러도 결제사 0·같은 답 REFUND_ACCOUNT_REQUIRED다(새 멱등키는 GAT-130)', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    const r = await cancel(p.paymentId, cancellationId, { account: { ...REFUND_ACCOUNT, account_number: '000-987-654321' } });
    expect(r).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`)).toEqual([
      { call: `POST /v1/payments/${p.paymentKey}/cancel`, body: { cancelReason: '관객 취소', cancelAmount: 25_000, refundReceiveAccount: { bank: '88', accountNumber: '000987654321', holderName: HOLDER } }, status: 400 },
    ]);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'FAILED' }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
    sent.length = 0;
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(calls('POST ')).toEqual([]);
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  test('P-T71 ⑤ 카드 결제에 온 계좌는 결제사 본문에 없고 payment_cancel_refund_account_ignored_total{pg="SIMULATOR"}이 1 오르며 취소는 그대로 된다. 계좌 없는 카드 취소는 지표를 올리지 않는다', async () => {
    const p = await tossPaid({ virtual: false });
    const before = await metric('SIMULATOR');
    expect(await cancel(p.paymentId, randomUUID(), { account: REFUND_ACCOUNT, amount: 10_000 })).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 10_000 } });
    const http = calls(`POST /v1/payments/${p.paymentKey}/cancel`);
    expect(http).toHaveLength(1);
    expect(http[0]!.body).toEqual({ cancelReason: '관객 취소', cancelAmount: 10_000 });
    expect(await metric('SIMULATOR')).toBe(before + 1);
    expect(await cancel(p.paymentId, randomUUID(), { amount: 10_000 })).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 20_000 } });
    expect(await metric('SIMULATOR')).toBe(before + 1);
    expect(await simBalance(p.paymentKey)).toBe(40_000);
    expect(await leakIn()).toEqual([]);
  });

  test('P-T71 ⑥ GetPayment virtual_account_paid: 입금 확정 뒤 참, 부분 취소 뒤에도 참, 카드·입금 기한이 지나 끝난 결제(FAILED)·입금 대기는 거짓이다', async () => {
    const va = await tossPaid({ virtual: true });
    const card = await tossPaid({ virtual: false });
    const get = async (orderId: string) => unary(client!, 'GetPayment', { order_id: orderId });
    expect(await get(va.orderId)).toMatchObject({ virtual_account_paid: true, status: 'PAYMENT_STATUS_APPROVED' });
    expect(await get(card.orderId)).toMatchObject({ virtual_account_paid: false });
    await cancel(va.paymentId, randomUUID(), { account: REFUND_ACCOUNT });
    expect(await get(va.orderId)).toMatchObject({ virtual_account_paid: true, status: 'PAYMENT_STATUS_PARTIAL_CANCELED' });
    const expired = await putPayment(admin, {
      status: 'FAILED',
      pg: 'SIMULATOR',
      amount: AMOUNT,
      events: [
        { seq: 1, type: 'AWAITING_DEPOSIT', exported: true },
        { seq: 2, type: 'FAILED', exported: true },
      ],
    });
    expect(await get(expired.orderId)).toMatchObject({ virtual_account_paid: false });
    const awaiting = await putPayment(admin, { status: 'AWAITING_DEPOSIT', pg: 'SIMULATOR', amount: AMOUNT, events: [{ seq: 1, type: 'AWAITING_DEPOSIT', exported: true }] });
    expect(await get(awaiting.orderId)).toMatchObject({ virtual_account_paid: false });
  });
});

// BAT-420-rest 리뷰 반영 RV-02·RV-03·RV-04 재현(P-T73 ①②③, P-T74 ③, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/payment.md §6 '구현에서 정한 것' ②(포트원 대응표 밖 코드는 행을 만들기 전에 모양이 틀린 계좌와 같다)·④(같은 취소 ID = 같은 답, fail_reason)·⑥(같은 멱등키에는 첫 본문만, 멱등키 재사용 답은 UNKNOWN), §11 P-T73·P-T74.
describe('P-T73·P-T74 같은 취소 ID의 다시 부름과 계좌 [실제 PostgreSQL·gRPC·어댑터·시뮬레이터]', () => {
  const failReason = async (paymentId: string) => (await admin.pool.query('select status, fail_reason from payment_cancel where payment_id = $1', [paymentId])).rows as { status: string; fail_reason: string | null }[];

  test('P-T73 ① 계좌를 실어 보낸 취소가 결과 모름(결제사 반영 전에 끊김)으로 진행 중일 때 다른 계좌(예금주 김결제·김 결제)로 다시 부르면 결제사 취소 0·조회 1이고 결제사 기록의 본문은 첫 본문 하나뿐이다', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'drop', applied: false })).status).toBe(204);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    const first = calls(`POST /v1/payments/${p.paymentKey}/cancel`);
    expect(first.map((s) => s.status)).toEqual(['dropped']);
    for (const holder_name of ['김결제', '김 결제']) {
      sent.length = 0;
      const r = await cancel(p.paymentId, cancellationId, { account: { bank_code: '88', account_number: '220-111-222333', holder_name } });
      expect(r, holder_name).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
      expect(calls('POST '), holder_name).toEqual([]);
      expect(calls(`GET /v1/payments/${p.paymentKey}`), holder_name).toHaveLength(1);
    }
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'REQUESTED' }]);
    // 결제사(시뮬레이터) 쪽에는 첫 본문만 닿았다: 다른 계좌 본문이 멱등키 재사용으로 걸린 적이 없고 잔액도 그대로다
    expect(first[0]!.body).toMatchObject({ refundReceiveAccount: { bank: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER } });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  test('P-T76 ② 계좌를 실은 시도(1)가 결과 모름으로 남은 뒤 계좌 없이 같은 시도를 다시 부르면 새 전송 0·조회 1로 정산하고 이중 환급이 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    // 결제사 커밋 뒤 끊김: 돈은 나갔고 payment_cancel은 REQUESTED(시도 1)로 남는다
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'drop', applied: true })).status).toBe(204);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT, attempt: 1 })).toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`).map((s) => s.status)).toEqual(['dropped']);
    expect(await simBalance(p.paymentKey)).toBe(35_000);
    const before = await admin.pool.query<{ idempotency_key: string; amount: number; expected_balance: number; status: string; attempt: number }>(
      'select idempotency_key, amount, expected_balance, status, attempt from payment_cancel where payment_id = $1',
      [p.paymentId],
    );
    expect(before.rows).toEqual([{ idempotency_key: `cancel-${cancellationId}-a1`, amount: 25_000, expected_balance: 60_000, status: 'REQUESTED', attempt: 1 }]);
    sent.length = 0;

    // RV-01(높음): purchase의 재시도는 계좌를 저장하지 않아 계좌 없이 온다. 같은 시도의 행이 있으면 거절이 아니라 조회로 정산해야 한다
    expect(await cancel(p.paymentId, cancellationId, { attempt: 1 })).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 25_000 } });
    expect(calls('POST ')).toEqual([]);
    expect(calls(`GET /v1/payments/${p.paymentKey}`)).toHaveLength(1);
    const after = await admin.pool.query<{ status: string; attempt: number }>('select status, attempt from payment_cancel where payment_id = $1', [p.paymentId]);
    expect(after.rows).toEqual([{ status: 'CANCELED', attempt: 1 }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 25_000 });
    // 새 전송이 없었으므로 돈은 첫 시도 한 번만 나갔다(이중 환급 0)
    expect(await simBalance(p.paymentKey)).toBe(35_000);
  });

  // RV-21(높음): a1이 CANCEL_PENDING으로 남은 뒤 같은 시도(a1)를 계좌 없이 다시 부르고 조회가 아직 '반영 아님'이면,
  // 지금은 REFUND_ACCOUNT_REQUIRED(422)라 purchase가 계좌 대기로 멈춘다. 같은 시도의 재시도는 202 대기(CANCEL_PENDING·UNKNOWN)여야
  // 재시도 루프가 a1을 계속 조회한다(ADR-0316 결정 4, B9). 새 전송 0·조회 1·행 CANCEL_PENDING 그대로다.
  test('P-T76 ②_RV21_CANCEL_PENDING인_같은_시도의_재시도_조회가_반영_아니면_계좌_요구가_아니라_대기이고_새_전송_0이다', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    const idemKey = `cancel-${cancellationId}-a1`;
    await admin.pool.query(
      `insert into payment_cancel (id, payment_id, idempotency_key, attempt, amount, reason, full_cancel, expected_balance, status, created_at)
       values ($1, $2, $3, 1, 25000, '관객 취소', false, 60000, 'CANCEL_PENDING', $4)`,
      [randomUUID(), p.paymentId, idemKey, new Date(NOW)],
    );
    sent.length = 0;
    const answer = await cancel(p.paymentId, cancellationId, { attempt: 1 });
    expect(answer.result).not.toBe('CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED');
    expect(['CANCEL_RESULT_CANCEL_PENDING', 'CANCEL_RESULT_UNKNOWN']).toContain(answer.result);
    // 새 전송 0, 조회 1
    expect(calls('POST ')).toEqual([]);
    expect(calls(`GET /v1/payments/${p.paymentKey}`)).toHaveLength(1);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: idemKey, amount: 25_000, expected_balance: 60_000, status: 'CANCEL_PENDING' }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  test('P-T73 ② 결제사가 멱등키 재사용(IDEMPOTENCY_KEY_REUSED)으로 답하면 UNKNOWN이고 행은 진행 중(REQUESTED) 그대로다(FAILED 아님)', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    // 같은 멱등키(cancel-{취소 ID})에 다른 본문을 먼저 남긴다(계좌 없는 가상계좌 취소라 돈은 나가지 않고 400이 저장된다)
    const earlier = await control('POST', `/v1/payments/${p.paymentKey}/cancel`, { cancelReason: '다른 본문', cancelAmount: 1_000 }, { authorization: basic, 'idempotency-key': `cancel-${cancellationId}` });
    expect(earlier.status).toBe(400);
    const r = await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT });
    expect(r).toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    // 장애 주입이 끼어들었다: 결제사가 멱등키 재사용으로 답했다
    expect(calls(`POST /v1/payments/${p.paymentKey}/cancel`).map((s) => s.status)).toEqual([422]);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 25_000, expected_balance: 60_000, status: 'REQUESTED' }]);
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  test('P-T73 ③ 계좌 거절로 끝난 행은 fail_reason REFUND_ACCOUNT_INVALID이고, 같은 취소 ID를 맞는 계좌로 다시 부르면 결제사 0·REFUND_ACCOUNT_REQUIRED다(같은 취소 ID = 같은 답)', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    expect(await cancel(p.paymentId, cancellationId, { account: { ...REFUND_ACCOUNT, account_number: '000-987-654321' } })).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(await failReason(p.paymentId)).toEqual([{ status: 'FAILED', fail_reason: 'REFUND_ACCOUNT_INVALID' }]);
    sent.length = 0;
    for (const account of [REFUND_ACCOUNT, undefined]) {
      const again = await cancel(p.paymentId, cancellationId, account ? { account } : {});
      expect(again, account ? '계좌 있음' : '계좌 없음').toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    }
    expect(calls('POST ')).toEqual([]);
    expect(await simBalance(p.paymentKey)).toBe(AMOUNT);
  });

  test('P-T73 ③ 대조: 다른 업무 거절(NOT_CANCELABLE_PAYMENT)로 끝난 행은 REJECTED·fail_reason 빔이고 다시 불러도 REJECTED·결제사 0이다', async () => {
    const p = await tossPaid({ virtual: true });
    const cancellationId = randomUUID();
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'decline', code: 'NOT_CANCELABLE_PAYMENT' })).status).toBe(204);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    expect(await failReason(p.paymentId)).toEqual([{ status: 'FAILED', fail_reason: null }]);
    sent.length = 0;
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    expect(calls('POST ')).toEqual([]);
  });

  test('P-T74 ③ 포트원 대응표에 없는 은행 코드(04)는 payment_cancel 0행·결제사 0·REFUND_ACCOUNT_REQUIRED이고, 같은 취소 ID를 대응표에 있는 코드(88)로 다시 부르면 결제사로 간다', async () => {
    const p = await portoneVirtualPaid();
    const cancellationId = randomUUID();
    expect(await cancel(p.paymentId, cancellationId, { account: { ...REFUND_ACCOUNT, bank_code: '04' } })).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
    expect(await cancelRows(p.paymentId)).toEqual([]);
    expect(calls(`POST /payments/${p.portonePaymentId}/cancel`)).toEqual([]);
    expect(await cancel(p.paymentId, cancellationId, { account: REFUND_ACCOUNT })).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 25_000 } });
    expect(calls(`POST /payments/${p.portonePaymentId}/cancel`)).toHaveLength(1);
    expect(await simBalance(p.portonePaymentId)).toBe(35_000);
  });
});
