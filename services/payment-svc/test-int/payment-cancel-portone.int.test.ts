// 결제 후 일반 취소를 실제 포트원 어댑터(PortoneGateway)와 실제 HTTP 시뮬레이터(포트원 경로)로 돈다(BUILD_ORDER GAT-080, HOT-140이 넘긴 것, BAT-415 몫 P6).
// 정본: docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', §2.1 포트원 결제 취소(currentCancellableAmount). 실제 포트원 서버는 부르지 않는다.
// 장애 주입: 시뮬레이터가 취소를 커밋한 뒤 응답을 끊는다({ op: 'cancel', kind: 'drop', applied: true, times: 1 }). 재시도가 같은 본문이면
// 시뮬레이터가 저장한 첫 답을 돌려주고(같은 멱등키·다른 본문이면 422 IDEMPOTENCY_KEY_REUSED), 돈은 한 번만 나간다.
// 결제 원장 행은 시험이 넣는다(승인 경로는 portone-gateway.int.test.ts가 본다). 시뮬레이터 쪽 결제는 인증·승인 HTTP를 직접 불러 만든다.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, type Database, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { CancelConfirmedPayment, DrizzleConfirmJobs, PortoneGateway, StaticPaymentGateways } from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { newId, putPayment } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-16T01:00:00.000Z');
const KEY = `sim_sk_${randomBytes(16).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let app: SimulatorApp;
let url: string;
let uc: CancelConfirmedPayment;
const clock = fakeClock({ now: SIM_NOW_MS });

/** 어댑터가 보낸 HTTP 한 번: 경로, 본문, 답의 상태(끊기면 dropped), 오류 type */
interface Sent {
  path: string;
  body: unknown;
  status: number | 'dropped';
  type?: string;
}
const sent: Sent[] = [];

const basic = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const control = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${url}${path}`, { method, headers: { authorization: basic, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 시뮬레이터가 들고 있는 그 결제(토스 모양 조회: 취소 목록 cancels와 남은 금액 balanceAmount) */
const simPayment = async (paymentKey: string): Promise<{ balanceAmount: number; cancels: { cancelAmount: number }[] | null }> => {
  const r = await control('GET', `/v1/payments/${paymentKey}`);
  expect(r.status).toBe(200);
  return (await r.json()) as { balanceAmount: number; cancels: { cancelAmount: number }[] | null };
};

/** 시뮬레이터에서 인증·승인한 포트원 결제와 그에 맞춘 원장 행(APPROVED) */
async function paid(amount: number): Promise<{ paymentId: string; portonePaymentId: string; orderId: string }> {
  const orderId = newId();
  const auth = await control('POST', '/sim/portone/authenticate', { orderId, amount, orderName: '공연 티켓' });
  expect(auth.status).toBe(200);
  const { paymentId: portonePaymentId, paymentToken, txId } = (await auth.json()) as { paymentId: string; paymentToken: string; txId: string };
  const confirmed = await fetch(`${url}/payments/${portonePaymentId}/confirm`, {
    method: 'POST',
    headers: { authorization: `PortOne ${KEY}`, 'content-type': 'application/json', 'idempotency-key': `"confirm-${orderId}"` },
    body: JSON.stringify({ paymentToken, totalAmount: amount, currency: 'KRW', isTest: true }),
  });
  expect(confirmed.status).toBe(200);
  const seeded = await putPayment(admin, { status: 'APPROVED', pg: 'PORTONE', amount });
  await admin.pool.query('update payment set pg_payment_ref = $2, pg_tx_id = $3 where id = $1', [seeded.paymentId, portonePaymentId, txId]);
  return { paymentId: seeded.paymentId, portonePaymentId, orderId };
}

const ledger = async (paymentId: string) => (await admin.pool.query('select status, cancelled_amount from payment where id = $1', [paymentId])).rows[0] as { status: string; cancelled_amount: number };
const cancelRows = async (paymentId: string) =>
  (await admin.pool.query('select idempotency_key, amount, expected_balance, status from payment_cancel where payment_id = $1 order by created_at', [paymentId])).rows as {
    idempotency_key: string;
    amount: number;
    expected_balance: number;
    status: string;
  }[];
const cancelHttp = (portonePaymentId: string): Sent[] => sent.filter((s) => s.path === `POST /payments/${portonePaymentId}/cancel`);

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'cancel-portone-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'cancel-portone-it-hot' });
  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
  url = await app.listen({ host: '127.0.0.1', port: 0 });

  const recording: typeof fetch = async (input, init) => {
    const path = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    const raw = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const body: unknown = raw === undefined ? undefined : JSON.parse(raw);
    try {
      const res = await fetch(input, init);
      let type: string | undefined;
      try {
        type = (JSON.parse(await res.clone().text()) as { type?: string }).type;
      } catch {
        type = undefined;
      }
      sent.push({ path, body, status: res.status, ...(type === undefined ? {} : { type }) });
      return res;
    } catch (err) {
      sent.push({ path, body, status: 'dropped' });
      throw err;
    }
  };
  const gateway = new PortoneGateway({ baseUrl: url, secret: KEY, storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [WEBHOOK_SECRET], isTest: true, fetch: recording });
  uc = new CancelConfirmedPayment({
    store: new DrizzleConfirmJobs({ database: hot, clock }),
    gateways: new StaticPaymentGateways([gateway]),
    guards: { of: () => ({ circuitClosed: () => true, tryTakeToken: () => true }) as never },
    clock,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
  sent.length = 0;
});

describe('GAT-080 P6 포트원 취소 응답이 끊긴 뒤의 재시도', () => {
  test('GAT-080 P6 결제사가 취소를 커밋한 뒤 응답을 끊어도 재시도는 같은 본문(기대 잔액 포함)이라 한 번만 환급된다', async () => {
    // 취소 ID는 운영처럼 UUID다(포트원 멱등키 cancel-{취소 ID}는 보이는 ASCII 16~256자여야 한다)
    const drop = randomUUID();
    const p = await paid(50_000);
    expect((await control('POST', '/sim/faults', { op: 'cancel', times: 1, orderId: p.orderId, kind: 'drop', applied: true })).status).toBe(204);

    const first = await uc.execute({ paymentId: p.paymentId, cancellationId: drop, reason: '관객 취소', amount: 20_000 });
    expect(first).toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    // 끊김이 실제로 있었고, 끊긴 자리는 시뮬레이터의 커밋 뒤였다(잔액이 이미 줄었다)
    expect(cancelHttp(p.portonePaymentId)).toEqual([
      { path: `POST /payments/${p.portonePaymentId}/cancel`, body: { storeId: 'store-sim', reason: '관객 취소', amount: 20_000, currentCancellableAmount: 50_000 }, status: 'dropped' },
    ]);
    expect(await simPayment(p.portonePaymentId)).toMatchObject({ balanceAmount: 30_000 });
    expect(await ledger(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });

    const second = await uc.execute({ paymentId: p.paymentId, cancellationId: drop, reason: '관객 취소', amount: 20_000 });
    expect(second).toEqual({ result: 'CANCELLED', cancelledAmount: 20_000 });
    const http = cancelHttp(p.portonePaymentId);
    expect(http).toHaveLength(2);
    expect(http[1]!.body).toEqual(http[0]!.body);
    expect(http[1]!.status).toBe(200);
    expect(sent.some((s) => s.type === 'IDEMPOTENCY_KEY_REUSED')).toBe(false);

    const sim = await simPayment(p.portonePaymentId);
    expect(sim.balanceAmount).toBe(30_000);
    expect(sim.cancels).toHaveLength(1);
    expect(sim.cancels![0]!.cancelAmount).toBe(20_000);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: `cancel-${drop}`, amount: 20_000, expected_balance: 50_000, status: 'CANCELED' }]);
  });

  test('GAT-080 P6 대조: 두 취소를 차례로 하면 둘째의 currentCancellableAmount는 첫째 반영 뒤 잔액(50,000 − 10,000 = 40,000)이다', async () => {
    const [seq1, seq2] = [randomUUID(), randomUUID()];
    const p = await paid(50_000);
    await expect(uc.execute({ paymentId: p.paymentId, cancellationId: seq1, reason: '관객 취소', amount: 10_000 })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 10_000 });
    await expect(uc.execute({ paymentId: p.paymentId, cancellationId: seq2, reason: '관객 취소', amount: 15_000 })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 25_000 });
    expect(cancelHttp(p.portonePaymentId).map((s) => [s.body, s.status])).toEqual([
      [{ storeId: 'store-sim', reason: '관객 취소', amount: 10_000, currentCancellableAmount: 50_000 }, 200],
      [{ storeId: 'store-sim', reason: '관객 취소', amount: 15_000, currentCancellableAmount: 40_000 }, 200],
    ]);
    expect((await simPayment(p.portonePaymentId)).balanceAmount).toBe(25_000);
    expect(await ledger(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 25_000 });
  });
});
