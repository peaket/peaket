// 시뮬레이터 어댑터 시험: 공통 계약 묶음 + 시뮬레이터에서만 만들 수 있는 응답의 표준 결과(payment §2.1 '공통 결과 코드 정규화'·'분석용 실패 범주').
// 시뮬레이터는 프로세스 안에서 루프백 무작위 포트로 띄우고, 어댑터는 실제 HTTP로 부른다(응답 유실·시간 초과를 네트워크로 만든다).
import { randomBytes, randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorPaymentGateway, type SimulatorGatewayOptions } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { CONFIRM_LEASE_MS } from '../src/modules/payment/domain/confirm-runner.js';
import { CONFIRM_CALL_BUDGET_MS } from '../src/modules/payment/domain/payment-gateway.js';
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

  it('PRF181_승인 결과에 결제 수단 분류가 든다(시뮬레이터 method 카드 → CARD, 사건의 payMethodCategory)', async () => {
    const r = await ready();
    expect((await sim.gateway().confirm(r)).method).toBe('CARD');
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

  it('PRF181_리뷰 고침 H1: 이미 승인됐는데 금액이 다르면 거절이 아니라 조회 금액을 실은 ALREADY_APPROVED다(실행기가 UNKNOWN + SEV1을 쓴다) [ASVS v5.0.0-2.2.3]', async () => {
    const r = await ready();
    await sim.gateway().confirm(r);
    sim.clock.advance(15 * 24 * 3_600_000 + 1);
    const c = await sim.gateway().confirm({ ...r, amount: 9_000 });
    expect(c).toMatchObject({ outcome: 'ALREADY_APPROVED', amount: r.amount });
    expect(c.failureCategory).toBeUndefined();
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

describe('리뷰 고침(BUILD_ORDER PRF-181, 코드 리뷰): 시뮬레이터가 만들 수 없는 답', () => {
  const C = { orderId: 'order-review-1', paymentRef: 'tsim_review', amount: 10_000, idemKey: 'confirm-order-review-1' };
  const UNKNOWN = { outcome: 'UNKNOWN', paymentRef: C.paymentRef };
  type Scripted = { status: number; body?: unknown; raw?: string };
  const already: Scripted = { status: 400, body: { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제입니다' } };
  const payment = (over: Record<string, unknown> = {}): Scripted => ({ status: 200, body: { status: 'DONE', orderId: C.orderId, totalAmount: C.amount, approvedAt: '2026-11-02T10:00:00.000+09:00', ...over } });
  const responseOf = (s: Scripted): Response => new Response(s.raw ?? (s.body === undefined ? null : JSON.stringify(s.body)), { status: s.status });

  /** 정해 둔 답을 차례대로 주는 어댑터. calls는 보낸 '메서드 경로'다 */
  function scripted(replies: Scripted[], o: Partial<SimulatorGatewayOptions> = {}) {
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      const next = replies.shift();
      if (!next) throw new Error('답을 더 정하지 않았다');
      return responseOf(next);
    };
    return { calls, gateway: new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_review', clientKey: 'sim_ck_review', fetch: fetchStub, ...o }) };
  }

  it.each(['DONE', 'PARTIAL_CANCELED'])('PRF181_리뷰 고침 H1: 조회가 %s인데 금액이 다르면 조회 금액을 실어 ALREADY_APPROVED다 [ASVS v5.0.0-2.2.3]', async (status) => {
    const { gateway } = scripted([already, payment({ status, totalAmount: 9_000 })]);
    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', paymentRef: C.paymentRef, amount: 9_000 });
  });

  it('PRF181_리뷰 고침 H1: 승인 상태인데 조회에 금액이 없으면 금액 없는 ALREADY_APPROVED다(실행기가 UNKNOWN + SEV1을 쓴다) [ASVS v5.0.0-2.2.3]', async () => {
    const { gateway } = scripted([already, payment({ totalAmount: undefined })]);
    const c = await gateway.confirm(C);
    expect(c.outcome).toBe('ALREADY_APPROVED');
    expect(c.amount).toBeUndefined();
  });

  it.each(['IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'READY', 'CANCELED', 'ABORTED', 'EXPIRED', 'SOMETHING_NEW', undefined])('PRF181_리뷰 고침 H1: 조회가 %s이면 결과를 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    const { gateway } = scripted([already, payment({ status })]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('PRF181_리뷰 고침 H1: 승인 상태라도 조회의 주문 ID가 다르면 UNKNOWN이다(금액을 믿을 수 없다) [ASVS v5.0.0-2.2.3]', async () => {
    const { gateway } = scripted([already, payment({ orderId: 'order-other', totalAmount: 9_000 })]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it.each<[string, Scripted]>([
    ['201 승인 모양', { status: 201, body: { status: 'DONE', orderId: C.orderId, totalAmount: C.amount } }],
    ['202', { status: 202, body: { code: 'ACCEPTED' } }],
    ['204 빈 답', { status: 204 }],
    ['301', { status: 301, raw: '' }],
    ['302 JSON code', { status: 302, body: { code: 'MOVED' } }],
    ['304', { status: 304 }],
    ['408 JSON code', { status: 408, body: { code: 'REQUEST_TIMEOUT' } }],
    ['400 HTML', { status: 400, raw: '<html>bad gateway</html>' }],
    ['401 HTML', { status: 401, raw: '<html>no</html>' }],
    ['403 빈 답', { status: 403, raw: '' }],
    ['404 JSON인데 code 없음', { status: 404, body: { message: '없음' } }],
    ['409 HTML', { status: 409, raw: 'conflict' }],
    ['400 JSON 배열', { status: 400, body: [{ code: 'REJECT_CARD_PAYMENT' }] }],
    ['400 code 빈 글', { status: 400, body: { code: '' } }],
    ['400 code가 글이 아님', { status: 400, body: { code: 42 } }],
  ])('PRF181_리뷰 고침 H2: %s는 거절로 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_name, reply) => {
    const { gateway } = scripted([reply]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('PRF181_리뷰 고침 H2: JSON code가 있는 4xx는 그대로 대응표대로다', async () => {
    const declined = (status: number, code: string) => scripted([{ status, body: { code, message: 'x' } }]).gateway.confirm(C);
    await expect(declined(403, 'REJECT_CARD_PAYMENT')).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'PG_ERROR', pgCode: 'REJECT_CARD_PAYMENT' });
    await expect(declined(400, 'REJECT_CARD_PAYMENT')).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'CARD_DECLINED' });
    await expect(declined(429, 'TOO_MANY_REQUESTS')).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'THROTTLED' });
    await expect(declined(409, 'IDEMPOTENT_REQUEST_PROCESSING')).resolves.toMatchObject({ outcome: 'IN_PROGRESS' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['다른 주문 ID', { orderId: 'order-other' }],
    ['주문 ID 없음', { orderId: undefined }],
    ['입금 대기인데 다른 주문 ID', { status: 'WAITING_FOR_DEPOSIT', orderId: 'order-other' }],
  ])('PRF181_리뷰 고침 L12: 200 답이 %s이면 UNKNOWN이다 [ASVS v5.0.0-2.2.3]', async (_name, over) => {
    const { gateway } = scripted([payment(over)]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('PRF181_리뷰 고침 L12: 200 답의 주문 ID가 같으면 그대로 승인이다', async () => {
    const { gateway } = scripted([payment()]);
    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'APPROVED', amount: C.amount });
  });

  it('PRF181_리뷰 고침 L7: 승인 + 조회의 시간 합 상한은 임대보다 짧고 읽기 시간 초과보다 길다 [가정]', () => {
    expect(CONFIRM_CALL_BUDGET_MS).toBeLessThan(CONFIRM_LEASE_MS);
    expect(CONFIRM_CALL_BUDGET_MS).toBeGreaterThan(60_000);
  });

  it('PRF181_리뷰 고침 L7: 뒤따르는 조회는 승인에 쓴 시간을 뺀 남은 몫까지만 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        await new Promise((r) => setTimeout(r, 120));
        return responseOf(already);
      }
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    };
    const gateway = new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_review', clientKey: 'sim_ck_review', fetch: fetchStub, readTimeoutMs: 3_000, confirmBudgetMs: 300 });
    const started = performance.now();
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('PRF181_리뷰 고침 L7: 승인에 몫을 다 썼으면 조회를 보내지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-09T00:00:00.000Z') });
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      calls.push(String(init?.method));
      clock.advance(CONFIRM_CALL_BUDGET_MS);
      return responseOf(already);
    };
    const gateway = new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_review', clientKey: 'sim_ck_review', fetch: fetchStub, clock });
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    expect(calls).toEqual(['POST']);
  });

  it.each<[string, Scripted]>([
    ['다른 코드의 404', { status: 404, body: { code: 'ROUTE_NOT_FOUND', message: '경로 없음' } }],
    ['code 없는 404', { status: 404, body: { message: '없음' } }],
    ['HTML 404', { status: 404, raw: '<html>nginx</html>' }],
    ['빈 404', { status: 404, raw: '' }],
  ])('P-T3_리뷰 고침 H1: 조회의 %s는 없음으로 단정하지 않고 UNKNOWN이다(중간 장비의 답일 수 있다) [ASVS v5.0.0-16.5.3]', async (_name, reply) => {
    const { gateway } = scripted([reply]);
    await expect(gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it.each<[string, Scripted]>([
    ['HTML', { status: 429, raw: 'slow down' }],
    ['빈 답', { status: 429, raw: '' }],
    ['JSON인데 code 없음', { status: 429, body: { message: '많다' } }],
  ])('P-T34_리뷰 고침 낮음: 승인의 429는 JSON code가 없어도(%s) 한도 초과다(조회와 같이 판정을 앞에 둔다) [ASVS v5.0.0-2.3.2]', async (_name, reply) => {
    const { gateway } = scripted([reply]);
    await expect(gateway.confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'THROTTLED' });
  });

  it('P-T40_리뷰 고침 M4: 조회는 조회 전용 연결 묶음으로, 승인은 승인 묶음으로 나간다(승인 호출이 연결을 다 쥐어도 조회가 막히지 않는다) [ASVS v5.0.0-13.2.6]', async () => {
    const routed: string[] = [];
    const stub =
      (name: string, reply: Scripted): typeof fetch =>
      async (input, init) => {
        routed.push(`${name} ${init?.method} ${new URL(String(input)).pathname}`);
        return responseOf(reply);
      };
    const gateway = new SimulatorPaymentGateway({
      baseUrl: 'http://pg.test',
      secretKey: 'sim_sk_review',
      clientKey: 'sim_ck_review',
      fetch: stub('승인', { status: 200, body: { status: 'DONE', orderId: C.orderId, totalAmount: C.amount } }),
      queryFetch: stub('조회', { status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '없음' } }),
    });

    await gateway.confirm(C);
    await gateway.query(C.paymentRef);

    expect(routed).toEqual(['승인 POST /v1/payments/confirm', `조회 GET /v1/payments/${C.paymentRef}`]);
  });

  it('P-T40_리뷰 고침 M4: 승인 뒤 어댑터 안의 조회도 조회 묶음으로 나간다 [ASVS v5.0.0-13.2.6]', async () => {
    const routed: string[] = [];
    const stub =
      (name: string, reply: Scripted): typeof fetch =>
      async (_input, init) => {
        routed.push(`${name} ${init?.method}`);
        return responseOf(reply);
      };
    const gateway = new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_review', clientKey: 'sim_ck_review', fetch: stub('승인', already), queryFetch: stub('조회', payment()) });

    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED' });

    expect(routed).toEqual(['승인 POST', '조회 GET']);
  });

  it('P-T40_리뷰 고침 M4: 조회 묶음을 주지 않으면 fetch 하나로 모두 나간다(v0와 시험)', async () => {
    const { calls, gateway } = scripted([{ status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '없음' } }]);
    await gateway.query(C.paymentRef);
    expect(calls).toHaveLength(1);
  });

  it('P-T40_조회의 429는 결과 모름이고 한도 초과임을 표시한다(지표에 세고 상한은 낮추지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const { gateway } = scripted([{ status: 429, body: { code: 'TOO_MANY_REQUESTS', message: '요청이 너무 많습니다' } }]);
    await expect(gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
  });

  it('P-T40_조회의 5xx는 한도 초과 표시 없이 결과 모름이다', async () => {
    const { gateway } = scripted([{ status: 503, body: { code: 'PG_ERROR', message: '오류' } }]);
    await expect(gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it('P-T3_리뷰 고침 H1: 결제사의 정해진 코드(NOT_FOUND_PAYMENT)인 404만 NOT_FOUND다', async () => {
    const { gateway } = scripted([{ status: 404, body: { code: 'NOT_FOUND_PAYMENT', message: '결제를 찾을 수 없습니다' } }]);
    await expect(gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it('P-T3_리뷰 고침 M6: 조회는 넘긴 시간 한도까지만 기다리고 넘으면 UNKNOWN이다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    const gateway = new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_review', clientKey: 'sim_ck_review', fetch: fetchStub, readTimeoutMs: 5_000 });
    const started = performance.now();
    await expect(gateway.query(C.paymentRef, { timeoutMs: 50 })).resolves.toEqual({ kind: 'UNKNOWN' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('P-T3_리뷰 고침 L10: 조회 답에 결제 수단 분류를 싣는다(모르는 값은 비운다)', async () => {
    const { gateway } = scripted([payment({ method: '간편결제', balanceAmount: C.amount }), payment({ method: '새 수단', balanceAmount: C.amount })]);
    await expect(gateway.query(C.paymentRef)).resolves.toMatchObject({ kind: 'FOUND', method: 'EASY_PAY' });
    await expect(gateway.query(C.paymentRef)).resolves.not.toHaveProperty('method');
  });

  it('PRF181_리뷰 고침 L7: 몫이 남아 있으면 조회해 ALREADY_APPROVED다', async () => {
    const { gateway, calls } = scripted([already, payment()]);
    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', amount: C.amount });
    expect(calls).toEqual(['POST /v1/payments/confirm', `GET /v1/payments/${C.paymentRef}`]);
  });
});
