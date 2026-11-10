// PG 시뮬레이터의 포트원 모양(BUILD_ORDER HOT-140, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
// 토스 모양 경로의 시험은 simulator.test.ts 그대로다. 같은 원장·같은 장애 넣기를 포트원의 경로·오류 코드로 보인다.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulatorApp, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const WEBHOOK_KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString('base64')}`;
const PORTONE = { authorization: `PortOne ${KEY}` };
const BASIC = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const ORDER = '0195f3a0-0000-7000-8000-000000000001';
const PAYMENT_ID = `pay-${ORDER}`;
const START = Date.parse('2026-11-02T01:00:00.000Z');
const idem = (k: string) => ({ 'idempotency-key': `"${k}"` });

const apps: SimulatorApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function make(sleep: (ms: number) => Promise<void> = async () => {}) {
  let t = START;
  const app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => t }, sleep, seed: 7, confirmLatency: { kind: 'none' }, portoneWebhookSecret: WEBHOOK_SECRET });
  apps.push(app);
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = PORTONE) => {
    const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: r.statusCode, body: r.body ? parse(r.body) : undefined, raw: r.body };
  };
  const authenticate = async (orderId = ORDER, amount = 10_000) => {
    const r = await call('POST', '/sim/portone/authenticate', { orderId, amount, orderName: '공연 티켓 2매' }, BASIC);
    expect(r.status).toBe(200);
    return r.body as { paymentId: string; paymentToken: string; txId: string };
  };
  const confirm = (a: { paymentId: string; paymentToken: string }, over: Record<string, unknown> = {}, key = `confirm-${ORDER}`) =>
    call('POST', `/payments/${a.paymentId}/confirm`, { paymentToken: a.paymentToken, totalAmount: 10_000, currency: 'KRW', isTest: true, storeId: 'store-sim', ...over }, { ...PORTONE, ...idem(key) });
  const cancel = (paymentId: string, body: Record<string, unknown>, key: string) => call('POST', `/payments/${paymentId}/cancel`, body, { ...PORTONE, ...idem(key) });
  const fault = (f: Record<string, unknown>) => call('POST', '/sim/faults', f, BASIC);
  const ledger = async () => (await call('GET', '/sim/ledger', undefined, BASIC)).raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { app, advance: (ms: number) => void (t += ms), call, authenticate, confirm, cancel, fault, ledger };
}

describe('포트원 인증과 멱등 머리', () => {
  it('포트원 경로는 PortOne 머리만 받고 틀리면 401 UNAUTHORIZED다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect((await s.call('GET', `/payments/${a.paymentId}`, undefined, BASIC)).status).toBe(401);
    const bad = await s.call('GET', `/payments/${a.paymentId}`, undefined, { authorization: 'PortOne sim_sk_other_0123456789abcdef' });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ type: 'UNAUTHORIZED' });
    expect((await s.call('GET', `/payments/${a.paymentId}`)).status).toBe(200);
  });

  it('토스 모양 경로는 그대로 Basic만 받는다', async () => {
    const s = make();
    expect((await s.call('GET', '/v1/payments/nope', undefined, PORTONE)).status).toBe(401);
  });

  it.each<[string, string]>([
    ['따옴표 없음', `confirm-${ORDER}`],
    ['16자 미만', '"short"'],
    ['256자 초과', `"${'a'.repeat(257)}"`],
    ['ASCII가 아님', '"주문번호주문번호주문번호"'],
  ])('멱등키 머리가 %s이면 400 INVALID_REQUEST이고 처리하지 않는다', async (_n, header) => {
    const s = make();
    const a = await s.authenticate();
    const r = await s.call('POST', `/payments/${a.paymentId}/confirm`, { paymentToken: a.paymentToken, totalAmount: 10_000, currency: 'KRW', isTest: true }, { ...PORTONE, 'idempotency-key': header });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ type: 'INVALID_REQUEST' });
    expect(await s.ledger()).toEqual([]);
  });
});

describe('포트원 승인', () => {
  it('정상 승인은 pgTxId·paidAt만 답하고 조회는 PAID다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect(a.paymentId).toBe(PAYMENT_ID);
    const r = await s.confirm(a);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body as object).sort()).toEqual(['paidAt', 'pgTxId']);
    const q = await s.call('GET', `/payments/${a.paymentId}?storeId=store-sim`);
    expect(q.body).toMatchObject({ status: 'PAID', id: PAYMENT_ID, amount: { total: 10_000, paid: 10_000, cancelled: 0 }, method: { type: 'PaymentMethodCard' } });
    expect((await s.ledger()).length).toBe(1);
  });

  it('토큰이 틀리면 400 INVALID_PAYMENT_TOKEN이고 결제는 그대로다', async () => {
    const s = make();
    const a = await s.authenticate();
    const r = await s.confirm({ ...a, paymentToken: 'wrong-token' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ type: 'INVALID_PAYMENT_TOKEN' });
    expect((await s.confirm(a, {}, 'confirm-second-key-0001')).status).toBe(200);
  });

  it('금액·통화·시험 여부가 다르면 409 INFORMATION_MISMATCH다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect(await s.confirm(a, { totalAmount: 9_000 }, 'confirm-key-amount-0001')).toMatchObject({ status: 409, body: { type: 'INFORMATION_MISMATCH' } });
    expect(await s.confirm(a, { currency: 'USD' }, 'confirm-key-currency-01')).toMatchObject({ status: 409, body: { type: 'INFORMATION_MISMATCH' } });
    expect(await s.confirm(a, { isTest: false }, 'confirm-key-istest-0001')).toMatchObject({ status: 409, body: { type: 'INFORMATION_MISMATCH' } });
  });

  it('P-T16_리뷰 고침 H3: 승인 기한이 지나면 400 INVALID_PAYMENT_TOKEN이고 조회는 READY를 유지한다(공식 상태에 만료가 없다)', async () => {
    const s = make();
    const a = await s.authenticate();
    s.advance(10 * 60_000 + 1_000);
    expect(await s.confirm(a)).toMatchObject({ status: 400, body: { type: 'INVALID_PAYMENT_TOKEN' } });
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'READY' });
  });

  it('P-T16_리뷰 고침 H3: 승인 기한이 지나도 Transaction.Failed 웹훅을 내지 않는다', async () => {
    const s = make();
    const a = await s.authenticate();
    s.advance(10 * 60_000 + 1_000);
    await s.call('GET', `/payments/${a.paymentId}`);
    expect((await s.call('GET', `/sim/portone/webhooks?paymentId=${a.paymentId}`, undefined, BASIC)).body).toEqual([]);
  });

  it('없는 결제는 404 PAYMENT_NOT_FOUND다', async () => {
    const s = make();
    expect(await s.confirm({ paymentId: 'pay-nope', paymentToken: 't' })).toMatchObject({ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } });
    expect(await s.call('GET', '/payments/pay-nope')).toMatchObject({ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } });
  });

  it('같은 멱등키는 같은 답, 처리 중이면 409 IDEMPOTENCY_OUTSTANDING_REQUEST다', async () => {
    const waiting: Array<() => void> = [];
    const s = make((ms) => (ms > 0 ? new Promise<void>((r) => waiting.push(r)) : Promise.resolve()));
    const a = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'delay', ms: 100, times: 1 });
    const first = s.confirm(a);
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.confirm(a)).toMatchObject({ status: 409, body: { type: 'IDEMPOTENCY_OUTSTANDING_REQUEST' } });
    waiting.splice(0).forEach((r) => r());
    const ok = await first;
    expect(ok.status).toBe(200);
    expect((await s.confirm(a)).raw).toBe(ok.raw);
  });

  it('멱등키는 3시간 보관하고, 지나면 다시 처리해 409 ALREADY_PAID다', async () => {
    const s = make();
    const a = await s.authenticate();
    const ok = await s.confirm(a);
    s.advance(3 * 3_600_000);
    expect((await s.confirm(a)).raw).toBe(ok.raw);
    s.advance(1);
    expect(await s.confirm(a)).toMatchObject({ status: 409, body: { type: 'ALREADY_PAID' } });
    expect((await s.ledger()).length).toBe(1);
  });

  it('같은 paymentId로 다시 인증할 수 있고 성공은 한 번이다', async () => {
    const s = make();
    await s.authenticate();
    const a = await s.authenticate();
    expect((await s.confirm(a)).status).toBe(200);
    const again = await s.call('POST', '/sim/portone/authenticate', { orderId: ORDER, amount: 10_000 }, BASIC);
    expect(again).toMatchObject({ status: 409, body: { type: 'ALREADY_PAID' } });
    expect((await s.ledger()).length).toBe(1);
  });
});

describe('포트원 취소', () => {
  it('남은 금액 안에서 부분·전액 취소하고 조회가 따라온다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.confirm(a);
    const p = await s.cancel(a.paymentId, { reason: '고객 요청', amount: 3_000, currentCancellableAmount: 10_000 }, 'cancel-c1-0123456789');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ cancellation: { status: 'SUCCEEDED', totalAmount: 3_000, reason: '고객 요청' } });
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'PARTIAL_CANCELLED', amount: { paid: 10_000, cancelled: 3_000 } });
    const all = await s.cancel(a.paymentId, { reason: '회차 취소', currentCancellableAmount: 7_000 }, 'cancel-c2-0123456789');
    expect(all.body).toMatchObject({ cancellation: { status: 'SUCCEEDED', totalAmount: 7_000 } });
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'CANCELLED', amount: { cancelled: 10_000 } });
  });

  it('남은 금액 검증값이 다르면 409 CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN이고 취소하지 않는다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.confirm(a);
    expect(await s.cancel(a.paymentId, { reason: 'x', currentCancellableAmount: 9_999 }, 'cancel-c3-0123456789')).toMatchObject({ status: 409, body: { type: 'CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN' } });
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'PAID' });
  });

  it('금액 초과·미결제·이미 취소는 정해진 409다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect(await s.cancel(a.paymentId, { reason: 'x' }, 'cancel-c4-0123456789')).toMatchObject({ status: 409, body: { type: 'PAYMENT_NOT_PAID' } });
    await s.confirm(a);
    expect(await s.cancel(a.paymentId, { reason: 'x', amount: 10_001 }, 'cancel-c5-0123456789')).toMatchObject({ status: 409, body: { type: 'CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT' } });
    expect((await s.cancel(a.paymentId, { reason: 'x' }, 'cancel-c6-0123456789')).status).toBe(200);
    expect(await s.cancel(a.paymentId, { reason: 'x' }, 'cancel-c7-0123456789')).toMatchObject({ status: 409, body: { type: 'PAYMENT_ALREADY_CANCELLED' } });
  });

  it('사유가 없으면 400 INVALID_REQUEST다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.confirm(a);
    expect(await s.cancel(a.paymentId, {}, 'cancel-c8-0123456789')).toMatchObject({ status: 400, body: { type: 'INVALID_REQUEST' } });
  });
});

describe('P-T16 리뷰 고침(BUILD_ORDER HOT-140 코드 리뷰)', () => {
  it('P-T16_리뷰 고침 H1: 같은 멱등키에 기대 잔액이 다른 취소는 다른 요청이라 422다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.confirm(a);
    expect((await s.cancel(a.paymentId, { reason: 'x', amount: 1_000, currentCancellableAmount: 10_000 }, 'cancel-idem-0123456789')).status).toBe(200);
    expect((await s.cancel(a.paymentId, { reason: 'x', amount: 1_000, currentCancellableAmount: 9_000 }, 'cancel-idem-0123456789')).status).toBe(422);
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ amount: { cancelled: 1_000 } });
  });

  it('P-T16_리뷰 고침 H4: 승인 본문의 결제 시도 ID가 다르면 409 INFORMATION_MISMATCH이고 승인하지 않는다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect(await s.confirm(a, { txId: 'tx-other-attempt' }, 'confirm-key-txid-000001')).toMatchObject({ status: 409, body: { type: 'INFORMATION_MISMATCH' } });
    expect(await s.ledger()).toEqual([]);
  });

  it('P-T16_리뷰 고침 H4: 다시 인증한 뒤에는 앞 시도의 결제 시도 ID로 승인할 수 없다', async () => {
    const s = make();
    const first = await s.authenticate();
    const second = await s.authenticate();
    expect(await s.confirm(second, { txId: first.txId }, 'confirm-key-txid-000002')).toMatchObject({ status: 409, body: { type: 'INFORMATION_MISMATCH' } });
    expect((await s.confirm(second, { txId: second.txId }, 'confirm-key-txid-000003')).status).toBe(200);
  });

  it('P-T16_리뷰 고침 H4: 같은 멱등키에 결제 시도 ID가 다른 승인은 다른 요청이라 422다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect((await s.confirm(a, { txId: a.txId })).status).toBe(200);
    expect((await s.confirm(a, { txId: 'tx-other-attempt' })).status).toBe(422);
  });

  it('P-T16_리뷰 고침 H4: 조회 답의 transactionId는 그 인증의 결제 시도 ID다', async () => {
    const s = make();
    const a = await s.authenticate();
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ transactionId: a.txId });
  });

  describe('낮음: 상점 ID 대조', () => {
    it('P-T16_리뷰 고침 낮음: 조회의 상점 ID가 다르면 404 PAYMENT_NOT_FOUND다', async () => {
      const s = make();
      const a = await s.authenticate();
      expect(await s.call('GET', `/payments/${a.paymentId}?storeId=store-wrong`)).toMatchObject({ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } });
    });

    it('P-T16_리뷰 고침 낮음: 승인의 상점 ID가 다르면 404 PAYMENT_NOT_FOUND이고 승인하지 않는다', async () => {
      const s = make();
      const a = await s.authenticate();
      expect(await s.confirm(a, { storeId: 'store-wrong' })).toMatchObject({ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } });
      expect(await s.ledger()).toEqual([]);
    });

    it('P-T16_리뷰 고침 낮음: 취소의 상점 ID가 다르면 404 PAYMENT_NOT_FOUND이고 취소하지 않는다', async () => {
      const s = make();
      const a = await s.authenticate();
      await s.confirm(a);
      expect(await s.cancel(a.paymentId, { reason: 'x', storeId: 'store-wrong' }, 'cancel-store-0123456789')).toMatchObject({ status: 404, body: { type: 'PAYMENT_NOT_FOUND' } });
      expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'PAID' });
    });

    it('P-T16_리뷰 고침 낮음: 상점 ID를 생략하면 인증 정보의 상점으로 본다', async () => {
      const s = make();
      const a = await s.authenticate();
      expect((await s.call('GET', `/payments/${a.paymentId}`)).status).toBe(200);
      expect((await s.call('GET', `/payments/${a.paymentId}?storeId=store-sim`)).status).toBe(200);
    });
  });
});

describe('포트원 장애 넣기(같은 /sim/faults)', () => {
  it('반영한 결제사 오류는 502 PG_PROVIDER이고 승인은 남는다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'pg-error', applied: true, times: 1 });
    expect(await s.confirm(a)).toMatchObject({ status: 502, body: { type: 'PG_PROVIDER' } });
    expect((await s.ledger()).length).toBe(1);
    expect((await s.confirm(a)).body).toHaveProperty('pgTxId');
  });

  it('거절 코드 PG_PROVIDER는 502로 답하고 승인되지 않으며 조회는 FAILED다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'decline', code: 'PG_PROVIDER', times: 1 });
    expect(await s.confirm(a)).toMatchObject({ status: 502, body: { type: 'PG_PROVIDER' } });
    expect(await s.ledger()).toEqual([]);
    expect((await s.call('GET', `/payments/${a.paymentId}`)).body).toMatchObject({ status: 'FAILED' });
  });

  it('한도 초과는 429이고 다시 하면 처리된다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'throttle', times: 1 });
    expect((await s.confirm(a)).status).toBe(429);
    expect((await s.confirm(a)).status).toBe(200);
  });

  it('응답 유실은 연결을 끊고 반영했으면 원장에 승인이 남는다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'drop', applied: true, times: 1 });
    const url = await s.app.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${url}/payments/${a.paymentId}/confirm`, {
        method: 'POST',
        headers: { ...PORTONE, 'content-type': 'application/json', ...idem(`confirm-${ORDER}`) },
        body: JSON.stringify({ paymentToken: a.paymentToken, totalAmount: 10_000, currency: 'KRW', isTest: true }),
      }),
    ).rejects.toThrow();
    expect((await s.ledger()).length).toBe(1);
  });
});

describe('포트원 웹훅 사건(Standard Webhooks 서명)', () => {
  it('상태가 바뀔 때마다 서명한 사건을 남기고 본문은 포트원 모양이다', async () => {
    const s = make();
    const a = await s.authenticate();
    await s.confirm(a);
    await s.cancel(a.paymentId, { reason: '고객 요청' }, 'cancel-w1-0123456789');
    const r = await s.call('GET', `/sim/portone/webhooks?paymentId=${a.paymentId}`, undefined, BASIC);
    const events = r.body as Array<{ headers: Record<string, string>; body: string }>;
    expect(events.map((e) => (JSON.parse(e.body) as { type: string }).type)).toEqual(['Transaction.Paid', 'Transaction.Cancelled']);
    for (const e of events) {
      const id = e.headers['webhook-id']!;
      const ts = e.headers['webhook-timestamp']!;
      expect(e.headers['webhook-signature']).toBe(`v1,${createHmac('sha256', WEBHOOK_KEY).update(`${id}.${ts}.${e.body}`).digest('base64')}`);
      expect(JSON.parse(e.body)).toMatchObject({ data: { paymentId: a.paymentId, storeId: expect.any(String) } });
    }
    expect(events[0]!.headers['webhook-id']).not.toBe(events[1]!.headers['webhook-id']);
  });
});

describe('포트원 채널 표(BUILD_ORDER PRF-203)', () => {
  const channelOf = async (s: ReturnType<typeof make>, paymentId: string) => ((await s.call('GET', `/payments/${paymentId}?storeId=store-sim`)).body as { channel: Record<string, unknown> }).channel;

  it('P-T46 결제창 인증이 받은 채널 키와 그 하위 결제사를 답의 channel에 싣고, 채널 키가 없으면 SIMULATOR다(필수 칸 type·pgProvider·pgMerchantId)', async () => {
    const s = make();
    const plain = await s.authenticate();
    expect(await channelOf(s, plain.paymentId)).toEqual({ type: 'TEST', pgProvider: 'SIMULATOR', pgMerchantId: 'sim-merchant' });

    expect((await s.call('PUT', '/sim/portone/channels', { channels: { 'channel-kcp': 'KCP_V2' } }, BASIC)).status).toBe(204);
    const order = '0195f3a0-0000-7000-8000-000000000002';
    const r = await s.call('POST', '/sim/portone/authenticate', { orderId: order, amount: 10_000, channelKey: 'channel-kcp' }, BASIC);
    expect(r.status).toBe(200);
    expect(await channelOf(s, `pay-${order}`)).toEqual({ type: 'TEST', id: 'sim-channel-kcp', key: 'channel-kcp', name: '시뮬레이터 채널', pgProvider: 'KCP_V2', pgMerchantId: 'sim-merchant' });

    // 표를 바꾸면 이미 인증한 결제의 답에도 새 하위 결제사가 실린다(P-T46 ④의 '설정과 다른 답'을 만든다)
    expect((await s.call('PUT', '/sim/portone/channels', { channels: { 'channel-kcp': 'TOSSPAYMENTS' } }, BASIC)).status).toBe(204);
    expect(await channelOf(s, `pay-${order}`)).toMatchObject({ key: 'channel-kcp', pgProvider: 'TOSSPAYMENTS' });
    // 표에 없는 키는 SIMULATOR다
    expect((await s.call('PUT', '/sim/portone/channels', { channels: {} }, BASIC)).status).toBe(204);
    expect(await channelOf(s, `pay-${order}`)).toMatchObject({ key: 'channel-kcp', pgProvider: 'SIMULATOR' });
  });

  it('P-T46 채널 표 제어 API는 기본 인증만 받고 틀린 모양은 400이다', async () => {
    const s = make();
    expect((await s.call('PUT', '/sim/portone/channels', { channels: { 'channel-kcp': 'KCP_V2' } })).status).toBe(401);
    expect((await s.call('PUT', '/sim/portone/channels', { channels: { 'channel-kcp': 'kcp' } }, BASIC)).status).toBe(400);
    expect((await s.call('PUT', '/sim/portone/channels', { channels: { 'bad key': 'KCP_V2' } }, BASIC)).status).toBe(400);
    expect((await s.call('POST', '/sim/portone/authenticate', { orderId: ORDER, amount: 10_000, channelKey: 'bad key' }, BASIC)).status).toBe(400);
  });
});
