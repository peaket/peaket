// api-client의 구매 세션 서명 작업(ADR-0221 결정 5, docs/frontend.md §4.1 '자동 재시도'·§5.3 '401', BAS-210이 넘긴 것).
// 생성기가 PurchaseSeq가 있는 작업에 purchaseSigned를 달고, 그 작업은 서명기 없이 보내지 않으며, 시도마다 일련번호·MAC을 새로 단다.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, OPERATIONS, type Operation } from '../src/index';
import { b64u, purchaseMac } from '../src/purchase/crypto';
import { memoryStore } from '../src/purchase/store';
import { openPurchaseSession, pageLocks } from '../src/purchase/signer';

const subtle = globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);
const NOW = Date.parse('2026-11-06T10:00:00Z');
const baseUrls = { api: 'https://api.peaket.example' };
const hold = OPERATIONS.createEventHold as Operation;

function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: new Headers(init.headers), body: String(init.body ?? '') });
    const r = responses.shift();
    if (!r) throw new Error('응답이 더 없다');
    return typeof r === 'function' ? r() : r;
  });
  return { fn, calls };
}
const problem = (status: number, type: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://peaket.example/problems/${type}`, status }), { status, headers: { 'content-type': 'application/problem+json', ...extra } });
const created = () => new Response(JSON.stringify({ holdId: 'h-1' }), { status: 201, headers: { 'content-type': 'application/json' } });

async function session(jti = 'j-1') {
  const store = memoryStore();
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const token = `${b64u(utf8('{"alg":"ES256"}'))}.${b64u(utf8(JSON.stringify({ jti, exp: NOW / 1000 + 900 })))}.c2ln`;
  const s = await openPurchaseSession({ admissionToken: token, serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } }, { subtle, store, locks: pageLocks(), now: () => NOW });
  const key = (await store.get(jti))!.key;
  return { s, store, token, key };
}

describe('서명할 작업은 계약으로 고른다', () => {
  it('구매 세션 쓰기(홀드·나가기·주문·결제 접수 등)에 purchaseSigned가 붙는다', () => {
    expect(OPERATIONS.createEventHold).toMatchObject({ purchaseSigned: true });
    expect(OPERATIONS.deleteEventPurchaseSession).toMatchObject({ purchaseSigned: true });
    expect('purchaseSigned' in OPERATIONS.getEventSeatmapSnapshot).toBe(false);
  });

  it('서명기 없이 보내지 않고 거절한다', async () => {
    const { fn } = fakeFetch([created()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] } })).rejects.toThrow(/구매 세션 서명기/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('시도마다 서명 머리', () => {
  it('보낸 주소의 경로·쿼리와 보낸 본문 문자열로 MAC을 만든다', async () => {
    const { s, token, key } = await session();
    const { fn, calls } = fakeFetch([created()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await client.request(hold, { params: { eventId: 'evt-1' }, body: { seatIds: ['A-2', 'A-1'] }, purchase: s });
    const c = calls[0]!;
    expect(c.headers.get('x-admission-token')).toBe(token);
    expect(c.headers.get('x-purchase-seq')).toBe('1');
    expect(c.headers.get('x-purchase-mac')).toBe(await purchaseMac(subtle, key, 'POST', '/v1/events/evt-1/holds', 1, utf8(c.body)));
    expect(c.body).toBe('{"seatIds":["A-2","A-1"]}');
  });

  // 실제 시계로 본다(Retry-After 1초): 가짜 시계를 앞으로 돌릴 때 암호 계산(실제 비동기)이 끝나지 않아 다시 시도 타이머가 늦게 걸린다
  it('자동 재시도는 같은 멱등 키로 1회만 하고, 시도마다 새 일련번호·MAC을 단다', { timeout: 10_000 }, async () => {
    const { s, key } = await session();
    const { fn, calls } = fakeFetch([new Response(null, { status: 503, headers: { 'retry-after': '1' } }), new Response(null, { status: 503, headers: { 'retry-after': '1' } }), created()]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
    const err = await client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get('idempotency-key')).toBe(calls[1]!.headers.get('idempotency-key'));
    expect(calls.map((c) => c.headers.get('x-purchase-seq'))).toEqual(['1', '2']);
    expect(calls[1]!.headers.get('x-purchase-mac')).toBe(await purchaseMac(subtle, key, 'POST', '/v1/events/e/holds', 2, utf8(calls[1]!.body)));
    expect(calls[1]!.headers.get('x-purchase-mac')).not.toBe(calls[0]!.headers.get('x-purchase-mac'));
  });

  it('보낸 주소의 쿼리와 부호화한 경로까지 MAC 입력에 든다', async () => {
    const { s, key } = await session();
    const { fn, calls } = fakeFetch([created()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    const op: Operation = { method: 'POST', path: '/v1/x/{id}/y', host: 'api', kind: 'write', idempotent: true, purchaseSigned: true, query: ['a', 'b'] };
    await client.request(op, { params: { id: 'a b' }, query: { a: '1', b: 'x y' }, body: { n: 1 }, purchase: s });
    expect(calls[0]!.url).toBe('https://api.peaket.example/v1/x/a%20b/y?a=1&b=x+y');
    expect(calls[0]!.headers.get('x-purchase-mac')).toBe(await purchaseMac(subtle, key, 'POST', '/v1/x/a%20b/y?a=1&b=x+y', 1, utf8('{"n":1}')));
  });

  it('잠금을 쥔 채 오래 기다리지 않는다: Retry-After가 10초를 넘으면 다시 보내지 않고 화면에 올린다', async () => {
    const { s } = await session();
    const { fn, calls } = fakeFetch([new Response(null, { status: 503, headers: { 'retry-after': '11' } }), created()]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
    const err = await client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('401 purchase-seq-reused만 새 번호로 한 번 다시 보낸다(자동 재시도와 따로 센다)', async () => {
    const { s, key } = await session();
    const { fn, calls } = fakeFetch([problem(401, 'purchase-seq-reused'), created()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s })).resolves.toEqual({ holdId: 'h-1' });
    expect(calls.map((c) => c.headers.get('x-purchase-seq'))).toEqual(['1', '2']);
    expect(calls[0]!.headers.get('idempotency-key')).toBe(calls[1]!.headers.get('idempotency-key'));
    expect(calls[1]!.headers.get('x-purchase-mac')).toBe(await purchaseMac(subtle, key, 'POST', '/v1/events/e/holds', 2, utf8(calls[1]!.body)));
  });

  it('다시 보낸 뒤에도 purchase-seq-reused면 오류로 올린다', async () => {
    const { s } = await session();
    const { fn, calls } = fakeFetch([problem(401, 'purchase-seq-reused'), problem(401, 'purchase-seq-reused')]);
    const client = createApiClient({ fetch: fn, baseUrls });
    const err = await client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s }).catch((e: unknown) => e);
    expect((err as ApiError).type).toBe('purchase-seq-reused');
    expect(calls).toHaveLength(2);
  });

  it.each(['purchase-session-ended', 'purchase-signature-invalid', 'admission-token-invalid'])('401 %s는 다시 보내지 않고 화면에 올린다', async (type) => {
    const { s } = await session();
    const { fn, calls } = fakeFetch([problem(401, type), created()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    const err = await client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s }).catch((e: unknown) => e);
    expect((err as ApiError).type).toBe(type);
    expect(calls).toHaveLength(1);
  });

  it('한 구매 세션의 요청 둘은 앞 요청이 끝난 뒤에 다음 요청을 보낸다(잠금이 재시도까지 감싼다)', { timeout: 10_000 }, async () => {
    const { s } = await session();
    const order: string[] = [];
    const { fn, calls } = fakeFetch([
      () => (order.push('a1'), new Response(null, { status: 503, headers: { 'retry-after': '1' } })),
      () => (order.push('a2'), created()),
      () => (order.push('b1'), created()),
    ]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
    const a = client.request(hold, { params: { eventId: 'e' }, body: { seatIds: ['A-1'] }, purchase: s });
    const b = client.request(OPERATIONS.deleteEventPurchaseSession as Operation, { params: { eventId: 'e' }, purchase: s });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b1']);
    expect(calls.map((c) => c.headers.get('x-purchase-seq'))).toEqual(['1', '2', '3']);
    expect(calls[2]!.headers.get('x-purchase-mac')).toBeTruthy();
    expect(calls[2]!.body).toBe('');
  });
});
