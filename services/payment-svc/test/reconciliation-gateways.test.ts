// 거래 조회 어댑터 두 모양(BUILD_ORDER HOT-153, docs/features/payment.md §2.1 '대사용 조회'·§8, P-T32). 실제 답을 흉내 낸 응답으로 어댑터를 돈다.
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';

const ORDER = '0195f3a0-0000-7000-8000-00000000a001';
const FROM = Date.parse('2026-11-09T00:00:00+09:00');
const TO = Date.parse('2026-11-10T00:00:00+09:00');

interface Seen {
  url: URL;
  headers: Record<string, string>;
}
const stub = (status: number, body: unknown, seen: Seen[] = []): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;

const toss = (f: typeof fetch) => new TossPaymentGateway({ baseUrl: 'http://pg.test', secretKey: `test_sk_${randomBytes(4).toString('hex')}`, clientKey: 'test_ck_a', fetch: f });
const portone = (f: typeof fetch) => new PortoneGateway({ baseUrl: 'http://pg.test', secret: `portone_${randomBytes(4).toString('hex')}`, storeId: 'store-a', channelKey: 'c', webhookSecrets: [], isTest: true, fetch: f });

const tossRow = (o: Record<string, unknown> = {}) => ({ mId: 'm', transactionKey: 'tx-1', paymentKey: 'pk-1', orderId: ORDER, method: '카드', status: 'DONE', transactionAt: '2026-11-09T12:00:00+09:00', currency: 'KRW', amount: 15000, ...o });
const portoneItem = (o: Record<string, unknown> = {}) => ({ status: 'PAID', id: `pay-${ORDER}`, transactionId: 'tx', storeId: 'store-a', channel: {}, version: 'V2', requestedAt: '2026-11-09T11:59:00Z', updatedAt: '2026-11-09T12:00:00Z', statusChangedAt: '2026-11-09T12:00:00Z', orderName: 'n', amount: { total: 15000, taxFree: 0, discount: 0, paid: 15000, cancelled: 0, cancelledTaxFree: 0 }, currency: 'KRW', customer: {}, origin: {}, disputes: [], paidAt: '2026-11-09T12:00:00Z', ...o });

const REQ = { fromMs: FROM, toMs: TO, limit: 1000, timeoutMs: 60_000 };

describe('P-T32 토스 거래 조회', () => {
  test('P-T32_GET /v1/transactions를 KST 시각·limit으로 부르고 한 줄씩 공통 모양으로 읽는다 [ASVS v5.0.0-2.2.1]', async () => {
    const seen: Seen[] = [];
    const r = await toss(stub(200, [tossRow()], seen)).listTransactions(REQ);
    expect(r).toEqual({ kind: 'PAGE', items: [{ paymentRef: 'pk-1', orderRef: ORDER, status: 'APPROVED', amount: 15000, atMs: Date.parse('2026-11-09T12:00:00+09:00') }] });
    const q = seen[0]!.url;
    expect(q.pathname).toBe('/v1/transactions');
    expect(q.searchParams.get('startDate')).toBe('2026-11-09T00:00:00');
    expect(q.searchParams.get('endDate')).toBe('2026-11-10T00:00:00');
    expect(q.searchParams.get('limit')).toBe('1000');
    expect(q.searchParams.get('startingAfter')).toBeNull();
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
  });

  test('P-T32_묶음이 꽉 찼으면 마지막 거래 키를 다음 커서로 준다', async () => {
    const seen: Seen[] = [];
    const r = await toss(stub(200, [tossRow({ transactionKey: 'k1' }), tossRow({ transactionKey: 'k2', paymentKey: 'pk-2' })], seen)).listTransactions({ ...REQ, limit: 2, cursor: 'k0' });
    expect(r).toMatchObject({ kind: 'PAGE', nextCursor: 'k2' });
    expect(seen[0]!.url.searchParams.get('startingAfter')).toBe('k0');
  });

  test('P-T32_묶음이 덜 찼으면 다음 커서가 없다', async () => {
    const r = await toss(stub(200, [tossRow()])).listTransactions({ ...REQ, limit: 2 });
    expect(r).toMatchObject({ kind: 'PAGE' });
    expect(r).not.toHaveProperty('nextCursor');
  });

  test.each([
    [500, { code: 'X' }],
    [200, 'not json'],
    [200, { not: 'array' }],
  ])('P-T32_%s 답(%#)은 일시 실패다 [ASVS v5.0.0-16.5.2]', async (status, body) => {
    await expect(toss(stub(status, body)).listTransactions(REQ)).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  test('P-T32_리뷰 고침 M13: 못 읽는 줄은 그 줄만 따로 내고 나머지를 읽는다(묶음 전체를 실패시키지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const r = await toss(stub(200, [tossRow(), tossRow({ status: 'WHAT', paymentKey: 'pk-bad', orderId: 'o-bad' }), null, { paymentKey: 'bad key with space' }])).listTransactions(REQ);
    expect(r).toMatchObject({ kind: 'PAGE', items: [{ paymentRef: 'pk-1' }] });
    const bad = (r as Extract<typeof r, { kind: 'PAGE' }>).unreadable!;
    expect(bad).toHaveLength(3);
    expect(bad[0]).toEqual({ paymentRef: 'pk-bad', orderRef: 'o-bad' });
    // 모양을 믿을 수 없는 값은 그대로 저장하지 않고 줄의 해시로 대신한다
    expect(bad[1]!.paymentRef).toMatch(/^unreadable-[0-9a-f]{32}$/);
    expect(bad[1]!.orderRef).toBe('');
    expect(bad[2]!.paymentRef).toMatch(/^unreadable-[0-9a-f]{32}$/);
    expect(JSON.stringify(bad)).not.toContain('with space');
  });

  test('P-T32_리뷰 고침 M13: 꽉 찬 묶음의 마지막 거래 키를 못 읽으면 뒤를 잃지 않게 일시 실패다', async () => {
    await expect(toss(stub(200, [tossRow(), tossRow({ transactionKey: undefined })])).listTransactions({ ...REQ, limit: 2 })).resolves.toEqual({ kind: 'UNKNOWN' });
  });

  test('P-T32_429는 표시를 싣는다', async () => {
    await expect(toss(stub(429, { code: 'TOO_MANY' })).listTransactions(REQ)).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
  });
});

describe('P-T32 포트원 결제 대용량 다건 조회', () => {
  test('P-T32_GET /payments-by-cursor를 ISO 시각·상점 ID로 부르고 결제 한 건을 공통 모양으로 읽는다', async () => {
    const seen: Seen[] = [];
    const r = await portone(stub(200, { items: [portoneItem()], cursor: 'next' }, seen)).listTransactions(REQ);
    expect(r).toEqual({ kind: 'PAGE', items: [{ paymentRef: `pay-${ORDER}`, orderRef: ORDER, status: 'APPROVED', amount: 15000, atMs: Date.parse('2026-11-09T12:00:00Z') }], nextCursor: 'next' });
    const q = seen[0]!.url;
    expect(q.pathname).toBe('/payments-by-cursor');
    expect(q.searchParams.get('storeId')).toBe('store-a');
    expect(q.searchParams.get('from')).toBe(new Date(FROM).toISOString());
    expect(q.searchParams.get('until')).toBe(new Date(TO).toISOString());
    expect(q.searchParams.get('size')).toBe('1000');
    expect(seen[0]!.headers.authorization).toMatch(/^PortOne /);
  });

  test('P-T32_커서를 넘기고, 커서가 없으면 끝이다', async () => {
    const seen: Seen[] = [];
    const r = await portone(stub(200, { items: [] }, seen)).listTransactions({ ...REQ, cursor: 'c1' });
    expect(r).toEqual({ kind: 'PAGE', items: [] });
    expect(seen[0]!.url.searchParams.get('cursor')).toBe('c1');
  });

  test('P-T32_paidAt이 없으면 statusChangedAt을 쓰고, pay- 앞머리가 없어도 주문 참조로 읽는다', async () => {
    const r = await portone(stub(200, { items: [portoneItem({ status: 'CANCELLED', paidAt: undefined, id: 'other-1' })] })).listTransactions(REQ);
    expect(r).toMatchObject({ kind: 'PAGE', items: [{ paymentRef: 'other-1', orderRef: 'other-1', status: 'CANCELED', atMs: Date.parse('2026-11-09T12:00:00Z') }] });
  });

  test('P-T32_모양이 틀린 답과 5xx는 일시 실패다 [ASVS v5.0.0-16.5.2]', async () => {
    await expect(portone(stub(502, { type: 'PG_PROVIDER' })).listTransactions(REQ)).resolves.toEqual({ kind: 'UNKNOWN' });
    await expect(portone(stub(200, { nope: true })).listTransactions(REQ)).resolves.toEqual({ kind: 'UNKNOWN' });
    await expect(portone(stub(429, {})).listTransactions(REQ)).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
  });

  test('P-T32_리뷰 고침 M13: 못 읽는 줄은 그 줄만 따로 내고 커서를 이어 간다', async () => {
    const r = await portone(stub(200, { items: [portoneItem(), { id: 'pay-bad', status: 'WHAT' }], cursor: 'next' })).listTransactions(REQ);
    expect(r).toMatchObject({ kind: 'PAGE', items: [{ paymentRef: `pay-${ORDER}` }], nextCursor: 'next', unreadable: [{ paymentRef: 'pay-bad', orderRef: 'bad' }] });
  });

  test('P-T32_리뷰 고침 낮음: 답의 customData에 주문 ID가 있으면 결제 ID가 아니라 그 칸을 주문 참조로 읽는다(ORDER_MISMATCH가 늘 통과하지 않게)', async () => {
    const r = await portone(stub(200, { items: [portoneItem({ customData: JSON.stringify({ orderId: 'other-order' }) })] })).listTransactions(REQ);
    expect(r).toMatchObject({ kind: 'PAGE', items: [{ paymentRef: `pay-${ORDER}`, orderRef: 'other-order' }] });
    // JSON이 아니거나 주문 ID가 없으면 결제 ID에서 읽는다
    const plain = await portone(stub(200, { items: [portoneItem({ customData: 'not json' })] })).listTransactions(REQ);
    expect(plain).toMatchObject({ kind: 'PAGE', items: [{ orderRef: ORDER }] });
  });
});
