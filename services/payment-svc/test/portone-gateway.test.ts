// 포트원 어댑터 시험(P-T16의 시뮬레이터 몫, BUILD_ORDER HOT-140, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
// - 공통 계약 묶음은 포트원 어댑터를 시뮬레이터의 포트원 경로로 실제 HTTP로 돌린다. 실제 포트원 서버는 부르지 않는다(HOT-145).
// - 답 읽기·대응표는 fetch 대역으로 만든다. 답의 모양은 포트원 V2 공식 스키마(2026-11-09 확인)를 따른다.
// - 시크릿과 웹훅 시크릿은 실행마다 새로 만든다([ASVS v5.0.0-13.3.1]).
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { fakeClock } from '@peaket/platform';
import { buildSimulatorApp } from '@peaket/pg-simulator';
import { describe, expect, it } from 'vitest';
import { PORTONE_FOLLOW_UP_TIMEOUT_MS, PortoneGateway, type PortoneGatewayOptions } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { CONFIRM_CALL_BUDGET_MS, type PaymentGatewayPort } from '../src/modules/payment/domain/payment-gateway.js';
import { pgAdapterContract, type PgContractHarness } from './pg-contract.js';

const SECRET = `portone_api_secret_${randomBytes(16).toString('hex')}`;
const WEBHOOK_KEY = randomBytes(32);
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString('base64')}`;
const OLD_WEBHOOK_KEY = randomBytes(32);
const OLD_WEBHOOK_SECRET = `whsec_${OLD_WEBHOOK_KEY.toString('base64')}`;
const TOKEN = `tok_${randomBytes(12).toString('hex')}`;
const ORDER_ID = '0195f3a0-0000-7000-8000-000000000001';
const PAYMENT_ID = `pay-${ORDER_ID}`;
const NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const BASE: PortoneGatewayOptions = { baseUrl: 'http://pg.test', secret: SECRET, storeId: 'store-1', channelKey: 'channel-1', webhookSecrets: [WEBHOOK_SECRET], isTest: true, clock: fakeClock({ now: NOW_MS }) };
const ATTEMPT = { attemptId: 'attempt-1', successUrl: 'https://peaket.example/s', failUrl: 'https://peaket.example/f' };
const C = { orderId: ORDER_ID, paymentRef: PAYMENT_ID, amount: 10_000, idemKey: `confirm-${ORDER_ID}`, confirmToken: TOKEN };
const UNKNOWN = { outcome: 'UNKNOWN', paymentRef: C.paymentRef };

type Scripted = { status: number; body?: unknown; raw?: string };
interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  redirect: RequestInit['redirect'];
}

const paid: Scripted = { status: 200, body: { pgTxId: 'pg-tx-1', paidAt: '2026-11-09T01:00:00.000Z' } };
const viewOf = (over: Record<string, unknown> = {}): Scripted => ({
  status: 200,
  body: {
    status: 'PAID',
    id: PAYMENT_ID,
    amount: { total: C.amount, taxFree: 0, discount: 0, paid: C.amount, cancelled: 0, cancelledTaxFree: 0 },
    currency: 'KRW',
    paidAt: '2026-11-09T01:00:00.000Z',
    method: { type: 'PaymentMethodCard', card: { number: '43301234****123*', issuer: 'SHINHAN', type: 'CREDIT' } },
    ...over,
  },
});
const alreadyPaid: Scripted = { status: 409, body: { type: 'ALREADY_PAID', message: '이미 결제되었습니다' } };
const responseOf = (s: Scripted): Response => new Response(s.raw ?? (s.body === undefined ? null : JSON.stringify(s.body)), { status: s.status });

function scriptedFetch(replies: Scripted[], seen: Seen[] = []): typeof fetch {
  return async (input, init) => {
    seen.push({ method: String(init?.method), url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? ''), redirect: init?.redirect });
    const next = replies.shift();
    if (!next) throw new Error('답을 더 정하지 않았다');
    return responseOf(next);
  };
}

const gatewayOf = (o: Partial<PortoneGatewayOptions> = {}) => new PortoneGateway({ ...BASE, ...o });
const port = (): PaymentGatewayPort => gatewayOf();
const scripted = (replies: Scripted[], o: Partial<PortoneGatewayOptions> = {}) => {
  const seen: Seen[] = [];
  return { seen, gateway: gatewayOf({ fetch: scriptedFetch(replies, seen), ...o }) };
};

async function startHarness(): Promise<PgContractHarness> {
  const clock = fakeClock({ now: NOW_MS });
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const webhook = `whsec_${randomBytes(32).toString('base64')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => clock.now() }, confirmLatency: { kind: 'none' }, portoneWebhookSecret: webhook });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const basic = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, { method, headers: { authorization: basic, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const fault = async (f: Record<string, unknown>) => expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, ...f })).status).toBe(204);
  const tokens = new Map<string, string>();
  return {
    gateway: new PortoneGateway({ baseUrl: url, secret: key, storeId: 'store-sim', channelKey: 'channel-sim', webhookSecrets: [webhook], isTest: true, clock }),
    async authenticate(orderId, amount, instrument) {
      const r = await control('POST', '/sim/portone/authenticate', { orderId, amount, orderName: '공연 티켓', ...instrument });
      expect(r.status).toBe(200);
      const { paymentId, paymentToken } = (await r.json()) as { paymentId: string; paymentToken: string };
      tokens.set(paymentId, paymentToken);
      return paymentId;
    },
    confirmTokenOf: (paymentRef) => tokens.get(paymentRef)!,
    // 공식 스키마에 전용 코드가 없다: 카드 거절은 502 PG_PROVIDER(UNKNOWN, 단독 조회가 정한다), 기한이 지난 토큰은 INVALID_PAYMENT_TOKEN(VALIDATION)이다. 취소 답에는 남은 금액 칸이 없다(이어지는 조회로 본다)
    // 포트원 issuer는 공식 스키마에 값 목록이 없어 표로 바꾸지 않는다(시뮬레이터가 보낸 값 그대로다). bin은 시뮬레이터가 가린 번호의 앞 8자리로 보낸다
    expectations: { declined: { outcome: 'UNKNOWN' }, expired: { outcome: 'DECLINED', failureCategory: 'VALIDATION' }, cancelled: { outcome: 'CANCELLED' }, card: { maskedNumber: '43301234****123*', bin: '43301234', issuerCode: '61', cardType: 'CREDIT' } },
    declineNextConfirm: () => fault({ kind: 'decline', code: 'PG_PROVIDER' }),
    dropNextConfirmAfterApply: () => fault({ kind: 'drop', applied: true }),
    delayNextConfirm: (ms) => fault({ kind: 'delay', ms }),
    advance: (ms) => clock.advance(ms),
    async lastWebhook(paymentRef) {
      const events = (await (await control('GET', `/sim/portone/webhooks?paymentId=${paymentRef}`)).json()) as Array<{ headers: Record<string, string>; body: string }>;
      const last = events.at(-1)!;
      return { headers: last.headers, body: last.body };
    },
    async approvals(orderId) {
      const text = await (await control('GET', '/sim/ledger')).text();
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { order_ref: string })
        .filter((r) => r.order_ref === orderId).length;
    },
    close: () => app.close(),
  };
}

pgAdapterContract('P-T16 포트원(시뮬레이터의 포트원 경로)', startHarness);

describe('P-T16 포트원 어댑터의 호출', () => {
  it('P-T16_시크릿은 PortOne 머리로만 나간다(주소·본문·다른 머리에 없다) [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-13.2.2]', async () => {
    const { seen, gateway } = scripted([paid, viewOf(), viewOf(), { status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 3_000 } } }]);
    await gateway.confirm(C);
    await gateway.query(PAYMENT_ID);
    expect(seen).toHaveLength(3);
    await gateway.cancel({ paymentRef: PAYMENT_ID, amount: 3_000, reason: '고객 요청', idemKey: `cancel-${randomUUID()}` });
    expect(seen).toHaveLength(4);
    for (const s of seen) {
      expect(s.headers.get('authorization')).toBe(`PortOne ${SECRET}`);
      expect(s.url).not.toContain(SECRET);
      expect(s.body).not.toContain(SECRET);
      for (const [name, value] of s.headers) if (name !== 'authorization') expect(value).not.toContain(SECRET);
    }
  });

  it('P-T16_승인 경로·본문: 서버 금액과 통화, 시험 표시, 결제 토큰을 싣는다 [ASVS v5.0.0-2.2.3]', async () => {
    const { seen, gateway } = scripted([paid, viewOf()]);
    await gateway.confirm(C);
    expect(`${seen[0]!.method} ${new URL(seen[0]!.url).pathname}`).toBe(`POST /payments/${PAYMENT_ID}/confirm`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ storeId: 'store-1', paymentToken: TOKEN, totalAmount: C.amount, currency: 'KRW', isTest: true });
    expect(`${seen[1]!.method} ${new URL(seen[1]!.url).pathname}${new URL(seen[1]!.url).search}`).toBe(`GET /payments/${PAYMENT_ID}?storeId=store-1`);
  });

  it('P-T16_isTest는 설정값 그대로다(운영 false) [ASVS v5.0.0-2.2.3]', async () => {
    const { seen, gateway } = scripted([paid, viewOf()], { isTest: false });
    await gateway.confirm(C);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ isTest: false });
  });

  it('P-T16_멱등키 머리는 큰따옴표로 감싼 sf-string이고 조회에는 없다 [ASVS v5.0.0-2.2.1]', async () => {
    const { seen, gateway } = scripted([paid, viewOf()]);
    await gateway.confirm(C);
    expect(seen[0]!.headers.get('idempotency-key')).toBe(`"confirm-${ORDER_ID}"`);
    expect(seen[1]!.headers.get('idempotency-key')).toBeNull();
  });

  it('P-T16_멱등키의 따옴표와 역슬래시는 sf-string 규칙으로 이스케이프한다 [ASVS v5.0.0-2.2.1]', async () => {
    const orderId = 'order"with\\quote-1';
    const { seen, gateway } = scripted([paid, viewOf({ id: `pay-${orderId}` })]);
    await gateway.confirm({ ...C, orderId, paymentRef: `pay-${orderId}`, idemKey: `confirm-${orderId}` });
    expect(seen[0]!.headers.get('idempotency-key')).toBe(`"confirm-order\\"with\\\\quote-1"`);
  });

  it.each<[string, string]>([
    ['16자 미만', 'a'.repeat(7)],
    ['256자 초과', 'a'.repeat(249)],
    ['ASCII가 아님', '주문번호주문번호주문번호'],
    ['제어 문자', 'order\nid-abcdefgh'],
  ])('P-T16_멱등키가 %s이면 보내지 않고 던진다 [ASVS v5.0.0-2.2.1]', async (_n, orderId) => {
    const { seen, gateway } = scripted([]);
    await expect(gateway.confirm({ ...C, orderId, paymentRef: `pay-${orderId}`, idemKey: `confirm-${orderId}` })).rejects.toThrow(/멱등키/);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['16자', 'a'.repeat(8)],
    ['256자', 'a'.repeat(248)],
  ])('P-T16_멱등키 %s는 받는다 [ASVS v5.0.0-2.2.1]', async (_n, orderId) => {
    const { seen, gateway } = scripted([paid, viewOf({ id: `pay-${orderId}` })]);
    await gateway.confirm({ ...C, orderId, paymentRef: `pay-${orderId}`, idemKey: `confirm-${orderId}` });
    expect(seen[0]!.headers.get('idempotency-key')).toBe(`"confirm-${orderId}"`);
  });

  it('P-T16_멱등키 형식은 confirm-{주문 ID}·cancel-{취소 ID}만 받는다(ADR-0029 결정 4)', async () => {
    const { seen, gateway } = scripted([]);
    await expect(gateway.confirm({ ...C, idemKey: 'confirm-other-order-id' })).rejects.toThrow(/멱등키/);
    await expect(gateway.cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: 'refund-0123456789abcdef' })).rejects.toThrow(/멱등키/);
    await expect(gateway.cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: 'cancel-a1' })).rejects.toThrow(/멱등키/);
    expect(seen).toHaveLength(0);
  });

  it('P-T16_결제 토큰 없이 승인하면 보내지 않고 던지며 글에 값이 없다 [ASVS v5.0.0-16.5.3]', async () => {
    const { seen, gateway } = scripted([]);
    await expect(gateway.confirm({ orderId: C.orderId, paymentRef: C.paymentRef, amount: C.amount, idemKey: C.idemKey })).rejects.toThrow(/토큰/);
    expect(seen).toHaveLength(0);
  });

  it('P-T16_결제 토큰은 승인 호출에만 실리고 뒤의 조회·취소와 객체에 남지 않는다 [ASVS v5.0.0-14.2.7] [ASVS v5.0.0-16.2.5]', async () => {
    const { seen, gateway } = scripted([paid, viewOf(), viewOf(), { status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 10_000 } } }]);
    await gateway.confirm(C);
    await gateway.query(PAYMENT_ID);
    await gateway.cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: `cancel-${randomUUID()}` });
    expect(seen.map((s) => s.body.includes(TOKEN) || s.url.includes(TOKEN))).toEqual([true, false, false, false]);
    for (const s of seen.slice(1)) for (const [, value] of s.headers) expect(value).not.toContain(TOKEN);
    for (const text of [inspect(gateway, { depth: 8, showHidden: true }), JSON.stringify(gateway)]) expect(text).not.toContain(TOKEN);
  });

  it('P-T16_리디렉션을 따라가지 않는다 [ASVS v5.0.0-15.3.2]', async () => {
    const { seen, gateway } = scripted([{ status: 302, raw: '' }]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe('manual');
  });

  it('P-T16_결제사 호출에 추적 머리를 싣지 않는다 [ASVS v5.0.0-14.2.3]', async () => {
    const { seen, gateway } = scripted([paid, viewOf()]);
    await gateway.confirm(C);
    for (const name of ['traceparent', 'tracestate', 'baggage']) expect(seen[0]!.headers.has(name)).toBe(false);
  });

  it('P-T16_객체를 로그로 찍거나 JSON으로 바꿔도 시크릿이 실리지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const gateway = gatewayOf();
    for (const text of [inspect(gateway, { depth: 8, showHidden: true }), JSON.stringify(gateway)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
  });

  it('P-T16_조회는 조회 묶음으로, 승인·취소는 승인 묶음으로 나간다 [ASVS v5.0.0-13.2.6]', async () => {
    const routed: string[] = [];
    const stub =
      (name: string, replies: Scripted[]): typeof fetch =>
      async (_input, init) => {
        routed.push(`${name} ${init?.method}`);
        return responseOf(replies.shift()!);
      };
    const gateway = gatewayOf({ fetch: stub('승인', [paid, { status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 10_000 } } }]), queryFetch: stub('조회', [viewOf(), viewOf()]) });
    await gateway.confirm(C);
    await gateway.query(PAYMENT_ID);
    await gateway.cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: `cancel-${randomUUID()}` });
    expect(routed).toEqual(['승인 POST', '조회 GET', '조회 GET', '승인 POST']);
  });
});

describe('P-T16 포트원 승인 답 읽기', () => {
  it('P-T16_승인 200은 뒤따르는 조회의 금액·시각·카드·결제 수단을 싣는다', async () => {
    await expect(scripted([paid, viewOf()]).gateway.confirm(C)).resolves.toEqual({
      outcome: 'APPROVED',
      paymentRef: PAYMENT_ID,
      amount: C.amount,
      approvedAt: '2026-11-09T01:00:00.000Z',
      card: { maskedNumber: '43301234****123*', issuerCode: 'SHINHAN', cardType: 'CREDIT' },
      method: 'CARD',
    });
  });

  it('P-T16_승인 200 뒤 조회 금액이 다르면 조회 금액을 그대로 실어 실행기가 어긋남을 잡는다 [ASVS v5.0.0-2.2.3]', async () => {
    const r = await scripted([paid, viewOf({ amount: { total: 9_000, taxFree: 0, discount: 0, paid: 9_000, cancelled: 0, cancelledTaxFree: 0 } })]).gateway.confirm(C);
    expect(r).toMatchObject({ outcome: 'APPROVED', amount: 9_000 });
  });

  it('P-T16_승인 200 뒤 조회가 가상계좌 발급이면 WAITING_FOR_DEPOSIT이다', async () => {
    await expect(scripted([paid, viewOf({ status: 'VIRTUAL_ACCOUNT_ISSUED', paidAt: undefined })]).gateway.confirm(C)).resolves.toEqual({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: PAYMENT_ID, amount: C.amount });
  });

  it.each<[string, Scripted]>([
    ['결제 ID가 다름', viewOf({ id: 'pay-other-order' })],
    ['결제 ID 없음', viewOf({ id: undefined })],
    ['승인 아닌 상태', viewOf({ status: 'READY' })],
    ['금액 없음', viewOf({ amount: undefined })],
    ['조회 실패', { status: 500, raw: '' }],
    ['조회 404', { status: 404, body: { type: 'PAYMENT_NOT_FOUND' } }],
  ])('P-T16_승인 200 뒤 조회가 %s이면 승인을 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async (_n, q) => {
    await expect(scripted([paid, q]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_승인 200 뒤 조회의 결제가 이 주문의 것이 아니면(참조와 결제 ID는 같아도) UNKNOWN이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
    const paymentRef = 'pay-0195f3a0-0000-7000-8000-00000000ffff';
    await expect(scripted([paid, viewOf({ id: paymentRef })]).gateway.confirm({ ...C, paymentRef })).resolves.toEqual({ outcome: 'UNKNOWN', paymentRef });
  });

  it.each<[string, Scripted]>([
    ['pgTxId 없음', { status: 200, body: { paidAt: '2026-11-09T01:00:00.000Z' } }],
    ['paidAt 없음', { status: 200, body: { pgTxId: 'pg-1' } }],
    ['paidAt이 시각이 아님', { status: 200, body: { pgTxId: 'pg-1', paidAt: 'yesterday' } }],
    ['JSON이 아님', { status: 200, raw: 'ok' }],
    ['빈 답', { status: 200, raw: '' }],
  ])('P-T16_승인 200의 %s이면 조회 없이 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    const { seen, gateway } = scripted([reply]);
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    expect(seen).toHaveLength(1);
  });

  it.each<[string, Scripted]>([
    ['201', { status: 201, body: { pgTxId: 'pg-1', paidAt: '2026-11-09T01:00:00.000Z' } }],
    ['202', { status: 202, body: { type: 'ACCEPTED' } }],
    ['204 빈 답', { status: 204 }],
    ['301', { status: 301, raw: '' }],
    ['302 type 있음', { status: 302, body: { type: 'MOVED' } }],
    ['408 type 있음', { status: 408, body: { type: 'REQUEST_TIMEOUT' } }],
    ['400 HTML', { status: 400, raw: '<html>bad</html>' }],
    ['401 HTML', { status: 401, raw: '<html>no</html>' }],
    ['404 type 없음', { status: 404, body: { message: '없음' } }],
    ['409 HTML', { status: 409, raw: 'conflict' }],
    ['400 JSON 배열', { status: 400, body: [{ type: 'INVALID_REQUEST' }] }],
    ['400 type 빈 글', { status: 400, body: { type: '' } }],
    ['400 type이 글이 아님', { status: 400, body: { type: 42 } }],
    ['500', { status: 500, body: { type: 'INTERNAL' } }],
    ['502 PG_PROVIDER', { status: 502, body: { type: 'PG_PROVIDER', pgCode: 'X', pgMessage: 'y' } }],
    ['503', { status: 503, raw: '' }],
    ['404 PAYMENT_NOT_FOUND', { status: 404, body: { type: 'PAYMENT_NOT_FOUND' } }],
    ['표에 없는 type', { status: 400, body: { type: 'SOMETHING_NEW' } }],
    ['객체 내장 이름 type', { status: 400, body: { type: 'constructor' } }],
  ])('P-T16_승인의 %s는 거절로 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    await expect(scripted([reply]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_연결이 끊기면 UNKNOWN이고 던지지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const gateway = gatewayOf({ fetch: (async () => Promise.reject(new TypeError('끊김'))) as typeof fetch });
    await expect(gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    await expect(gateway.query(PAYMENT_ID)).resolves.toEqual({ kind: 'UNKNOWN' });
    await expect(gateway.cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: `cancel-${randomUUID()}` })).resolves.toEqual({ outcome: 'UNKNOWN' });
  });

  it.each<[number, string, string]>([
    [400, 'INVALID_PAYMENT_TOKEN', 'VALIDATION'],
    [400, 'INVALID_REQUEST', 'VALIDATION'],
    [409, 'INFORMATION_MISMATCH', 'VALIDATION'],
    [401, 'UNAUTHORIZED', 'PG_ERROR'],
    [403, 'FORBIDDEN', 'PG_ERROR'],
  ])('P-T16_대응표: %d %s → DECLINED·%s', async (status, type, failureCategory) => {
    await expect(scripted([{ status, body: { type, message: 'x' } }]).gateway.confirm(C)).resolves.toEqual({ outcome: 'DECLINED', paymentRef: PAYMENT_ID, failureCategory, pgCode: type });
  });

  it('P-T16_대응표: 409 IDEMPOTENCY_OUTSTANDING_REQUEST → IN_PROGRESS', async () => {
    await expect(scripted([{ status: 409, body: { type: 'IDEMPOTENCY_OUTSTANDING_REQUEST' } }]).gateway.confirm(C)).resolves.toEqual({ outcome: 'IN_PROGRESS', paymentRef: PAYMENT_ID, pgCode: 'IDEMPOTENCY_OUTSTANDING_REQUEST' });
  });

  it.each<[string, Scripted]>([
    ['type 있음', { status: 429, body: { type: 'TOO_MANY_REQUESTS' } }],
    ['HTML', { status: 429, raw: 'slow down' }],
    ['빈 답', { status: 429, raw: '' }],
  ])('P-T16_승인의 429(%s)는 한도 초과다 [ASVS v5.0.0-2.3.2]', async (_n, reply) => {
    await expect(scripted([reply]).gateway.confirm(C)).resolves.toMatchObject({ outcome: 'DECLINED', failureCategory: 'THROTTLED' });
  });

  it.each(['PAID', 'PARTIAL_CANCELLED'])('P-T16_ALREADY_PAID 뒤 조회가 %s이면 조회 금액을 실어 ALREADY_APPROVED다 [ASVS v5.0.0-2.2.3]', async (status) => {
    const { seen, gateway } = scripted([alreadyPaid, viewOf({ status, amount: { total: 9_000, taxFree: 0, discount: 0, paid: 9_000, cancelled: 0, cancelledTaxFree: 0 } })]);
    await expect(gateway.confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', paymentRef: PAYMENT_ID, amount: 9_000 });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
  });

  it.each(['READY', 'PAY_PENDING', 'VIRTUAL_ACCOUNT_ISSUED', 'CANCELLED', 'FAILED', undefined])('P-T16_ALREADY_PAID 뒤 조회가 %s이면 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    await expect(scripted([alreadyPaid, viewOf({ status })]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_ALREADY_PAID 뒤 조회의 결제 ID가 다르거나 조회가 실패하면 UNKNOWN이다 [ASVS v5.0.0-2.2.3]', async () => {
    await expect(scripted([alreadyPaid, viewOf({ id: 'pay-other' })]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
    await expect(scripted([alreadyPaid, { status: 500, raw: '' }]).gateway.confirm(C)).resolves.toEqual(UNKNOWN);
  });

  it('P-T16_승인에 시간 몫을 다 썼으면 뒤따르는 조회를 보내지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const clock = fakeClock({ now: NOW_MS });
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      calls.push(String(init?.method));
      clock.advance(CONFIRM_CALL_BUDGET_MS);
      return responseOf(paid);
    };
    await expect(gatewayOf({ fetch: fetchStub, clock }).confirm(C)).resolves.toEqual(UNKNOWN);
    expect(calls).toEqual(['POST']);
  });

  it('P-T16_뒤따르는 조회는 승인에 쓴 시간을 뺀 몫까지만 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        await new Promise((r) => setTimeout(r, 120));
        return responseOf(alreadyPaid);
      }
      return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    };
    const started = performance.now();
    await expect(gatewayOf({ fetch: fetchStub, readTimeoutMs: 3_000, confirmBudgetMs: 300, clock: undefined }).confirm(C)).resolves.toEqual(UNKNOWN);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('P-T16 포트원 조회 답 읽기', () => {
  it.each<[string, string]>([
    ['READY', 'READY'],
    ['PAY_PENDING', 'IN_PROGRESS'],
    ['VIRTUAL_ACCOUNT_ISSUED', 'WAITING_FOR_DEPOSIT'],
    ['PAID', 'APPROVED'],
    ['PARTIAL_CANCELLED', 'PARTIAL_CANCELED'],
    ['CANCELLED', 'CANCELED'],
    ['FAILED', 'FAILED'],
  ])('P-T16_조회 상태 대응표: %s → %s', async (raw, status) => {
    await expect(scripted([viewOf({ status: raw })]).gateway.query(PAYMENT_ID)).resolves.toMatchObject({ kind: 'FOUND', paymentRef: PAYMENT_ID, orderRef: ORDER_ID, status });
  });

  it('P-T16_금액은 total, 남은 금액은 paid - cancelled다', async () => {
    const q = await scripted([viewOf({ status: 'PARTIAL_CANCELLED', amount: { total: 10_000, taxFree: 0, discount: 0, paid: 10_000, cancelled: 3_000, cancelledTaxFree: 0 } })]).gateway.query(PAYMENT_ID);
    expect(q).toMatchObject({ kind: 'FOUND', amount: 10_000, balanceAmount: 7_000 });
  });

  it.each<[string, string | undefined]>([
    ['PaymentMethodCard', 'CARD'],
    ['PaymentMethodEasyPay', 'EASY_PAY'],
    ['PaymentMethodTransfer', 'TRANSFER'],
    ['PaymentMethodVirtualAccount', 'OTHER'],
    ['PaymentMethodMobile', 'OTHER'],
    ['PaymentMethodGiftCertificate', 'OTHER'],
    ['PaymentMethodConvenienceStore', 'OTHER'],
    ['PaymentMethodCrypto', 'OTHER'],
    ['NewMethod', undefined],
  ])('P-T16_조회의 결제 수단 %s → %s', async (type, method) => {
    const q = await scripted([viewOf({ method: { type } })]).gateway.query(PAYMENT_ID);
    if (method) expect(q).toMatchObject({ method });
    else expect(q).not.toHaveProperty('method');
  });

  it('P-T16_기록 없음은 포트원의 정해진 코드인 404일 때뿐이다', async () => {
    await expect(scripted([{ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } }]).gateway.query(PAYMENT_ID)).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it.each<[string, Scripted]>([
    ['다른 코드의 404', { status: 404, body: { type: 'ROUTE_NOT_FOUND' } }],
    ['type 없는 404', { status: 404, body: { message: '없음' } }],
    ['HTML 404', { status: 404, raw: '<html>nginx</html>' }],
    ['5xx', { status: 503, body: { type: 'INTERNAL' } }],
    ['다른 결제 ID의 200', viewOf({ id: 'pay-other' })],
    ['결제 ID 없는 200', viewOf({ id: undefined })],
    ['pay- 접두사가 없는 결제 ID', viewOf({ id: ORDER_ID })],
    ['금액 없는 200', viewOf({ amount: undefined })],
    ['total 없는 200', viewOf({ amount: { paid: 1, cancelled: 0 } })],
    ['paid 없는 200', viewOf({ amount: { total: 1, cancelled: 0 } })],
    ['모르는 상태의 200', viewOf({ status: 'SOMETHING_NEW' })],
    ['JSON이 아닌 200', { status: 200, raw: 'ok' }],
  ])('P-T16_조회의 %s는 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    const ref = _n === 'pay- 접두사가 없는 결제 ID' ? ORDER_ID : PAYMENT_ID;
    await expect(scripted([reply]).gateway.query(ref)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it.each(['constructor', 'toString', '__proto__'])('P-T16_조회 상태가 객체 내장 이름 %s여도 모르는 상태라 UNKNOWN이다 [ASVS v5.0.0-15.3.6]', async (status) => {
    await expect(scripted([viewOf({ status })]).gateway.query(PAYMENT_ID)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  it('P-T16_조회의 429는 한도 초과 표시를 단 UNKNOWN이다 [ASVS v5.0.0-2.3.2]', async () => {
    await expect(scripted([{ status: 429, raw: '' }]).gateway.query(PAYMENT_ID)).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
  });

  it('P-T16_조회는 넘긴 시간 한도까지만 기다린다 [ASVS v5.0.0-16.5.2]', async () => {
    const fetchStub: typeof fetch = async (_input, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
    const started = performance.now();
    await expect(gatewayOf({ fetch: fetchStub, readTimeoutMs: 5_000 }).query(PAYMENT_ID, { timeoutMs: 50 })).resolves.toEqual({ kind: 'UNKNOWN' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('P-T16 포트원 취소 답 읽기', () => {
  const cancelKey = `cancel-${randomUUID()}`;
  const cancel = (gateway: PortoneGateway, amount: number | 'ALL' = 'ALL') => gateway.cancel({ paymentRef: PAYMENT_ID, amount, reason: '고객 요청', idemKey: cancelKey });

  it('P-T16_취소 경로·멱등키·본문(부분·전액)', async () => {
    const { seen, gateway } = scripted([
      { status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 2_000 } } },
      { status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 7_000 } } },
    ]);
    await expect(cancel(gateway, 2_000)).resolves.toEqual({ outcome: 'CANCELLED' });
    await expect(cancel(gateway)).resolves.toEqual({ outcome: 'CANCELLED' });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST']);
    expect(new URL(seen[0]!.url).pathname).toBe(`/payments/${PAYMENT_ID}/cancel`);
    expect(seen[0]!.headers.get('idempotency-key')).toBe(`"${cancelKey}"`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ storeId: 'store-1', reason: '고객 요청', amount: 2_000 });
    expect(JSON.parse(seen[1]!.body)).toEqual({ storeId: 'store-1', reason: '고객 요청' });
  });

  it.each<[string, Scripted, Record<string, unknown>]>([
    ['요청됨(비동기)', { status: 200, body: { cancellation: { status: 'REQUESTED', totalAmount: 10_000 } } }, { outcome: 'CANCEL_PENDING' }],
    ['취소 실패', { status: 200, body: { cancellation: { status: 'FAILED', totalAmount: 10_000 } } }, { outcome: 'REJECTED' }],
    ['모르는 상태', { status: 200, body: { cancellation: { status: 'NEW' } } }, { outcome: 'UNKNOWN' }],
    ['cancellation 없음', { status: 200, body: {} }, { outcome: 'UNKNOWN' }],
    ['처리 중', { status: 409, body: { type: 'IDEMPOTENCY_OUTSTANDING_REQUEST' } }, { outcome: 'CANCEL_PENDING', pgCode: 'IDEMPOTENCY_OUTSTANDING_REQUEST' }],
    ['이미 전액 취소', { status: 409, body: { type: 'PAYMENT_ALREADY_CANCELLED' } }, { outcome: 'CANCELLED', pgCode: 'PAYMENT_ALREADY_CANCELLED' }],
    ['결제 안 됨', { status: 409, body: { type: 'PAYMENT_NOT_PAID' } }, { outcome: 'REJECTED', pgCode: 'PAYMENT_NOT_PAID' }],
    ['금액 초과', { status: 409, body: { type: 'CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT' } }, { outcome: 'REJECTED', pgCode: 'CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT' }],
    ['횟수 초과', { status: 400, body: { type: 'MAX_CANCEL_COUNT_REACHED' } }, { outcome: 'REJECTED', pgCode: 'MAX_CANCEL_COUNT_REACHED' }],
    ['틀린 요청', { status: 400, body: { type: 'INVALID_REQUEST' } }, { outcome: 'REJECTED', pgCode: 'INVALID_REQUEST' }],
    ['인증 실패', { status: 401, body: { type: 'UNAUTHORIZED' } }, { outcome: 'REJECTED', pgCode: 'UNAUTHORIZED' }],
    ['거부', { status: 403, body: { type: 'FORBIDDEN' } }, { outcome: 'REJECTED', pgCode: 'FORBIDDEN' }],
  ])('P-T16_취소 대응표: %s', async (_n, reply, want) => {
    await expect(cancel(scripted([reply]).gateway)).resolves.toEqual(want);
  });

  it('P-T16_부분 취소가 이미 전액 취소됐다는 답을 받으면 REJECTED다', async () => {
    await expect(cancel(scripted([{ status: 409, body: { type: 'PAYMENT_ALREADY_CANCELLED' } }]).gateway, 1_000)).resolves.toEqual({ outcome: 'REJECTED', pgCode: 'PAYMENT_ALREADY_CANCELLED' });
  });

  it.each<[string, Scripted]>([
    ['type 없는 400', { status: 400, raw: 'x' }],
    ['type 없는 409', { status: 409, raw: 'conflict' }],
    ['201', { status: 201, body: { cancellation: { status: 'SUCCEEDED', totalAmount: 1 } } }],
    ['204 빈 답', { status: 204 }],
    ['301', { status: 301, raw: '' }],
    ['408 type 있음', { status: 408, body: { type: 'REQUEST_TIMEOUT' } }],
    ['429', { status: 429, raw: '' }],
    ['500', { status: 500, raw: '' }],
    ['502 PG_PROVIDER', { status: 502, body: { type: 'PG_PROVIDER' } }],
    ['404 PAYMENT_NOT_FOUND', { status: 404, body: { type: 'PAYMENT_NOT_FOUND' } }],
    ['표에 없는 type', { status: 400, body: { type: 'SOMETHING_NEW' } }],
  ])('P-T16_취소의 %s는 거절로 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async (_n, reply) => {
    await expect(cancel(scripted([reply]).gateway)).resolves.toEqual({ outcome: 'UNKNOWN' });
  });
});

describe('P-T16 P-T17 포트원 웹훅 서명(Standard Webhooks)', () => {
  const nowSec = Math.floor(NOW_MS / 1000);
  const body = JSON.stringify({ type: 'Transaction.Paid', timestamp: '2026-11-09T01:00:00.000Z', data: { storeId: 'store-1', paymentId: PAYMENT_ID, transactionId: 'tx-1' } });
  const sign = (id: string, ts: number, b: string, key: Buffer = WEBHOOK_KEY): string => `v1,${createHmac('sha256', key).update(`${id}.${ts}.${b}`).digest('base64')}`;
  const headersOf = (over: Record<string, string> = {}, ts = nowSec, b = body): Record<string, string> => ({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sign('msg_1', ts, b), ...over });

  it('P-T16_서명이 맞으면 webhook-id를 중복 제거 키로 쓰고 상태를 싣지 않는다 [ASVS v5.0.0-11.2.3]', () => {
    expect(gatewayOf().parseWebhook(headersOf(), body)).toEqual({ kind: 'TRIGGER', dedupKey: 'PORTONE:msg_1', paymentRef: PAYMENT_ID, orderRef: ORDER_ID });
  });

  it('P-T16_머리 이름의 대소문자는 가리지 않는다', () => {
    const h = headersOf();
    expect(gatewayOf().parseWebhook({ 'Webhook-Id': h['webhook-id'], 'Webhook-Timestamp': h['webhook-timestamp'], 'Webhook-Signature': h['webhook-signature'] }, body)).toMatchObject({ dedupKey: 'PORTONE:msg_1' });
  });

  it('P-T16_재전송: 시각만 바뀐 같은 webhook-id는 같은 중복 제거 키다 [ASVS v5.0.0-11.2.3]', () => {
    const later = nowSec + 60;
    const a = gatewayOf().parseWebhook(headersOf(), body);
    const b = gatewayOf().parseWebhook(headersOf({}, later), body);
    expect(a.kind).toBe('TRIGGER');
    expect(b).toEqual(a);
  });

  it('P-T16_시크릿이 둘이면 옛 시크릿의 서명도 받는다(무중단 교체)', () => {
    const gateway = gatewayOf({ webhookSecrets: [WEBHOOK_SECRET, OLD_WEBHOOK_SECRET] });
    expect(gateway.parseWebhook(headersOf({ 'webhook-signature': sign('msg_1', nowSec, body, OLD_WEBHOOK_KEY) }), body)).toMatchObject({ kind: 'TRIGGER' });
    expect(gateway.parseWebhook(headersOf({ 'webhook-signature': `v1a,xxx v1,${sign('msg_1', nowSec, body).slice(3)}` }), body)).toMatchObject({ kind: 'TRIGGER' });
  });

  it.each<[string, () => Parameters<PortoneGateway['parseWebhook']>]>([
    ['서명이 틀림', () => [headersOf({ 'webhook-signature': `v1,${Buffer.from('x').toString('base64')}` }), body]],
    ['다른 시크릿의 서명', () => [headersOf({ 'webhook-signature': sign('msg_1', nowSec, body, randomBytes(32)) }), body]],
    ['본문이 바뀜', () => [headersOf(), body.replace('tx-1', 'tx-2')]],
    ['다른 webhook-id', () => [headersOf({ 'webhook-id': 'msg_2' }), body]],
    ['webhook-id 없음', () => [{ 'webhook-timestamp': String(nowSec), 'webhook-signature': sign('msg_1', nowSec, body) }, body]],
    ['webhook-timestamp 없음', () => [{ 'webhook-id': 'msg_1', 'webhook-signature': sign('msg_1', nowSec, body) }, body]],
    ['webhook-signature 없음', () => [{ 'webhook-id': 'msg_1', 'webhook-timestamp': String(nowSec) }, body]],
    ['v1 서명이 없음', () => [headersOf({ 'webhook-signature': 'v2,abc' }), body]],
    ['여러 값 머리', () => [{ ...headersOf(), 'webhook-id': ['a', 'b'] }, body]],
    ['시각이 숫자가 아님', () => [headersOf({ 'webhook-timestamp': 'abc' }), body]],
    ['JSON이 아님', () => [headersOf({}, nowSec, '{'), '{']],
    ['null 본문', () => [headersOf({}, nowSec, 'null'), 'null']],
  ])('P-T17_%s이면 거절이다 [ASVS v5.0.0-16.5.3]', (_n, args) => {
    expect(gatewayOf().parseWebhook(...args())).toMatchObject({ kind: 'INVALID' });
  });

  it('P-T17_webhook-id가 200자를 넘으면 거절이다 [ASVS v5.0.0-2.2.1]', () => {
    const id = 'x'.repeat(201);
    expect(gatewayOf().parseWebhook(headersOf({ 'webhook-id': id, 'webhook-signature': sign(id, nowSec, body) }), body)).toMatchObject({ kind: 'INVALID', reason: 'HEADER' });
  });

  it.each([
    ['5분 지남', nowSec - 300 - 1],
    ['5분 앞', nowSec + 300 + 1],
  ])('P-T17_시각이 %s면 거절이다(시각 허용 폭 5분) [ASVS v5.0.0-16.5.3]', (_n, ts) => {
    expect(gatewayOf().parseWebhook(headersOf({}, ts), body)).toMatchObject({ kind: 'INVALID', reason: 'TIMESTAMP' });
  });

  it.each([
    ['5분 전 경계', nowSec - 300],
    ['5분 뒤 경계', nowSec + 300],
  ])('P-T17_시각이 %s이면 받는다', (_n, ts) => {
    expect(gatewayOf().parseWebhook(headersOf({}, ts), body)).toMatchObject({ kind: 'TRIGGER' });
  });

  const signedBody = (over: unknown): [Record<string, string>, string] => {
    const b = JSON.stringify(over);
    return [headersOf({}, nowSec, b), b];
  };

  it.each(['Transaction.Paid', 'Transaction.VirtualAccountIssued', 'Transaction.PartialCancelled', 'Transaction.Cancelled', 'Transaction.Failed', 'Transaction.PayPending', 'Transaction.CancelPending'])('P-T17_결제 사건 %s는 받는다', (type) => {
    expect(gatewayOf().parseWebhook(...signedBody({ type, data: { paymentId: PAYMENT_ID } }))).toMatchObject({ paymentRef: PAYMENT_ID });
  });

  it.each(['Transaction.Ready', 'Transaction.DisputeCreated', 'BillingKey.Issued', 'Something.New', undefined])('P-T17_결제 사건이 아닌 %s는 거절이 아니라 무시다 [ASVS v5.0.0-16.5.3]', (type) => {
    expect(gatewayOf().parseWebhook(...signedBody({ type, data: { paymentId: PAYMENT_ID } }))).toEqual({ kind: 'IGNORED' });
  });

  it.each<[string, unknown]>([
    ['paymentId 없음', { type: 'Transaction.Paid', data: {} }],
    ['paymentId가 글이 아님', { type: 'Transaction.Paid', data: { paymentId: 1 } }],
    ['paymentId가 ASCII가 아님', { type: 'Transaction.Paid', data: { paymentId: '결제' } }],
    ['paymentId에 줄바꿈', { type: 'Transaction.Paid', data: { paymentId: 'pay-1\n2' } }],
    ['paymentId가 200자를 넘음', { type: 'Transaction.Paid', data: { paymentId: 'x'.repeat(201) } }],
    ['data 없음', { type: 'Transaction.Paid' }],
  ])('P-T17_%s이면 거절이다 [ASVS v5.0.0-2.2.1]', (_n, payload) => {
    expect(gatewayOf().parseWebhook(...signedBody(payload))).toMatchObject({ kind: 'INVALID', reason: 'BODY' });
  });

  it('P-T16_pay- 접두사가 없는 paymentId면 주문 ID를 싣지 않는다', () => {
    expect(gatewayOf().parseWebhook(...signedBody({ type: 'Transaction.Paid', data: { paymentId: 'other-ref' } }))).toEqual({ kind: 'TRIGGER', dedupKey: 'PORTONE:msg_1', paymentRef: 'other-ref' });
  });

  it('P-T17_웹훅 시크릿이 없으면 어떤 웹훅도 받지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(gatewayOf({ webhookSecrets: [] }).parseWebhook(headersOf(), body)).toMatchObject({ kind: 'INVALID', reason: 'NO_SECRET' });
  });
});

describe('P-T16 포트원 어댑터만의 것', () => {
  it('P-T16_결제사 이름은 PORTONE이다', () => {
    expect(gatewayOf().pg).toBe('PORTONE');
  });

  it('P-T16_능력 플래그(payment §2.1, ADR-0036)', () => {
    expect(gatewayOf().capabilities()).toEqual({
      serverConfirm: true,
      confirmDeadlineMs: 600_000,
      partialCancel: true,
      webhookSignature: true,
      idempotencyRetentionMs: 3 * 3_600_000,
      callsPerSecond: 50,
      redirectCheckout: true,
      confirmCallCost: 2,
    });
  });

  it('P-T16_결제창 값은 portone 칸이고 paymentId는 pay-{주문 ID}다', () => {
    expect(port().checkout({ orderId: ORDER_ID, orderName: '티켓', amount: 1_000 }, ATTEMPT, 'CARD')).toEqual({
      portone: { storeId: 'store-1', channelKey: 'channel-1', paymentId: PAYMENT_ID, orderName: '티켓', totalAmount: 1_000, currency: 'KRW', redirectUrl: ATTEMPT.successUrl },
    });
  });

  it('P-T16_결제 금액은 양의 정수여야 한다 [ASVS v5.0.0-2.2.3]', () => {
    for (const amount of [0, -1, 1.5, Number.NaN]) expect(() => port().checkout({ orderId: ORDER_ID, orderName: '티켓', amount }, ATTEMPT, 'CARD')).toThrow(/금액/);
  });
});

describe('P-T16 리뷰 고침(BUILD_ORDER HOT-140 코드 리뷰)', () => {
  const TX = 'tx-attempt-1';
  const OTHER_TX = 'tx-attempt-2';
  const succeeded = (totalAmount: number): Scripted => ({ status: 200, body: { cancellation: { status: 'SUCCEEDED', totalAmount } } });
  const partial = viewOf({ status: 'PARTIAL_CANCELLED', amount: { total: 10_000, taxFree: 0, discount: 0, paid: 10_000, cancelled: 3_000, cancelledTaxFree: 0 } });
  const input = (over: Record<string, unknown> = {}) => ({ paymentRef: PAYMENT_ID, amount: 2_000 as number | 'ALL', reason: '고객 요청', idemKey: `cancel-${randomUUID()}`, ...over });

  /** 방법마다 답을 따로 정한다(남은 GET 답이 하나면 그 답을 되풀이한다) */
  function byMethod(replies: { GET?: Scripted[]; POST: Scripted[] }, seen: Seen[] = []): typeof fetch {
    return async (input, init) => {
      const method = String(init?.method);
      seen.push({ method, url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? ''), redirect: init?.redirect });
      const list = method === 'GET' ? replies.GET : replies.POST;
      const next = list && list.length > 1 ? list.shift() : list?.[0];
      if (!next) throw new Error('답을 더 정하지 않았다');
      return responseOf(next);
    };
  }
  const methodGateway = (replies: { GET?: Scripted[]; POST: Scripted[] }, o: Partial<PortoneGatewayOptions> = {}) => {
    const seen: Seen[] = [];
    return { seen, gateway: gatewayOf({ fetch: byMethod(replies, seen), ...o }) };
  };
  const posts = (seen: Seen[]) => seen.filter((s) => s.method === 'POST');

  describe('H1·H2 취소의 잔액 검증값', () => {
    it('P-T16_리뷰 고침 H1: 취소는 미리 조회하지 않고 바로 보낸다 [ASVS v5.0.0-2.2.3]', async () => {
      const { seen, gateway } = methodGateway({ GET: [viewOf()], POST: [succeeded(2_000)] });
      await gateway.cancel(input());
      expect(seen.map((s) => s.method)).toEqual(['POST']);
    });

    it('P-T16_리뷰 고침 H1: 호출자가 준 기대 잔액을 currentCancellableAmount로 그대로 보낸다 [ASVS v5.0.0-2.2.3]', async () => {
      const { seen, gateway } = methodGateway({ GET: [viewOf()], POST: [succeeded(2_000)] });
      await gateway.cancel(input({ expectedBalance: 7_000 }));
      expect(JSON.parse(posts(seen)[0]!.body)).toEqual({ storeId: 'store-1', reason: '고객 요청', amount: 2_000, currentCancellableAmount: 7_000 });
    });

    it('P-T16_리뷰 고침 H1: 기대 잔액이 없으면 그 칸을 보내지 않는다 [ASVS v5.0.0-2.2.3]', async () => {
      const { seen, gateway } = methodGateway({ GET: [viewOf()], POST: [succeeded(2_000)] });
      await gateway.cancel(input());
      expect(JSON.parse(posts(seen)[0]!.body)).toEqual({ storeId: 'store-1', reason: '고객 요청', amount: 2_000 });
    });

    it('P-T16_리뷰 고침 H1: 재시도는 사이에 잔액이 바뀌어도 첫 전송과 같은 본문이다(같은 멱등키의 다른 본문을 만들지 않는다) [ASVS v5.0.0-2.2.1]', async () => {
      const { seen, gateway } = methodGateway({ GET: [viewOf(), partial], POST: [{ status: 500, raw: '' }, succeeded(2_000)] });
      const c = input({ expectedBalance: 10_000 });
      await expect(gateway.cancel(c)).resolves.toEqual({ outcome: 'UNKNOWN' });
      await gateway.cancel(c);
      const [first, second] = posts(seen);
      expect(second!.body).toBe(first!.body);
      expect(JSON.parse(first!.body)).toMatchObject({ currentCancellableAmount: 10_000 });
    });

    it('P-T16_리뷰 고침 H2: 답에 없는 남은 금액을 만들지 않는다(공식 스키마의 취소 답에는 남은 금액 칸이 없다) [ASVS v5.0.0-16.5.3]', async () => {
      const { gateway } = methodGateway({ GET: [partial], POST: [succeeded(2_000)] });
      await expect(gateway.cancel(input({ expectedBalance: 7_000 }))).resolves.toEqual({ outcome: 'CANCELLED' });
    });

    it('P-T16_리뷰 고침 H2: 이미 취소됨 코드는 조회 없이 대응표로 CANCELLED이고 남은 금액을 만들지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
      const { seen, gateway } = methodGateway({ GET: [viewOf({ status: 'CANCELLED' })], POST: [{ status: 409, body: { type: 'PAYMENT_ALREADY_CANCELLED' } }] });
      await expect(gateway.cancel(input({ amount: 'ALL' }))).resolves.toEqual({ outcome: 'CANCELLED', pgCode: 'PAYMENT_ALREADY_CANCELLED' });
      expect(seen.map((s) => s.method)).toEqual(['POST']);
    });
  });

  describe('H4 결제 시도 묶기', () => {
    it('P-T16_리뷰 고침 H4: 원장의 결제 시도 ID를 승인 본문의 txId 검증값으로 싣는다 [ASVS v5.0.0-2.2.3]', async () => {
      const { seen, gateway } = scripted([paid, viewOf({ transactionId: TX })]);
      await gateway.confirm({ ...C, txId: TX });
      expect(JSON.parse(seen[0]!.body)).toEqual({ storeId: 'store-1', paymentToken: TOKEN, txId: TX, totalAmount: C.amount, currency: 'KRW', isTest: true });
    });

    it('P-T16_리뷰 고침 H4: 조회 답의 결제 시도가 원장과 다르면 다른 시도의 상태라 UNKNOWN이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
      await expect(scripted([viewOf({ transactionId: OTHER_TX })]).gateway.query(PAYMENT_ID, { expectedTxId: TX })).resolves.toEqual({ kind: 'UNKNOWN' });
    });

    it('P-T16_리뷰 고침 H4: 대조값이 있는데 답에 결제 시도 ID가 없으면 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async () => {
      await expect(scripted([viewOf()]).gateway.query(PAYMENT_ID, { expectedTxId: TX })).resolves.toEqual({ kind: 'UNKNOWN' });
    });

    it('P-T16_리뷰 고침 H4: 결제 시도가 같으면 그대로 읽는다', async () => {
      await expect(scripted([viewOf({ transactionId: TX })]).gateway.query(PAYMENT_ID, { expectedTxId: TX })).resolves.toMatchObject({ kind: 'FOUND', status: 'APPROVED' });
    });

    it('P-T16_리뷰 고침 H4: 대조값이 없으면 결제 시도를 보지 않는다(기존 호출의 동작 불변)', async () => {
      await expect(scripted([viewOf({ transactionId: OTHER_TX })]).gateway.query(PAYMENT_ID)).resolves.toMatchObject({ kind: 'FOUND' });
    });

    it('P-T16_리뷰 고침 H4: 승인 200 뒤 조회가 다른 시도의 상태면 승인을 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
      await expect(scripted([paid, viewOf({ transactionId: OTHER_TX })]).gateway.confirm({ ...C, txId: TX })).resolves.toEqual(UNKNOWN);
    });

    it('P-T16_리뷰 고침 H4: ALREADY_PAID 뒤 조회가 다른 시도의 상태면 UNKNOWN이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
      await expect(scripted([alreadyPaid, viewOf({ transactionId: OTHER_TX })]).gateway.confirm({ ...C, txId: TX })).resolves.toEqual(UNKNOWN);
    });
  });

  describe('M5 승인 뒤따르는 조회', () => {
    it('P-T16_리뷰 고침 M5: 뒤따르는 조회의 시간 상한은 10초 [가정]다', () => {
      expect(PORTONE_FOLLOW_UP_TIMEOUT_MS).toBe(10_000);
    });

    it('P-T16_리뷰 고침 M5: 승인 200 뒤 조회는 읽기 한도와 시간 몫이 넉넉해도 상한에서 끊고 조회 묶음으로 나가며 UNKNOWN이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-13.2.6]', async () => {
      const routed: string[] = [];
      const confirmFetch: typeof fetch = async (_input, init) => {
        routed.push(`승인 ${init?.method}`);
        return responseOf(paid);
      };
      const queryFetch: typeof fetch = async (_input, init) => {
        routed.push(`조회 ${init?.method}`);
        return new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('시간 초과'))));
      };
      const started = performance.now();
      await expect(gatewayOf({ fetch: confirmFetch, queryFetch, readTimeoutMs: 3_000, confirmBudgetMs: 4_000, followUpTimeoutMs: 50, clock: undefined }).confirm(C)).resolves.toEqual(UNKNOWN);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(routed).toEqual(['승인 POST', '조회 GET']);
    });
  });

  it('P-T16_리뷰 고침 M6: 포트원 승인은 뒤따르는 조회까지 토큰 2개로 센다 [ASVS v5.0.0-2.3.2]', () => {
    expect(gatewayOf().capabilities().confirmCallCost).toBe(2);
  });

  it('P-T16_리뷰 고침 M7: 남은 금액 어긋남은 앞선 취소가 반영됐을 수 있어 거절로 단정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async () => {
    const { gateway } = methodGateway({ GET: [viewOf()], POST: [{ status: 409, body: { type: 'CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN' } }] });
    await expect(gateway.cancel(input({ expectedBalance: 7_000 }))).resolves.toEqual({ outcome: 'UNKNOWN' });
  });

  it('P-T16_리뷰 고침 M8: 결제창 값에 통화 KRW를 싣는다', () => {
    const v = port().checkout({ orderId: ORDER_ID, orderName: '티켓', amount: 1_000 }, ATTEMPT, 'CARD');
    expect(v).toMatchObject({ portone: { currency: 'KRW' } });
  });

  describe('낮음: 웹훅 시크릿 시작 검사', () => {
    const base64Of = (bytes: number) => randomBytes(bytes).toString('base64');
    it.each<[string, () => string]>([
      ['whsec_ 접두사 없음', () => base64Of(32)],
      ['base64가 아닌 글자', () => 'whsec_!!!!not-base64!!!!not-base64!!!!'],
      ['URL-safe 글자', () => `whsec_${randomBytes(32).toString('base64url').padEnd(44, 'A').replace(/^./, '-')}`],
      ['덧붙이기(=) 누락', () => `whsec_${base64Of(32).replace(/=+$/, '')}`],
      ['너무 짧음(16바이트)', () => `whsec_${base64Of(16)}`],
    ])('P-T16_리뷰 고침 낮음: 웹훅 시크릿이 %s이면 시작하지 않고 글에 값이 없다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.2.5]', (_n, make) => {
      const bad = make();
      let message = '';
      expect(() => {
        try {
          gatewayOf({ webhookSecrets: [bad] });
        } catch (e) {
          message = String(e);
          throw e;
        }
      }).toThrow(/웹훅 시크릿/);
      expect(message).not.toContain(bad);
    });

    it('P-T16_리뷰 고침 낮음: 옛 시크릿도 같은 검사를 받는다 [ASVS v5.0.0-16.5.3]', () => {
      expect(() => gatewayOf({ webhookSecrets: [WEBHOOK_SECRET, 'not-a-secret'] })).toThrow(/웹훅 시크릿/);
    });

    it('P-T16_리뷰 고침 낮음: whsec_ + 표준 base64 24바이트는 받는다', () => {
      expect(() => gatewayOf({ webhookSecrets: [`whsec_${base64Of(24)}`] })).not.toThrow();
    });
  });
});
