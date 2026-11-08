// orval 생성 함수가 부르는 사용자 함수(orvalFetch)와 그 아래 실행 정책 시험(docs/frontend.md §4.1, BUILD_ORDER BAS-041)
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { ApiError, createApiClient, isPreconditionFailed, pickRequestFields, purchaseUnauthorizedAction } from '../src';
import { OPERATIONS } from '../src/gen/operations';
import { matchOperation, orvalFetch, setOrvalClient } from '../src/orval-fetch';

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('응답 없음');
    return next();
  };
  return { calls, fetch };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });
const BASES = { api: 'https://api.peaket.example', queue: 'https://queue.peaket.example', 'ops-api': 'https://ops-api.peaket.example', 'queue-files': 'https://queue-files.peaket.example', www: 'https://www.peaket.example' };

afterEach(() => setOrvalClient(undefined));

describe('matchOperation', () => {
  test('메서드와 주소로 작업 이름과 경로 변수를 찾는다(경로 변수는 풀어 넘긴다)', () => {
    expect(matchOperation('POST', '/v1/events/evt-1/holds')).toMatchObject({ op: { operationId: 'createEventHold' }, params: { eventId: 'evt-1' } });
    expect(matchOperation('GET', '/v1/queues/e1/segment-states/3.json')).toMatchObject({ op: { operationId: 'getQueueSegmentState' }, params: { eventId: 'e1', segment: '3' } });
    expect(matchOperation('DELETE', '/v1/queues/e1/entries/me')?.op.operationId).toBe('deleteMyQueueEntry');
    expect(matchOperation('GET', '/v1/events/e%2F1')?.params).toEqual({ eventId: 'e/1' });
    expect(matchOperation('PATCH', '/v1/events/evt-1/holds')).toBeUndefined();
    expect(matchOperation('GET', '/v1/nope')).toBeUndefined();
  });
});

describe('orvalFetch', () => {
  test('작업을 찾아 같은 실행 정책으로 보내고 { data, status, headers }를 돌려준다', async () => {
    const f = fakeFetch([json(201, { reviewId: 'r1' }, { etag: '"3"' })]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    const r = await orvalFetch<{ data: unknown; status: number; headers: Headers }>('/v1/events/evt-1/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '0190f3a1-7c2e-4a00-8000-000000000001', 'X-Peaket-Note': '7' },
      body: JSON.stringify({ rating: 5 }),
    });
    expect(r).toMatchObject({ data: { reviewId: 'r1' }, status: 201 });
    expect(r.headers.get('etag')).toBe('"3"');
    expect(f.calls[0]!.url).toBe('https://api.peaket.example/v1/events/evt-1/reviews');
    const h = new Headers(f.calls[0]!.init.headers);
    // 화면이 준 멱등 키를 그대로 쓰고(새로 만들지 않는다), 다른 머리는 지나간다
    expect(h.get('idempotency-key')).toBe('0190f3a1-7c2e-4a00-8000-000000000001');
    expect(h.get('x-peaket-note')).toBe('7');
    expect(f.calls[0]!.init.body).toBe('{"rating":5}');
    expect(f.calls[0]!.init.credentials).toBe('include');
  });

  test('쿼리는 그대로 옮기고(같은 이름 여럿 포함) 대기 상태 파일은 no-store·쿠키 없이 보낸다', async () => {
    const f = fakeFetch([json(200, { ok: 1 }), json(200, {})]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    await orvalFetch('/v1/search?q=%EA%B3%B5%EC%97%B0&genre=a&genre=b', { method: 'GET' });
    expect(f.calls[0]!.url).toBe('https://api.peaket.example/v1/search?q=%EA%B3%B5%EC%97%B0&genre=a&genre=b');
    await orvalFetch('/v1/queues/e1/segment-states/0.json', { method: 'GET' });
    expect(f.calls[1]!.init).toMatchObject({ cache: 'no-store', credentials: 'omit' });
  });

  test('구매 세션 쓰기는 생성 함수로 부르지 않는다(시도마다 서명해야 해서 client.send에 purchase를 넘겨 부른다, ADR-0221 결정 5)', async () => {
    const f = fakeFetch([json(201, { holdId: 'h1' })]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    await expect(orvalFetch('/v1/events/evt-1/holds', { method: 'POST', headers: { 'X-Purchase-Seq': '7', 'X-Purchase-Mac': 'm' }, body: JSON.stringify({ seatIds: ['A01'] }) })).rejects.toThrow(/구매 세션 쓰기/);
    expect(f.calls).toHaveLength(0);
  });

  test('T=0 두 호출은 text/plain으로 보내고 safelisted가 아닌 머리를 붙이지 않는다(FE-T3)', async () => {
    const f = fakeFetch([json(201, { ticket: 't' })]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    await orvalFetch('/v1/queues/e1/entries', { method: 'POST', headers: { 'Content-Type': 'application/json', traceparent: 'x' }, body: JSON.stringify({ preverifyToken: 'p' }) });
    const h = new Headers(f.calls[0]!.init.headers);
    expect(h.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(h.get('traceparent')).toBeNull();
  });

  test('올리기(multipart)는 FormData를 한 번 바이트로 만들어 그 경계와 함께 보낸다', async () => {
    const f = fakeFetch([json(201, { imageId: 'i' })]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.png');
    await orvalFetch('/v1/review-images', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: form });
    expect(f.calls[0]!.init.body).toBeInstanceOf(ArrayBuffer);
    const ct = new Headers(f.calls[0]!.init.headers).get('content-type')!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(new TextDecoder().decode(f.calls[0]!.init.body as ArrayBuffer)).toContain(ct.split('boundary=')[1]);
  });

  test('모르는 주소나 클라이언트가 없으면 보내지 않고 거절한다', async () => {
    await expect(orvalFetch('/v1/events/e1/holds', { method: 'POST' })).rejects.toThrow(/setOrvalClient/);
    setOrvalClient(createApiClient({ fetch: fakeFetch([]).fetch, baseUrls: BASES }));
    await expect(orvalFetch('/v1/nope', { method: 'GET' })).rejects.toThrow(/계약에 없는/);
  });
});

describe('동시 수정(If-Match·412, docs/api/guidelines.md §12, 기술 검토 낮음-030)', () => {
  test('If-Match를 받는 작업은 판 없이 보내지 않는다(428을 받기 전에 막는다)', async () => {
    const f = fakeFetch([]);
    const c = createApiClient({ fetch: f.fetch, baseUrls: BASES });
    await expect(c.request(OPERATIONS.putOpsHomeLayout, { body: {} })).rejects.toThrow(/If-Match/);
    expect(f.calls).toEqual([]);
  });

  test('If-Match를 머리로 싣고, 412는 다시 보내지 않으며 isPreconditionFailed로 가린다', async () => {
    const f = fakeFetch([json(412, { type: 'https://peaket.example/problems/precondition-failed', title: '다른 사람이 먼저 고쳤습니다', status: 412 })]);
    const c = createApiClient({ fetch: f.fetch, baseUrls: BASES });
    const err = await c.request(OPERATIONS.putOpsHomeLayout, { body: {}, ifMatch: '"7"' }).catch((e: unknown) => e);
    expect(new Headers(f.calls[0]!.init.headers).get('if-match')).toBe('"7"');
    expect(f.calls).toHaveLength(1);
    expect(isPreconditionFailed(err)).toBe(true);
    expect(isPreconditionFailed(new ApiError(409, null, null))).toBe(false);
  });

  test('orvalFetch는 화면이 준 If-Match 머리를 판으로 넘긴다', async () => {
    const f = fakeFetch([json(200, { version: 8 }, { etag: '"8"' })]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    await orvalFetch('/v1/ops/home-layout', { method: 'PUT', headers: { 'If-Match': '"7"', 'Content-Type': 'application/json' }, body: '{}' });
    expect(new Headers(f.calls[0]!.init.headers).get('if-match')).toBe('"7"');
  });

  test('pickRequestFields는 요청용 스키마의 칸만 골라 응답을 다시 보낼 때 정의 밖 칸으로 400이 나지 않게 한다', () => {
    const Input = z.object({ version: z.int(), banners: z.array(z.object({ alt: z.string() }).strict()), reason: z.string() }).strict();
    const fromGet = { version: 3, banners: [{ alt: '배너', bannerId: 'b1' }], updatedAt: '2026-11-05T00:00:00Z', updatedBy: 'op-1' };
    expect(pickRequestFields(Input, { ...fromGet, reason: '테마 교체' })).toEqual({ version: 3, banners: [{ alt: '배너' }], reason: '테마 교체' });
  });
});

test('구매 경로 401은 type으로 가른다: 일련번호 재사용은 send가 이미 한 번 다시 보냈으므로 화면에서는 세션 끝이다(docs/frontend.md §4.1 401·§5.3)', () => {
  const p = (type: string) => new ApiError(401, { type: `https://peaket.example/problems/${type}`, status: 401 }, null);
  expect(purchaseUnauthorizedAction(new ApiError(401, { type: 'about:blank', status: 401 }, null))).toBe('refresh');
  for (const t of ['purchase-seq-reused', 'purchase-session-ended', 'admission-token-invalid', 'purchase-signature-invalid']) expect(purchaseUnauthorizedAction(p(t))).toBe('session-ended');
  expect(purchaseUnauthorizedAction(new ApiError(403, null, null))).toBeUndefined();
});

describe('새 맥락 리뷰 재현(BAS-041)', () => {
  test('높음: 경로 변수에 .. 이나 ? # 가 풀려 들어오면 다른 작업·호스트로 보내지 않고 거절한다', async () => {
    const f = fakeFetch([]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    for (const url of ['/v1/inquiries/../ops/admin-accounts', '/v1/inquiries/o1?x=1/messages', '/v1/inquiries/./x', '/v1/inquiries/a#b', '/v1/inquiries/a\b']) {
      await expect(orvalFetch(url, { method: 'GET' })).rejects.toThrow(TypeError);
    }
    // 부호화된 값(orval urlEncodeParameters)은 풀어서 한 구간으로 넘긴다
    const ok = fakeFetch([json(200, {})]);
    setOrvalClient(createApiClient({ fetch: ok.fetch, baseUrls: BASES }));
    await orvalFetch(`/v1/inquiries/${encodeURIComponent('a?b')}`, { method: 'GET' });
    expect(ok.calls[0]!.url).toBe('https://api.peaket.example/v1/inquiries/a%3Fb');
    expect(f.calls).toEqual([]);
  });

  test('높음: 응답이 Set-Cookie를 주는 로그인은 쿠키를 받도록 include로 보낸다', () => {
    expect(OPERATIONS.createOpsAuthSession.cookie).toBe(true);
    expect(OPERATIONS.createPartnerAuthSession.cookie).toBe(true);
  });

  test('중간: JSON·글자가 아닌 응답(pdf·좌석 스냅샷)은 Blob으로 돌려준다(생성 형과 같다)', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    const f = fakeFetch([() => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } })]);
    const c = createApiClient({ fetch: f.fetch, baseUrls: BASES });
    const got = await c.request<Blob>(OPERATIONS.getOpsComplianceDocument, { params: { documentId: 'd1' } });
    expect(got).toBeInstanceOf(Blob);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(pdf);
  });

  test('중간: 멱등 키가 있는 올리기를 다시 보낼 때 처음과 같은 본문 바이트·경계를 쓴다(서버 요청 지문)', async () => {
    const f = fakeFetch([json(503, { type: 'about:blank', status: 503 }, { 'retry-after': '0' }), json(201, {})]);
    const c = createApiClient({ fetch: f.fetch, baseUrls: BASES, random: () => 0 });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.png');
    await c.request(OPERATIONS.createOpsExternalPost, { body: form });
    expect(f.calls).toHaveLength(2);
    const [a, b] = f.calls;
    expect(new Headers(a!.init.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(new Headers(b!.init.headers).get('content-type')).toBe(new Headers(a!.init.headers).get('content-type'));
    expect(new Uint8Array(b!.init.body as ArrayBuffer)).toEqual(new Uint8Array(a!.init.body as ArrayBuffer));
    expect(new Headers(b!.init.headers).get('idempotency-key')).toBe(new Headers(a!.init.headers).get('idempotency-key'));
  });

  test('낮음: T=0 본문에 이미 JSON으로 만든 글자를 넘기면 두 번 감싸지 않고 거절한다', async () => {
    setOrvalClient(createApiClient({ fetch: fakeFetch([]).fetch, baseUrls: BASES }));
    await expect(orvalFetch('/v1/queues/e1/entries', { method: 'POST', body: JSON.stringify(JSON.stringify({ preverifyToken: 'p' })) })).rejects.toThrow(/객체/);
  });

  test('낮음: SSE 흐름(text/event-stream)은 생성 함수로 부르지 않는다(EventSource로 연다)', async () => {
    expect(OPERATIONS.getOpsLive).toMatchObject({ sse: true });
    setOrvalClient(createApiClient({ fetch: fakeFetch([]).fetch, baseUrls: BASES }));
    await expect(orvalFetch('/v1/ops/live', { method: 'GET' })).rejects.toThrow(/EventSource/);
  });

  test('낮음: 한 번에 보내는 수신 거부(form-urlencoded)는 URLSearchParams를 그대로 보낸다', async () => {
    const f = fakeFetch([json(200, {})]);
    setOrvalClient(createApiClient({ fetch: f.fetch, baseUrls: BASES }));
    await orvalFetch('/v1/subscription-opt-outs/t1', { method: 'POST', body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) });
    expect(String(f.calls[0]!.init.body)).toBe('List-Unsubscribe=One-Click');
    expect(new Headers(f.calls[0]!.init.headers).get('content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });
});
