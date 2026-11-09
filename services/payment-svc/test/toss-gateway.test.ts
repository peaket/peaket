// 토스 어댑터 시험(P-T16의 시뮬레이터 몫, BUILD_ORDER PRF-184, docs/features/payment.md §2.1 '토스 어댑터의 첫 구현').
// - 공통 계약 묶음은 토스 어댑터를 시뮬레이터 주소로 실제 HTTP로 돌린다. 실제 토스 서버는 부르지 않는다(HOT-145).
// - 답 읽기는 공통 코드라서 토스·시뮬레이터 어댑터 둘 다 같은 표로 돌린다. 시뮬레이터가 만들 수 없는 답은 fetch 대역으로 만든다.
// - 시크릿 키는 실행마다 새로 만든다. 공개 문서의 시험 키를 저장소에 두지 않는다([ASVS v5.0.0-13.3.1]).
import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { fakeClock } from '@peaket/platform';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { describe, expect, it } from 'vitest';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { TossPaymentGateway, type TossGatewayOptions } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import type { PaymentGatewayPort } from '../src/modules/payment/domain/payment-gateway.js';
import { CONFIRM_CALL_BUDGET_MS } from '../src/modules/payment/domain/payment-gateway.js';
import { pgAdapterContract, type PgContractHarness } from './pg-contract.js';

const SECRET = `sim_sk_${randomBytes(16).toString('hex')}`;
const CLIENT = 'sim_ck_test_client';
const BASE = { baseUrl: 'http://pg.test', secretKey: SECRET, clientKey: CLIENT };
const ATTEMPT = { attemptId: 'attempt-1', successUrl: 'https://peaket.example/s', failUrl: 'https://peaket.example/f' };

const C = { orderId: 'order-toss-1', paymentRef: 'tgen_toss_1', amount: 10_000, idemKey: 'confirm-order-toss-1' };
const UNKNOWN = { outcome: 'UNKNOWN', paymentRef: C.paymentRef };

type Scripted = { status: number; body?: unknown; raw?: string };
const already: Scripted = { status: 400, body: { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제입니다' } };
const payment = (over: Record<string, unknown> = {}): Scripted => ({
  status: 200,
  body: { status: 'DONE', orderId: C.orderId, totalAmount: C.amount, balanceAmount: C.amount, approvedAt: '2026-11-09T10:00:00.000+09:00', ...over },
});
const responseOf = (s: Scripted): Response => new Response(s.raw ?? (s.body === undefined ? null : JSON.stringify(s.body)), { status: s.status });

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  redirect: RequestInit['redirect'];
}

function scriptedFetch(replies: Scripted[], seen: Seen[] = []): typeof fetch {
  return async (input, init) => {
    seen.push({ method: String(init?.method), url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? ''), redirect: init?.redirect });
    const next = replies.shift();
    if (!next) throw new Error('답을 더 정하지 않았다');
    return responseOf(next);
  };
}

type Make = (o?: Partial<TossGatewayOptions>) => PaymentGatewayPort;
const toss: Make = (o = {}) => new TossPaymentGateway({ ...BASE, ...o });
const simulator: Make = (o = {}) => new SimulatorPaymentGateway({ ...BASE, ...o });

async function startSim(): Promise<{ app: SimulatorApp; url: string; key: string; advance(ms: number): void; control(method: string, path: string, body?: unknown): Promise<Response> }> {
  let t = Date.parse('2026-11-09T01:00:00.000Z');
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => t }, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  return {
    app,
    url,
    key,
    advance: (ms) => void (t += ms),
    control: (method, path, body) =>
      fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}

pgAdapterContract('P-T16 토스페이먼츠(시뮬레이터 주소)', async (): Promise<PgContractHarness> => {
  const sim = await startSim();
  const fault = async (f: Record<string, unknown>) => expect((await sim.control('POST', '/sim/faults', { op: 'confirm', times: 1, ...f })).status).toBe(204);
  return {
    gateway: new TossPaymentGateway({ baseUrl: sim.url, secretKey: sim.key, clientKey: CLIENT }),
    async authenticate(orderId, amount, instrument) {
      const r = await sim.control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓', ...instrument });
      expect(r.status).toBe(200);
      return ((await r.json()) as { paymentKey: string }).paymentKey;
    },
    declineNextConfirm: () => fault({ kind: 'decline', code: 'REJECT_CARD_PAYMENT' }),
    dropNextConfirmAfterApply: () => fault({ kind: 'drop', applied: true }),
    delayNextConfirm: (ms) => fault({ kind: 'delay', ms }),
    advance: (ms) => sim.advance(ms),
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

describe.each<[string, Make]>([
  ['토스', toss],
  ['시뮬레이터', simulator],
])('P-T16 토스 모양 공통 답 읽기: %s', (_name, make) => {
  const scripted = (replies: Scripted[], o: Partial<TossGatewayOptions> = {}) => {
    const seen: Seen[] = [];
    return { seen, gateway: make({ fetch: scriptedFetch(replies, seen), ...o }) };
  };

  it.each<[string, Scripted]>([
    ['201 승인 모양', { status: 201, body: { status: 'DONE', orderId: C.orderId, totalAmount: C.amount } }],
    ['202', { status: 202, body: { code: 'ACCEPTED' } }],
    ['204 빈 답', { status: 204 }],
    ['301', { status: 301, raw: '' }],
    ['302 JSON code', { status: 302, body: { code: 'MOVED' } }],
    ['408 JSON code', { status: 408, body: { code: 'REQUEST_TIMEOUT' } }],
    ['400 HTML', { status: 400, raw: '<html>bad gateway</html>' }],
    ['401 HTML', { status: 401, raw: '<html>no</html>' }],
    ['403 빈 답', { status: 403, raw: '' }],
    ['404 JSON인데 code 없음', { status: 404, body: { message: '없음' } }],
    ['409 HTML', { status: 409, raw: 'conflict' }],
    ['400 JSON 배열', { status: 400, body: [{ code: 'REJECT_CARD_PAYMENT' }] }],
    ['400 code 빈 글', { status: 400, body: { code: '' } }],
    ['400 code가 글이 아님', { status: 400, body: { code: 42 } }],
    ['500 결제사 오류', { status: 500, body: { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' } }],
    ['503', { status: 503, raw: '' }],
  ])('P-T16_승인의 %s는 거절로 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    await expect(scripted([reply]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_연결이 끊기면 UNKNOWN이고 던지지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const gateway = make({ fetch: (async () => Promise.reject(new TypeError('끊김'))) as typeof fetch });
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    await expect(gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN' });
    await expect(gateway.cancel({ paymentRef: C.paymentRef, amount: 'ALL', reason: '고객 요청', idemKey: 'cancel-a1' })).resolves.toEqual({ outcome: 'UNKNOWN' });
  });

  it('P-T16_리디렉션을 따라가지 않는다 [ASVS v5.0.0-15.3.2]', async () => {
    const { seen, gateway } = scripted([{ status: 302, raw: '' }]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe('manual');
  });

  it('P-T16_승인 200은 시각·금액·카드·결제 수단을 싣는다', async () => {
    const card = { number: '43301234****123*', issuerCode: '61', cardType: '신용' };
    await expect(scripted([payment({ method: '카드', card })]).gateway.confirm(C)).resolves.toEqual({
      outcome: 'APPROVED',
      paymentRef: C.paymentRef,
      amount: C.amount,
      approvedAt: '2026-11-09T10:00:00.000+09:00',
      card: { maskedNumber: card.number, bin: '433012', issuerCode: 'HYUNDAI', cardType: 'CREDIT' },
      method: 'CARD',
    });
  });

  it('P-T50_단독 조회 답에도 카드 칸을 싣는다(UNKNOWN을 조회로 확정할 때 쓴다)', async () => {
    const card = { number: '43301234****123*', issuerCode: '61', cardType: '신용' };
    await expect(scripted([payment({ method: '카드', card })]).gateway.query(C.paymentRef)).resolves.toMatchObject({ kind: 'FOUND', status: 'APPROVED', card: { maskedNumber: card.number, bin: '433012', issuerCode: 'HYUNDAI', cardType: 'CREDIT' } });
  });

  it('P-T50_카드 정보가 없는 결제의 답에는 card가 없다(계좌이체·가상계좌)', async () => {
    const q = await scripted([payment({ method: '계좌이체', card: null })]).gateway.query(C.paymentRef);
    expect(q).toMatchObject({ kind: 'FOUND', status: 'APPROVED', method: 'TRANSFER' });
    expect(q).not.toHaveProperty('card');
  });

  it('P-T16_승인 200이 입금 대기면 WAITING_FOR_DEPOSIT이다', async () => {
    await expect(scripted([payment({ status: 'WAITING_FOR_DEPOSIT' })]).gateway.confirm(C)).resolves.toEqual({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: C.paymentRef, amount: C.amount });
  });

  it.each<[string, Record<string, unknown>]>([
    ['다른 주문 ID', { orderId: 'order-other' }],
    ['주문 ID 없음', { orderId: undefined }],
    ['입금 대기인데 다른 주문 ID', { status: 'WAITING_FOR_DEPOSIT', orderId: 'order-other' }],
  ])('P-T16_승인 200이 %s이면 UNKNOWN이다 [ASVS v5.0.0-2.2.3]', async (_n, over) => {
    await expect(scripted([payment(over)]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it.each(['IN_PROGRESS', 'READY', 'CANCELED', 'SOMETHING_NEW', undefined])('P-T16_승인 200의 상태가 %s이면 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    await expect(scripted([payment({ status })]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it.each<[string, Scripted]>([
    ['JSON code', { status: 429, body: { code: 'TOO_MANY_REQUESTS' } }],
    ['HTML', { status: 429, raw: 'slow down' }],
    ['빈 답', { status: 429, raw: '' }],
  ])('P-T16_승인의 429(%s)는 한도 초과다 [ASVS v5.0.0-2.3.2]', async (_n, reply) => {
    await expect(scripted([reply]).gateway.confirm(C)).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'THROTTLED' });
  });

  it.each<[number, string]>([
    [409, 'IDEMPOTENT_REQUEST_PROCESSING'],
    [400, 'ALREADY_PROCESSING_REQUEST'],
  ])('P-T16_대응표: %d %s → IN_PROGRESS', async (status, code) => {
    await expect(scripted([{ status, body: { code } }]).gateway.confirm(C)).resolves.toEqual({ outcome: 'IN_PROGRESS', paymentRef: C.paymentRef, pgCode: code });
  });

  it.each<[number, string, string]>([
    [401, 'UNAUTHORIZED_KEY', 'PG_ERROR'],
    [404, 'NOT_FOUND_PAYMENT_SESSION', 'EXPIRED'],
    [400, 'PAY_PROCESS_CANCELED', 'USER_ABORTED'],
    [400, 'PAY_PROCESS_ABORTED', 'USER_ABORTED'],
    [400, 'INVALID_REQUEST', 'VALIDATION'],
    [404, 'NOT_FOUND_PAYMENT', 'VALIDATION'],
    [400, 'DUPLICATED_ORDER_ID', 'VALIDATION'],
    [422, 'IDEMPOTENCY_KEY_REUSED', 'VALIDATION'],
    [400, 'REJECT_CARD_PAYMENT', 'CARD_DECLINED'],
    [400, 'EXCEED_MAX_AMOUNT', 'CARD_DECLINED'],
  ])('P-T16_대응표: %d %s → DECLINED·%s', async (status, code, failureCategory) => {
    await expect(scripted([{ status, body: { code, message: 'x' } }]).gateway.confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory, pgCode: code });
  });

  it.each<[number, string]>([
    [400, 'PROVIDER_ERROR'],
    [400, 'CARD_PROCESSING_ERROR'],
    [400, 'FAILED_INTERNAL_SYSTEM_PROCESSING'],
    [400, 'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING'],
    [400, 'FAILED_CARD_COMPANY_RESPONSE'],
    [400, 'UNKNOWN_PAYMENT_ERROR'],
    [400, 'COMMON_ERROR'],
    [403, 'FORBIDDEN_CONSECUTIVE_REQUEST'],
  ])('P-T16_리뷰 고침 H2: 승인의 %d %s는 일시 오류라 실패로 쓰지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status, code) => {
    await expect(scripted([{ status, body: { code, message: 'x' } }]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it.each(['DONE', 'PARTIAL_CANCELED'])('P-T16_이미 처리됨 뒤 조회가 %s이면 조회 금액을 실어 ALREADY_APPROVED다 [ASVS v5.0.0-2.2.3]', async (status) => {
    const { seen, gateway } = scripted([already, payment({ status, totalAmount: 9_000 })]);
    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', paymentRef: C.paymentRef, amount: 9_000 });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  });

  it.each(['IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'READY', 'CANCELED', 'ABORTED', undefined])('P-T16_이미 처리됨 뒤 조회가 %s이면 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    await expect(scripted([already, payment({ status })]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_이미 처리됨 뒤 조회의 주문 ID가 다르거나 조회가 실패하면 UNKNOWN이다 [ASVS v5.0.0-2.2.3]', async () => {
    await expect(scripted([already, payment({ orderId: 'order-other' })]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    await expect(scripted([already, { status: 500, raw: '' }]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_승인에 시간 몫을 다 썼으면 뒤따르는 조회를 보내지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-09T00:00:00.000Z') });
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      calls.push(String(init?.method));
      clock.advance(CONFIRM_CALL_BUDGET_MS);
      return responseOf(already);
    };
    await expect(make({ fetch: fetchStub, clock }).confirm(C)).resolves.toEqual(UNKNOWN);
    expect(calls).toEqual(['POST']);
  });

  it('P-T16_뒤따르는 조회는 승인에 쓴 시간을 뺀 몫까지만 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        await new Promise((r) => setTimeout(r, 120));
        return responseOf(already);
      }
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    };
    const started = performance.now();
    await expect(make({ fetch: fetchStub, readTimeoutMs: 3_000, confirmBudgetMs: 300 }).confirm(C)).resolves.toEqual(UNKNOWN);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('P-T16_결제사의 정해진 코드인 404만 조회 NOT_FOUND다', async () => {
    await expect(scripted([{ status: 404, body: { code: 'NOT_FOUND_PAYMENT' } }]).gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it.each<[string, Scripted]>([
    ['다른 코드의 404', { status: 404, body: { code: 'ROUTE_NOT_FOUND' } }],
    ['code 없는 404', { status: 404, body: { message: '없음' } }],
    ['HTML 404', { status: 404, raw: '<html>nginx</html>' }],
    ['5xx', { status: 503, body: { code: 'PG_ERROR' } }],
    ['금액 없는 200', payment({ totalAmount: undefined })],
    ['잔액 없는 200', payment({ balanceAmount: undefined })],
    ['주문 ID 없는 200', payment({ orderId: undefined })],
    ['모르는 상태의 200', payment({ status: 'SOMETHING_NEW' })],
    ['JSON이 아닌 200', { status: 200, raw: 'ok' }],
  ])('P-T16_조회의 %s는 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    await expect(scripted([reply]).gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('P-T16_리뷰 고침 낮음: 조회 상태가 객체 내장 이름 %s여도 모르는 상태라 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    await expect(scripted([payment({ status })]).gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it('P-T16_조회의 429는 한도 초과 표시를 단 UNKNOWN이다 [ASVS v5.0.0-2.3.2]', async () => {
    await expect(scripted([{ status: 429, raw: '' }]).gateway.query(C.paymentRef)).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
  });

  it.each<[string, string]>([
    ['READY', 'READY'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
    ['WAITING_FOR_DEPOSIT', 'WAITING_FOR_DEPOSIT'],
    ['DONE', 'APPROVED'],
    ['PARTIAL_CANCELED', 'PARTIAL_CANCELED'],
    ['CANCELED', 'CANCELED'],
    ['ABORTED', 'FAILED'],
    ['EXPIRED', 'EXPIRED'],
  ])('P-T16_조회 상태 대응표: %s → %s', async (raw, status) => {
    await expect(scripted([payment({ status: raw })]).gateway.query(C.paymentRef)).resolves.toMatchObject({ kind: 'FOUND', paymentRef: C.paymentRef, orderRef: C.orderId, status });
  });

  it.each<[string, string | undefined]>([
    ['카드', 'CARD'],
    ['간편결제', 'EASY_PAY'],
    ['계좌이체', 'TRANSFER'],
    ['가상계좌', 'OTHER'],
    ['휴대폰', 'OTHER'],
    ['문화상품권', 'OTHER'],
    ['도서문화상품권', 'OTHER'],
    ['게임문화상품권', 'OTHER'],
    ['새 수단', undefined],
  ])('P-T16_조회의 결제 수단(리뷰 고침 낮음: 가상계좌·휴대폰·상품권은 OTHER) %s → %s', async (raw, method) => {
    const q = await scripted([payment({ method: raw })]).gateway.query(C.paymentRef);
    if (method) expect(q).toMatchObject({ method });
    else expect(q).not.toHaveProperty('method');
  });

  it('P-T16_조회는 넘긴 시간 한도까지만 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    const started = performance.now();
    await expect(make({ fetch: fetchStub, readTimeoutMs: 5_000 }).query(C.paymentRef, { timeoutMs: 50 })).resolves.toEqual({ kind: 'UNKNOWN' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('P-T16_조회는 조회 묶음으로, 승인·취소는 승인 묶음으로 나간다 [ASVS v5.0.0-13.2.6]', async () => {
    const routed: string[] = [];
    const stub =
      (name: string, reply: Scripted): typeof fetch =>
      async (_input, init) => {
        routed.push(`${name} ${init?.method}`);
        return responseOf(reply);
      };
    const gateway = make({ fetch: stub('승인', payment()), queryFetch: stub('조회', payment()) });
    await gateway.confirm(C);
    await gateway.query(C.paymentRef);
    await gateway.cancel({ paymentRef: C.paymentRef, amount: 'ALL', reason: '고객 요청', idemKey: 'cancel-a1' });
    expect(routed).toEqual(['승인 POST', '조회 GET', '승인 POST']);
  });

  const cancel = (gateway: PaymentGatewayPort, amount: number | 'ALL' = 'ALL') => gateway.cancel({ paymentRef: C.paymentRef, amount, reason: '고객 요청', idemKey: 'cancel-a1' });

  it.each<[string, Scripted, Record<string, unknown>]>([
    ['전액 취소', { status: 200, body: { status: 'CANCELED', balanceAmount: 0 } }, { outcome: 'CANCELLED', balanceAmount: 0 }],
    ['부분 취소', { status: 200, body: { status: 'PARTIAL_CANCELED', balanceAmount: 7_000 } }, { outcome: 'CANCELLED', balanceAmount: 7_000 }],
    ['200인데 다른 상태', { status: 200, body: { status: 'DONE' } }, { outcome: 'UNKNOWN' }],
    ['처리 중', { status: 409, body: { code: 'IDEMPOTENT_REQUEST_PROCESSING' } }, { outcome: 'CANCEL_PENDING', pgCode: 'IDEMPOTENT_REQUEST_PROCESSING' }],
    ['429', { status: 429, raw: '' }, { outcome: 'UNKNOWN' }],
    ['5xx', { status: 500, raw: '' }, { outcome: 'UNKNOWN' }],
    ['이미 전액 취소', { status: 400, body: { code: 'ALREADY_CANCELED_PAYMENT' } }, { outcome: 'CANCELLED', balanceAmount: 0, pgCode: 'ALREADY_CANCELED_PAYMENT' }],
    ['거절', { status: 400, body: { code: 'NOT_CANCELABLE_PAYMENT' } }, { outcome: 'REJECTED', pgCode: 'NOT_CANCELABLE_PAYMENT' }],
  ])('P-T16_취소 대응표: %s', async (_n, reply, want) => {
    await expect(cancel(scripted([reply]).gateway)).resolves.toEqual(want);
  });

  it.each<[string, Scripted]>([
    ['code 없는 400', { status: 400, raw: 'x' }],
    ['code 없는 403', { status: 403, raw: '' }],
    ['code 없는 404 JSON', { status: 404, body: { message: '없음' } }],
    ['code 없는 409', { status: 409, raw: 'conflict' }],
    ['400 code 빈 글', { status: 400, body: { code: '' } }],
    ['201 취소 모양', { status: 201, body: { status: 'CANCELED', balanceAmount: 0 } }],
    ['202', { status: 202, body: { code: 'ACCEPTED' } }],
    ['204 빈 답', { status: 204 }],
    ['301', { status: 301, raw: '' }],
    ['302 JSON code', { status: 302, body: { code: 'MOVED' } }],
    ['408 JSON code', { status: 408, body: { code: 'REQUEST_TIMEOUT' } }],
    ['400 PROVIDER_ERROR', { status: 400, body: { code: 'PROVIDER_ERROR' } }],
    ['400 COMMON_ERROR', { status: 400, body: { code: 'COMMON_ERROR' } }],
    ['403 FORBIDDEN_CONSECUTIVE_REQUEST', { status: 403, body: { code: 'FORBIDDEN_CONSECUTIVE_REQUEST' } }],
  ])('P-T16_리뷰 고침 M4: 취소의 %s는 거절로 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    await expect(cancel(scripted([reply]).gateway)).resolves.toEqual({ outcome: 'UNKNOWN' });
  });

  it('P-T16_부분 취소가 이미 전액 취소됐다는 답을 받으면 REJECTED다', async () => {
    await expect(cancel(scripted([{ status: 400, body: { code: 'ALREADY_CANCELED_PAYMENT' } }]).gateway, 1_000)).resolves.toEqual({ outcome: 'REJECTED', pgCode: 'ALREADY_CANCELED_PAYMENT' });
  });

  it('P-T16_멱등키는 confirm-{주문 ID}·cancel-{취소 ID} 형식만 받는다(ADR-0029 결정 4)', async () => {
    const gateway = make({ fetch: scriptedFetch([]) });
    await expect(gateway.confirm({ ...C, idemKey: 'confirm-other' })).rejects.toThrow(/멱등키/);
    await expect(gateway.cancel({ paymentRef: C.paymentRef, amount: 'ALL', reason: '고객 요청', idemKey: 'refund-1' })).rejects.toThrow(/멱등키/);
  });

  const hook = { 'tosspayments-webhook-transmission-id': 'wh_1' };
  const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-09T10:00:00.000+09:00', data: { paymentKey: 'tgen_1', orderId: 'order-1', status: 'DONE' } });

  it('P-T16_웹훅: 전송 ID를 중복 제거 키로 쓰고(머리 이름 대소문자 무관) 상태를 싣지 않는다', () => {
    const gateway = make();
    expect(gateway.parseWebhook({ 'TossPayments-Webhook-Transmission-Id': 'wh_1' }, body)).toEqual({ kind: 'TRIGGER', dedupKey: `${gateway.pg}:wh_1`, paymentRef: 'tgen_1', orderRef: 'order-1' });
  });

  it.each<[string, Record<string, string | string[]>, string]>([
    ['전송 ID 없음', {}, body],
    ['전송 ID가 여러 값', { 'tosspayments-webhook-transmission-id': ['a', 'b'] }, body],
    ['전송 ID가 너무 김', { 'tosspayments-webhook-transmission-id': 'x'.repeat(201) }, body],
    ['JSON이 아님', hook, '{'],
    ['null 본문', hook, 'null'],
    ['결제 키 없음', hook, JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: {} })],
    ['결제 키가 글이 아님', hook, JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 1 } })],
  ])('P-T16_웹훅 %s이면 거절이다 [ASVS v5.0.0-16.5.3]', (_n, headers, text) => {
    expect(make().parseWebhook(headers, text)).toMatchObject({ kind: 'INVALID' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['모르는 사건', { eventType: 'SOMETHING', data: { paymentKey: 'tgen_1' } }],
    ['지급대행 사건', { eventType: 'payout.changed', data: { payoutId: 'p-1' } }],
    ['사건 이름도 입금 통보 칸도 없음', { createdAt: '2026-11-09T10:00:00.000000' }],
    ['데이터 칸의 입금 통보 이름', { eventType: 'DEPOSIT_CALLBACK', data: {} }],
  ])('P-T17_웹훅 %s은 거절이 아니라 무시다 [ASVS v5.0.0-16.5.3]', (_n, payload) => {
    expect(make().parseWebhook(hook, JSON.stringify(payload))).toEqual({ kind: 'IGNORED' });
  });

  const webhookOf = (data: Record<string, unknown>): string => JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data });

  it.each<[string, Record<string, unknown>]>([
    ['결제 키가 ASCII가 아님', { paymentKey: '결제키', orderId: 'order-1' }],
    ['결제 키가 200자를 넘음', { paymentKey: 'x'.repeat(201), orderId: 'order-1' }],
    ['결제 키에 줄바꿈이 있음', { paymentKey: 'tgen\n1', orderId: 'order-1' }],
    ['결제 키에 공백이 있음', { paymentKey: 'tgen 1', orderId: 'order-1' }],
    ['주문 ID가 ASCII가 아님', { paymentKey: 'tgen_1', orderId: '주문' }],
    ['주문 ID가 200자를 넘음', { paymentKey: 'tgen_1', orderId: 'x'.repeat(201) }],
    ['주문 ID가 글이 아님', { paymentKey: 'tgen_1', orderId: 1 }],
    ['주문 ID가 빈 글', { paymentKey: 'tgen_1', orderId: '' }],
  ])('P-T16_리뷰 고침 낮음: 웹훅의 %s이면 거절이다 [ASVS v5.0.0-2.2.1]', (_n, data) => {
    expect(make().parseWebhook(hook, webhookOf(data))).toMatchObject({ kind: 'INVALID', reason: 'BODY' });
  });

  it('P-T16_리뷰 고침 낮음: 웹훅의 결제 키·주문 ID는 200자까지 받고 주문 ID는 없어도 된다 [ASVS v5.0.0-2.2.1]', () => {
    const gateway = make();
    const long = 'x'.repeat(200);
    expect(gateway.parseWebhook(hook, webhookOf({ paymentKey: long, orderId: long }))).toEqual({ kind: 'TRIGGER', dedupKey: `${gateway.pg}:wh_1`, paymentRef: long, orderRef: long });
    expect(gateway.parseWebhook(hook, webhookOf({ paymentKey: 'tgen_1' }))).toEqual({ kind: 'TRIGGER', dedupKey: `${gateway.pg}:wh_1`, paymentRef: 'tgen_1' });
  });
});

describe('P-T16 토스 어댑터만의 것', () => {
  it('P-T16_결제사 이름은 TOSS다', () => {
    expect(toss().pg).toBe('TOSS');
  });

  it('P-T16_능력 플래그(payment §2.1, ADR-0029 결정 2, ADR-0036)', () => {
    expect(toss().capabilities()).toEqual({
      serverConfirm: true,
      confirmDeadlineMs: 600_000,
      partialCancel: true,
      webhookSignature: false,
      idempotencyRetentionMs: 15 * 24 * 3_600_000,
      callsPerSecond: 300,
      redirectCheckout: true,
    });
    expect(toss({ callsPerSecond: 50 }).capabilities().callsPerSecond).toBe(50);
  });

  it('P-T16_결제창 값은 toss 칸이고 §2.2 표의 값을 싣는다', () => {
    const orderId = randomUUID();
    expect(toss().checkout({ orderId, orderName: '티켓', amount: 1_000, customerKey: 'cust-key-1' }, ATTEMPT, 'CARD')).toEqual({
      toss: { clientKey: CLIENT, customerKey: 'cust-key-1', orderId, orderName: '티켓', amount: 1_000, successUrl: ATTEMPT.successUrl, failUrl: ATTEMPT.failUrl },
    });
  });

  it('P-T16_결제 수단 고르기는 결제창이 하므로 payMethod로 막지 않는다', () => {
    const v = toss().checkout({ orderId: 'o-1', orderName: '티켓', amount: 1_000 }, ATTEMPT, 'VIRTUAL_ACCOUNT');
    expect(v).toHaveProperty('toss');
  });

  it('P-T16_결제 금액은 양의 정수여야 한다 [ASVS v5.0.0-2.2.3]', () => {
    for (const amount of [0, -1, 1.5, Number.NaN]) expect(() => toss().checkout({ orderId: 'o-1', orderName: '티켓', amount }, ATTEMPT, 'CARD')).toThrow(/금액/);
  });

  it('P-T16_구매자 키가 없으면 CSPRNG 128비트 값을 호출마다 새로 만든다(비회원을 한 값으로 묶지 않는다) [ASVS v5.0.0-11.5.1]', () => {
    const key = () => {
      const v = toss().checkout({ orderId: 'o-1', orderName: '티켓', amount: 1_000 }, ATTEMPT, 'CARD');
      return (v as { toss: { customerKey: string } }).toss.customerKey;
    };
    const [a, b] = [key(), key()];
    expect(a).not.toBe(b);
    expect(a).not.toBe('ANONYMOUS');
    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
  });

  it.each([
    ['빈 글', ''],
    ['한 글자', 'a'],
    ['51자', 'x'.repeat(51)],
    ['한글', '구매자키'],
    ['공백', 'has space'],
    ['허용되지 않은 기호', 'key/1'],
    ['비회원 고정 값', 'ANONYMOUS'],
  ])('P-T16_리뷰 고침 낮음: 넘어온 구매자 키가 %s이면 결제창 값을 만들지 않고 글에 값을 싣지 않는다 [ASVS v5.0.0-2.2.1]', (_n, customerKey) => {
    const make = () => toss().checkout({ orderId: 'o-1', orderName: '티켓', amount: 1_000, customerKey }, ATTEMPT, 'CARD');
    expect(make).toThrow(/구매자 키/);
    if (customerKey.length > 1) expect(() => make()).not.toThrow(new RegExp(customerKey));
  });

  it.each(['ab', 'x'.repeat(50), 'aZ09-_=.@'])('P-T16_리뷰 고침 낮음: 구매자 키 %s는 토스 형식이라 받는다 [ASVS v5.0.0-2.2.1]', (customerKey) => {
    expect(toss().checkout({ orderId: 'o-1', orderName: '티켓', amount: 1_000, customerKey }, ATTEMPT, 'CARD')).toMatchObject({ toss: { customerKey } });
  });

  it('P-T16_시크릿 키는 Basic 머리로만 나간다(주소·본문·다른 머리에 없다) [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-13.2.2]', async () => {
    const seen: Seen[] = [];
    const gateway = toss({ fetch: scriptedFetch([payment(), payment(), { status: 200, body: { status: 'CANCELED', balanceAmount: 0 } }], seen) });
    await gateway.confirm(C);
    await gateway.query(C.paymentRef);
    await gateway.cancel({ paymentRef: C.paymentRef, amount: 3_000, reason: '고객 요청', idemKey: 'cancel-a1' });
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`);
      expect(s.url).not.toContain(SECRET);
      expect(s.body).not.toContain(SECRET);
      for (const [name, value] of s.headers) if (name !== 'authorization') expect(value).not.toContain(SECRET);
    }
  });

  it('P-T16_호출 경로·본문과 멱등키 머리(조회에는 멱등키가 없다)', async () => {
    const seen: Seen[] = [];
    const gateway = toss({ fetch: scriptedFetch([payment(), payment(), { status: 200, body: { status: 'PARTIAL_CANCELED', balanceAmount: 7_000 } }, { status: 200, body: { status: 'CANCELED', balanceAmount: 0 } }], seen) });
    await gateway.confirm(C);
    await gateway.query('t/key 1');
    await gateway.cancel({ paymentRef: C.paymentRef, amount: 3_000, reason: '고객 요청', idemKey: 'cancel-a1' });
    await gateway.cancel({ paymentRef: C.paymentRef, amount: 'ALL', reason: '회차 취소', idemKey: 'cancel-a2' });
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /v1/payments/confirm',
      'GET /v1/payments/t%2Fkey%201',
      `POST /v1/payments/${C.paymentRef}/cancel`,
      `POST /v1/payments/${C.paymentRef}/cancel`,
    ]);
    expect(seen.map((s) => s.headers.get('idempotency-key'))).toEqual([C.idemKey, null, 'cancel-a1', 'cancel-a2']);
    expect(JSON.parse(seen[0]!.body)).toEqual({ paymentKey: C.paymentRef, orderId: C.orderId, amount: C.amount });
    expect(JSON.parse(seen[2]!.body)).toEqual({ cancelReason: '고객 요청', cancelAmount: 3_000 });
    expect(JSON.parse(seen[3]!.body)).toEqual({ cancelReason: '회차 취소' });
  });

  it('P-T16_결제사 호출에 추적 머리를 싣지 않는다 [ASVS v5.0.0-14.2.3]', async () => {
    const seen: Seen[] = [];
    await toss({ fetch: scriptedFetch([payment()], seen) }).confirm(C);
    for (const name of ['traceparent', 'tracestate', 'baggage']) expect(seen[0]!.headers.has(name)).toBe(false);
  });

  it('P-T16_객체를 로그로 찍거나 JSON으로 바꿔도 시크릿 키가 실리지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const gateway = toss();
    const encoded = Buffer.from(`${SECRET}:`).toString('base64');
    for (const text of [inspect(gateway, { depth: 8, showHidden: true }), JSON.stringify(gateway)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(encoded);
    }
  });

  it.each(['REJECT_CARD_PAYMENT', 'REJECT_ACCOUNT_PAYMENT', 'REJECT_CARD_COMPANY', 'REJECT_TOSSPAY_INVALID_ACCOUNT', 'EXCEED_MAX_AUTH_COUNT', 'EXCEED_MAX_ONE_DAY_AMOUNT', 'NOT_AVAILABLE_BANK', 'INVALID_PASSWORD', 'FDS_ERROR'])(
    'P-T16_대응표: 403 %s는 구매자 쪽 거절이라 CARD_DECLINED다',
    async (code) => {
      await expect(toss({ fetch: scriptedFetch([{ status: 403, body: { code } }]) }).confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'CARD_DECLINED', pgCode: code });
    },
  );

  it.each<[number, string]>([
    [401, 'UNAUTHORIZED_KEY'],
    [403, 'FORBIDDEN_REQUEST'],
    [403, 'INCORRECT_BASIC_AUTH_FORMAT'],
    [400, 'INVALID_API_KEY'],
  ])('P-T16_대응표: %d %s는 우리 쪽 설정 문제라 PG_ERROR다', async (status, code) => {
    await expect(toss({ fetch: scriptedFetch([{ status, body: { code } }]) }).confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'PG_ERROR', pgCode: code });
  });

  it.each([
    'INVALID_REJECT_CARD',
    'INVALID_STOPPED_CARD',
    'INVALID_CARD_EXPIRATION',
    'INVALID_CARD_LOST_OR_STOLEN',
    'INVALID_CARD_NUMBER',
    'INVALID_CARD_INSTALLMENT_PLAN',
    'EXCEED_MAX_AMOUNT',
    'EXCEED_MAX_CARD_INSTALLMENT_PLAN',
    'EXCEED_MAX_DAILY_PAYMENT_COUNT',
    'EXCEED_MAX_PAYMENT_AMOUNT',
    'EXCEED_MAX_MONTHLY_PAYMENT_AMOUNT',
    'EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT',
    'EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT',
    'NOT_ALLOWED_POINT_USE',
    'NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN',
    'RESTRICTED_TRANSFER_ACCOUNT',
    'INVALID_ACCOUNT_INFO_RE_REGISTER',
    'REJECT_CARD_PAYMENT',
    'REJECT_CARD_COMPANY',
  ])('P-T16_리뷰 고침 H2: 400 %s는 토스 문서가 적은 구매자 쪽 거절이라 CARD_DECLINED다', async (code) => {
    await expect(toss({ fetch: scriptedFetch([{ status: 400, body: { code } }]) }).confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'CARD_DECLINED', pgCode: code });
  });

  it.each(['SOMETHING_NEW', 'NOT_AVAILABLE_PAYMENT', 'UNAPPROVED_ORDER_ID', 'BELOW_MINIMUM_AMOUNT', 'INVALID_AUTHORIZE_AUTH', 'NOT_SUPPORTED_INSTALLMENT_PLAN_CARD_OR_MERCHANT'])(
    'P-T16_리뷰 고침 H2: 대응표에 없는 400 %s는 카드 거절로 쓰지 않고 UNKNOWN이다(단독 조회가 정한다) [ASVS v5.0.0-16.5.3]',
    async (code) => {
      await expect(toss({ fetch: scriptedFetch([{ status: 400, body: { code } }]) }).confirm(C)).resolves.toEqual(UNKNOWN);
    },
  );

  it.each(['NOT_FOUND_TERMINAL_ID', 'NOT_REGISTERED_BUSINESS', 'INVALID_UNREGISTERED_SUBMALL'])('P-T16_리뷰 고침 H2: 400 %s는 가맹점 설정 오류라 PG_ERROR다', async (code) => {
    await expect(toss({ fetch: scriptedFetch([{ status: 400, body: { code } }]) }).confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'PG_ERROR', pgCode: code });
  });

  it.each(['SOMETHING_NEW', 'NOT_AVAILABLE_PAYMENT', 'EXCEED_MAX_DAILY_PAYMENT_COUNT'])('P-T16_리뷰 고침 H2: 시뮬레이터는 표에 없는 400 %s를 그대로 CARD_DECLINED로 읽는다(v0 시험이 고정한다)', async (code) => {
    await expect(simulator({ fetch: scriptedFetch([{ status: 400, body: { code } }]) }).confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: C.paymentRef, failureCategory: 'CARD_DECLINED', pgCode: code });
  });

  it('P-T16_대응표의 토스 추가분은 시뮬레이터에 번지지 않는다(시뮬레이터의 403은 그대로 PG_ERROR)', async () => {
    await expect(simulator({ fetch: scriptedFetch([{ status: 403, body: { code: 'REJECT_CARD_PAYMENT' } }]) }).confirm(C)).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'PG_ERROR' });
  });

  it('P-T16_입금 통보(DEPOSIT_CALLBACK)는 주문 ID와 대조할 secret만 실은 조회 신호이고 상태를 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const deposit = JSON.stringify({ createdAt: '2026-11-09T10:00:00.000000', secret: 'deposit-secret', status: 'DONE', transactionKey: 't', orderId: 'order-1' });
    const parsed = toss().parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_1' }, deposit);
    expect(parsed).toEqual({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:t:DONE', orderRef: 'order-1', depositSecret: 'deposit-secret', depositDone: true });
  });

  it('P-T16_리뷰 고침 L6: 입금 통보는 전송 ID 머리에 기대지 않고 거래 키와 상태로 중복을 가른다(머리가 없어도 받고, 다시 보내도 같은 키다)', () => {
    const deposit = JSON.stringify({ createdAt: '2026-11-09T10:00:00.000000', secret: 'deposit-secret', status: 'DONE', transactionKey: 'tx-1', orderId: 'order-1' });
    const expected = { kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tx-1:DONE', orderRef: 'order-1', depositSecret: 'deposit-secret', depositDone: true };
    expect(toss().parseWebhook({}, deposit)).toEqual(expected);
    expect(toss().parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_1' }, deposit)).toEqual(expected);
    expect(toss().parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_2' }, deposit)).toEqual(expected);
  });

  it.each<[string, Record<string, unknown>]>([
    ['거래 키 없음', { secret: 'x', status: 'DONE', orderId: 'order-1' }],
    ['거래 키에 공백이 있음', { secret: 'x', status: 'DONE', transactionKey: 'tx 1', orderId: 'order-1' }],
    ['상태 없음', { secret: 'x', transactionKey: 't', orderId: 'order-1' }],
  ])('P-T16_리뷰 고침 L6: 입금 통보의 %s이면 거절이다 [ASVS v5.0.0-2.2.1]', (_n, payload) => {
    expect(toss().parseWebhook({}, JSON.stringify(payload))).toMatchObject({ kind: 'INVALID', reason: 'BODY' });
  });

  it.each<[string, string]>([
    ['129자', 'x'.repeat(129)],
    ['공백이 든 값', 'wh 1'],
    ['줄바꿈이 든 값', 'wh\n1'],
    ['ASCII가 아닌 값', '전송아이디'],
  ])('P-T17_리뷰 고침 H1: 전송 ID가 %s이면 거절이다(저장하는 키의 모양과 길이를 묶는다) [ASVS v5.0.0-2.2.1]', (_n, id) => {
    const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'tgen_1', orderId: 'order-1' } });
    expect(toss().parseWebhook({ 'tosspayments-webhook-transmission-id': id }, body)).toEqual({ kind: 'INVALID', reason: 'HEADER' });
  });

  it('P-T17_리뷰 고침 H1: 전송 ID는 128자까지 받고 형식을 더 따지지 않는다(토스 문서가 불투명한 글이라고 적는다) [ASVS v5.0.0-2.2.1]', () => {
    const body = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'tgen_1' } });
    for (const id of ['x'.repeat(128), 'a.b:c/d+e=~!']) expect(toss().parseWebhook({ 'tosspayments-webhook-transmission-id': id }, body)).toEqual({ kind: 'TRIGGER', dedupKey: `TOSS:${id}`, paymentRef: 'tgen_1' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['주문 ID 없음', { secret: 'x', status: 'DONE', transactionKey: 't' }],
    ['주문 ID가 글이 아님', { secret: 'x', status: 'DONE', transactionKey: 't', orderId: 1 }],
    ['주문 ID가 ASCII가 아님', { secret: 'x', status: 'DONE', transactionKey: 't', orderId: '주문' }],
  ])('P-T16_입금 통보의 %s이면 거절이다 [ASVS v5.0.0-2.2.1]', (_n, payload) => {
    expect(toss().parseWebhook({ 'tosspayments-webhook-transmission-id': 'wh_1' }, JSON.stringify(payload))).toMatchObject({ kind: 'INVALID', reason: 'BODY' });
  });
});
