// 시뮬레이터 어댑터 시험: 공통 계약 묶음 + 시뮬레이터에서만 만들 수 있는 응답의 표준 결과(payment §2.1 '공통 결과 코드 정규화'·'분석용 실패 범주').
// 시뮬레이터는 프로세스 안에서 루프백 무작위 포트로 띄우고, 어댑터는 실제 HTTP로 부른다(응답 유실·시간 초과를 네트워크로 만든다).
import { randomBytes, randomUUID } from 'node:crypto';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorPaymentGateway, type SimulatorGatewayOptions } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { pgAdapterContract, type PgContractHarness } from './pg-contract.js';

interface Sim {
  app: SimulatorApp;
  url: string;
  key: string;
  clock: { now(): number; advance(ms: number): void };
  control(method: string, path: string, body?: unknown): Promise<Response>;
  gateway(o?: Partial<SimulatorGatewayOptions>): SimulatorPaymentGateway;
  authenticate(orderId: string, amount: number): Promise<string>;
}

async function startSim(): Promise<Sim> {
  let t = Date.parse('2026-11-02T01:00:00.000Z');
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  // 실행마다 새 시험 키([ASVS v5.0.0-13.3.1])
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    app,
    url,
    key,
    clock,
    control,
    gateway: (o = {}) => new SimulatorPaymentGateway({ baseUrl: url, secretKey: key, clientKey: 'sim_ck_test_client', ...o }),
    async authenticate(orderId, amount) {
      const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓' });
      expect(r.status).toBe(200);
      return ((await r.json()) as { paymentKey: string }).paymentKey;
    },
  };
}

pgAdapterContract('시뮬레이터', async (): Promise<PgContractHarness> => {
  const sim = await startSim();
  const fault = async (f: Record<string, unknown>) => expect((await sim.control('POST', '/sim/faults', { op: 'confirm', times: 1, ...f })).status).toBe(204);
  return {
    gateway: sim.gateway(),
    authenticate: (orderId, amount) => sim.authenticate(orderId, amount),
    declineNextConfirm: () => fault({ kind: 'decline', code: 'REJECT_CARD_PAYMENT' }),
    dropNextConfirmAfterApply: () => fault({ kind: 'drop', applied: true }),
    delayNextConfirm: (ms) => fault({ kind: 'delay', ms }),
    advance: (ms) => sim.clock.advance(ms),
    async lastWebhook(paymentRef) {
      const events = (await (await sim.control('GET', `/sim/webhooks?paymentKey=${paymentRef}`)).json()) as Array<{ headers: Record<string, string>; body: unknown }>;
      const last = events.at(-1)!;
      return { headers: last.headers, body: JSON.stringify(last.body) };
    },
    async approvals(orderId) {
      const text = await (await sim.control('GET', '/sim/ledger')).text();
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { order_ref: string })
        .filter((r) => r.order_ref === orderId).length;
    },
    close: () => sim.app.close(),
  };
});

describe('시뮬레이터 어댑터의 표준 결과', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(async () => {
    await sim.app.close();
  });
  const fault = async (f: Record<string, unknown>) => expect((await sim.control('POST', '/sim/faults', { times: 1, ...f })).status).toBe(204);
  const ready = async (amount = 10_000) => {
    const orderId = randomUUID();
    return { orderId, amount, paymentRef: await sim.authenticate(orderId, amount), idemKey: `confirm-${orderId}` };
  };

  it('능력 플래그(ADR-0029 결정 2)', () => {
    expect(sim.gateway().capabilities()).toEqual({
      serverConfirm: true,
      confirmDeadlineMs: 600_000,
      partialCancel: true,
      webhookSignature: false,
      idempotencyRetentionMs: 15 * 24 * 3_600_000,
      callsPerSecond: 300,
      redirectCheckout: true,
    });
    expect(sim.gateway({ callsPerSecond: 50 }).capabilities().callsPerSecond).toBe(50);
  });

  it('결제창 값은 토스 모양이고 카드만 받는다', () => {
    const g = sim.gateway();
    const orderId = randomUUID();
    const v = g.checkout({ orderId, orderName: '티켓', amount: 1_000 }, { attemptId: randomUUID(), successUrl: 'https://a.example/s', failUrl: 'https://a.example/f' }, 'CARD');
    expect(v).toEqual({ simulator: { clientKey: 'sim_ck_test_client', customerKey: 'ANONYMOUS', orderId, orderName: '티켓', amount: 1_000, successUrl: 'https://a.example/s', failUrl: 'https://a.example/f' } });
    expect(() => g.checkout({ orderId, orderName: '티켓', amount: 1_000 }, { attemptId: 'a', successUrl: 's', failUrl: 'f' }, 'VIRTUAL_ACCOUNT')).toThrow(/카드/);
    expect(() => g.checkout({ orderId, orderName: '티켓', amount: 0 }, { attemptId: 'a', successUrl: 's', failUrl: 'f' }, 'CARD')).toThrow(/금액/);
  });

  it('멱등키는 confirm-{주문 ID}·cancel-{취소 ID} 형식만 받는다(ADR-0029 결정 4)', async () => {
    const g = sim.gateway();
    const r = await ready();
    await expect(g.confirm({ ...r, idemKey: 'confirm-other' })).rejects.toThrow(/멱등키/);
    await expect(g.cancel({ paymentRef: r.paymentRef, amount: 'ALL', reason: '고객 요청', idemKey: 'refund-1' })).rejects.toThrow(/멱등키/);
  });

  it('승인 결과에 승인 시각(KST)과 계산용 카드 정보가 든다', async () => {
    const r = await ready();
    const c = await sim.gateway().confirm(r);
    expect(c).toMatchObject({ outcome: 'APPROVED', paymentRef: r.paymentRef, amount: r.amount, approvedAt: '2026-11-02T10:00:00.000+09:00' });
    expect(c.card).toMatchObject({ issuerCode: '61', cardType: '신용', maskedNumber: expect.stringMatching(/^43301234\*{4}/) });
  });

  it('처리 중 → IN_PROGRESS, 한도 초과 → DECLINED·THROTTLED', async () => {
    const r = await ready();
    await fault({ op: 'confirm', kind: 'in-progress' });
    expect((await sim.gateway().confirm(r)).outcome).toBe('IN_PROGRESS');
    await fault({ op: 'confirm', kind: 'throttle' });
    expect(await sim.gateway().confirm(r)).toMatchObject({ outcome: 'DECLINED', failureCategory: 'THROTTLED', pgCode: 'TOO_MANY_REQUESTS' });
  });

  it('반영하지 않은 결제사 오류 → UNKNOWN, 조회는 READY라 다시 승인할 수 있다', async () => {
    const r = await ready();
    await fault({ op: 'confirm', kind: 'pg-error', applied: false });
    expect((await sim.gateway().confirm(r)).outcome).toBe('UNKNOWN');
    expect(await sim.gateway().query(r.paymentRef)).toMatchObject({ kind: 'FOUND', status: 'READY' });
    expect((await sim.gateway().confirm(r)).outcome).toBe('APPROVED');
  });

  it('읽기 시간 초과 → UNKNOWN, 뒤에 조회하면 APPROVED', async () => {
    const r = await ready();
    await fault({ op: 'confirm', kind: 'delay', ms: 600 });
    expect((await sim.gateway({ readTimeoutMs: 100 }).confirm(r)).outcome).toBe('UNKNOWN');
    await new Promise((res) => setTimeout(res, 700));
    expect(await sim.gateway().query(r.paymentRef)).toMatchObject({ kind: 'FOUND', status: 'APPROVED' });
  });

  it('이미 승인됐는데 금액이 다르면 DECLINED·VALIDATION(ALREADY_APPROVED로 보지 않는다)', async () => {
    const r = await ready();
    await sim.gateway().confirm(r);
    sim.clock.advance(15 * 24 * 3_600_000 + 1);
    expect(await sim.gateway().confirm({ ...r, amount: 9_000 })).toMatchObject({ outcome: 'DECLINED', failureCategory: 'VALIDATION' });
  });

  it('구매자 이탈 → USER_ABORTED, 금액 불일치 → VALIDATION, 키 틀림 → PG_ERROR', async () => {
    const a = await ready();
    await fault({ op: 'confirm', kind: 'decline', code: 'PAY_PROCESS_CANCELED' });
    expect(await sim.gateway().confirm(a)).toMatchObject({ outcome: 'DECLINED', failureCategory: 'USER_ABORTED' });
    const b = await ready();
    expect(await sim.gateway().confirm({ ...b, amount: 1 })).toMatchObject({ outcome: 'DECLINED', failureCategory: 'VALIDATION', pgCode: 'INVALID_REQUEST' });
    const c = await ready();
    expect(await sim.gateway({ secretKey: 'sim_sk_wrong_wrong_wrong_wrong' }).confirm(c)).toMatchObject({ outcome: 'DECLINED', failureCategory: 'PG_ERROR' });
    expect(await sim.gateway().query(c.paymentRef)).toMatchObject({ kind: 'FOUND', status: 'READY' });
  });

  it('조회: 없는 결제 → NOT_FOUND, 결제사 오류·키 틀림 → UNKNOWN', async () => {
    expect(await sim.gateway().query('tsim_none')).toEqual({ kind: 'NOT_FOUND' });
    const r = await ready();
    await fault({ op: 'query', kind: 'pg-error', applied: false });
    expect(await sim.gateway().query(r.paymentRef)).toEqual({ kind: 'UNKNOWN' });
    expect(await sim.gateway({ secretKey: 'sim_sk_wrong_wrong_wrong_wrong' }).query(r.paymentRef)).toEqual({ kind: 'UNKNOWN' });
  });

  it('취소: 승인 전 → REJECTED, 처리 중 → CANCEL_PENDING, 응답 유실 → UNKNOWN, 부분 취소 뒤 다시 부분 취소가 넘치면 REJECTED', async () => {
    const r = await ready();
    const g = sim.gateway();
    expect(await g.cancel({ paymentRef: r.paymentRef, amount: 'ALL', reason: '고객 요청', idemKey: 'cancel-a1' })).toMatchObject({ outcome: 'REJECTED', pgCode: 'NOT_CANCELABLE_PAYMENT' });
    await g.confirm(r);
    await fault({ op: 'cancel', kind: 'in-progress' });
    expect((await g.cancel({ paymentRef: r.paymentRef, amount: 1_000, reason: '고객 요청', idemKey: 'cancel-a2' })).outcome).toBe('CANCEL_PENDING');
    await fault({ op: 'cancel', kind: 'drop', applied: true });
    expect((await g.cancel({ paymentRef: r.paymentRef, amount: 1_000, reason: '고객 요청', idemKey: 'cancel-a3' })).outcome).toBe('UNKNOWN');
    expect(await g.cancel({ paymentRef: r.paymentRef, amount: 1_000, reason: '고객 요청', idemKey: 'cancel-a3' })).toMatchObject({ outcome: 'CANCELLED', balanceAmount: 9_000 });
    expect(await g.cancel({ paymentRef: r.paymentRef, amount: 9_001, reason: '고객 요청', idemKey: 'cancel-a4' })).toMatchObject({ outcome: 'REJECTED', pgCode: 'NOT_CANCELABLE_AMOUNT' });
    expect((await g.cancel({ paymentRef: r.paymentRef, amount: 9_000, reason: '고객 요청', idemKey: 'cancel-a5' })).outcome).toBe('CANCELLED');
    expect(await g.cancel({ paymentRef: r.paymentRef, amount: 1, reason: '고객 요청', idemKey: 'cancel-a6' })).toMatchObject({ outcome: 'REJECTED', pgCode: 'ALREADY_CANCELED_PAYMENT' });
  });

  it('웹훅 해석: 전송 ID가 없거나 본문이 틀리면 null', () => {
    const g = sim.gateway();
    const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-02T10:00:00.000+09:00', data: { paymentKey: 'tsim_1', orderId: 'o-123456', status: 'DONE' } });
    expect(g.parseWebhook({}, body)).toBeNull();
    expect(g.parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_1' }, '{')).toBeNull();
    expect(g.parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_1' }, JSON.stringify({ eventType: 'DEPOSIT_CALLBACK', data: {} }))).toBeNull();
    expect(g.parseWebhook({ 'TossPayments-Webhook-Transmission-Id': 'wh_1' }, body)).toEqual({ dedupKey: 'SIMULATOR:wh_1', paymentRef: 'tsim_1', orderRef: 'o-123456' });
  });
});
