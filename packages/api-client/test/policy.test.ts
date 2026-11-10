// api-client 공통 정책 시험(docs/frontend.md §4.1·§1.5·§5.9, BUILD_ORDER BAS-210).
// FE-T3(T=0 두 호출의 사전 요청 0: api-client가 다른 경로의 text/plain을 거절), FE-T4(서버를 지키는 규칙), FE-T15(AbortSignal.any 대체).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  anySignal,
  ApiError,
  createApiClient,
  credentialsFor,
  fullJitterMs,
  parseRetryAfter,
  retryDelayMs,
  RetryBudget,
  T0_TEXT_PLAIN_OPERATIONS,
  type Operation,
} from '../src/index';

const root = resolve(import.meta.dirname, '../../..');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('anySignal', () => {
  it('FE-T15 AbortSignal.any가 없어도 먼저 끊긴 신호의 reason을 그대로 넘기고 듣기를 지운다', () => {
    const original = AbortSignal.any;
    // @ts-expect-error 지원하지 않는 브라우저 흉내(iOS 16.4~17.3)
    AbortSignal.any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      const removeA = vi.spyOn(a.signal, 'removeEventListener');
      const s = anySignal([a.signal, b.signal]);
      expect(s.aborted).toBe(false);
      const reason = new DOMException('시간 초과', 'TimeoutError');
      b.abort(reason);
      expect(s.aborted).toBe(true);
      expect(s.reason).toBe(reason);
      // 끝나면 오래 사는 신호(a)에 듣기를 남기지 않는다
      expect(removeA).toHaveBeenCalled();
    } finally {
      AbortSignal.any = original;
    }
  });

  it('FE-T15 이미 끊긴 신호가 있으면 바로 끊고, AbortSignal.any가 있으면 그것을 쓴다', () => {
    const original = AbortSignal.any;
    // @ts-expect-error 지원하지 않는 브라우저 흉내
    AbortSignal.any = undefined;
    try {
      const done = AbortSignal.abort(new DOMException('떠남', 'AbortError'));
      const s = anySignal([new AbortController().signal, done]);
      expect(s.aborted).toBe(true);
      expect((s.reason as DOMException).name).toBe('AbortError');
    } finally {
      AbortSignal.any = original;
    }
    const spy = vi.spyOn(AbortSignal, 'any');
    anySignal([new AbortController().signal]);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('다시 시도 기다림', () => {
  it('FE-T4 Retry-After(초·HTTP 날짜)를 하한으로 읽는다', () => {
    const now = Date.parse('2026-11-04T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('Wed, 04 Nov 2026 10:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('Wed, 04 Nov 2026 09:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('엉터리', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('FE-T4 서버가 준 하한은 지키고 위쪽으로만 0~20% 퍼뜨린다(헤더·retryAfterSeconds·pollHintMs)', () => {
    for (const random of [0, 0.5, 0.999999]) {
      const d = retryDelayMs({ retryAfterHeader: '2', attempt: 0, random: () => random, nowMs: 0 });
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(2400);
    }
    expect(retryDelayMs({ body: { retryAfterSeconds: 1 }, attempt: 0, random: () => 0.5, nowMs: 0 })).toBe(1100);
    expect(retryDelayMs({ body: { pollHintMs: 500 }, attempt: 0, random: () => 1, nowMs: 0 })).toBeCloseTo(600);
    // 헤더와 본문이 함께 오면 더 늦은 하한을 지킨다
    expect(retryDelayMs({ retryAfterHeader: '1', body: { retryAfterSeconds: 3 }, attempt: 0, random: () => 0, nowMs: 0 })).toBe(3000);
  });

  it('FE-T4 NOT_YET의 retryAfterMs는 사람마다 계산한 시각이라 지터 없이 그대로 쓴다', () => {
    expect(retryDelayMs({ body: { retryAfterMs: 1234 }, attempt: 3, random: () => 0.9, nowMs: 0 })).toBe(1234);
  });

  it('FE-T4 하한이 없으면 전체 지터(0부터 지금 상한 사이)이고 상한은 0.5초에서 두 배씩 8초까지다', () => {
    expect(fullJitterMs(0, () => 1)).toBe(500);
    expect(fullJitterMs(1, () => 1)).toBe(1000);
    expect(fullJitterMs(4, () => 1)).toBe(8000);
    expect(fullJitterMs(10, () => 1)).toBe(8000);
    expect(fullJitterMs(3, () => 0)).toBe(0);
    expect(retryDelayMs({ attempt: 2, random: () => 0.5, nowMs: 0 })).toBe(1000);
  });

  it('FE-T4 한 페이지의 자동 재시도는 분당 60회를 넘지 않는다', () => {
    let now = 0;
    const budget = new RetryBudget(() => now);
    for (let i = 0; i < 60; i++) expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    now = 60_001;
    expect(budget.take()).toBe(true);
  });
});

describe('요청 정책', () => {
  it('정본 openapi에서 text/plain 본문을 받는 작업이 T=0 두 호출과 같다', () => {
    const doc = parse(readFileSync(resolve(root, 'docs/api/openapi.yaml'), 'utf8'));
    const found: string[] = [];
    for (const [path, item] of Object.entries<Record<string, { requestBody?: { content?: Record<string, unknown> } }>>(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (op?.requestBody?.content?.['text/plain']) found.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(found.sort()).toEqual([...T0_TEXT_PLAIN_OPERATIONS].sort());
    // openapi 파일이 커져 몰리는 러너에서 YAML 해석이 기본 5초를 넘긴다(CI 42515928543)
  }, 30_000);

  it('쿠키를 쓰는 API는 include, 대기열 파일·정적 JSON·스캐너는 omit이다', () => {
    expect(credentialsFor('api')).toBe('include');
    expect(credentialsFor('queue')).toBe('include');
    expect(credentialsFor('partner-api')).toBe('include');
    expect(credentialsFor('ops-api')).toBe('include');
    expect(credentialsFor('queue-files')).toBe('omit');
    expect(credentialsFor('www')).toBe('omit');
    expect(credentialsFor('scanner-api')).toBe('omit');
  });

  it('problem+json을 ApiError로 읽고 type은 주소의 끝 경로다', async () => {
    const res = new Response(JSON.stringify({ type: 'https://peaket.example/problems/seat-held', title: '이미 홀드됨', status: 409, traceId: 't-1', seats: ['A-1'] }), {
      status: 409,
      headers: { 'content-type': 'application/problem+json' },
    });
    const e = await ApiError.from(res);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.type).toBe('seat-held');
    expect(e.traceId).toBe('t-1');
    expect(e.extensions).toEqual({ seats: ['A-1'] });
  });
});

/** 가짜 fetch: 부를 때마다 받은 요청을 적고 정한 응답을 차례로 준다 */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit & { headers: Headers } }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: { ...init, headers: new Headers(init.headers) } });
    const r = responses.shift();
    if (!r) throw new Error('응답이 더 없다');
    if (r instanceof Error) throw r;
    return r;
  });
  return { fn, calls };
}

const enter: Operation = { method: 'POST', path: '/v1/queues/{eventId}/entries', host: 'queue', kind: 'write' };
const hold: Operation = { method: 'POST', path: '/v1/events/{eventId}/holds', host: 'api', kind: 'write', idempotent: true };
const read: Operation = { method: 'GET', path: '/v1/events/{eventId}', host: 'api', kind: 'read' };
const appeal: Operation = { method: 'POST', path: '/v1/fraud-appeals', host: 'api', kind: 'write' };
const baseUrls = { api: 'https://api.peaket.example', queue: 'https://queue.peaket.example' };
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('createApiClient', () => {
  it('FE-T3 T=0 두 호출은 text/plain JSON 문자열로 보내고 safelisted가 아닌 헤더를 붙이지 않는다', async () => {
    const { fn, calls } = fakeFetch([ok()]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
    await client.request(enter, { params: { eventId: 'evt-1' }, body: { preverifyToken: 'p' } });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://queue.peaket.example/v1/queues/evt-1/entries');
    expect(init.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(init.body).toBe('{"preverifyToken":"p"}');
    expect([...init.headers.keys()]).toEqual(['content-type']);
    expect(init.credentials).toBe('include');
    expect(init.redirect).toBe('error');
  });

  it('FE-T3 다른 경로에 text/plain을 쓰려 하면 보내지 않고 거절한다', async () => {
    const { fn } = fakeFetch([ok()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(hold, { params: { eventId: 'e' }, body: { seats: [] }, contentType: 'text/plain' })).rejects.toThrow(/text\/plain/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('FE-T4 멱등키가 있는 쓰기는 503 Retry-After 뒤 같은 키·같은 본문 문자열로 다시 보낸다', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch([new Response(null, { status: 503, headers: { 'retry-after': '1' } }), ok({ holdId: 'h' })]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
    const p = client.request(hold, { params: { eventId: 'e' }, body: { seats: ['A-1'] } });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ holdId: 'h' });
    expect(calls).toHaveLength(2);
    const k1 = calls[0]!.init.headers.get('idempotency-key');
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.init.headers.get('idempotency-key')).toBe(k1);
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    expect(calls[0]!.init.headers.get('content-type')).toBe('application/json');
  });

  it('FE-T4 멱등키가 없는 생성형 쓰기는 자동으로 다시 보내지 않는다', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 503, headers: { 'retry-after': '1' } })]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(appeal, { body: { text: 'x' } })).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('FE-T4 읽기는 네트워크 오류에 최대 2번 다시 보내고(전체 지터) 그 뒤에는 실패를 낸다', async () => {
    vi.useFakeTimers();
    const { fn } = fakeFetch([new TypeError('끊김'), new TypeError('끊김'), new TypeError('끊김')]);
    const client = createApiClient({ fetch: fn, baseUrls, random: () => 1 });
    const p = client.request(read, { params: { eventId: 'e' } });
    const settled = expect(p).rejects.toThrow('끊김');
    await vi.advanceTimersByTimeAsync(500 + 1000);
    await settled;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('FE-T4 4xx(503 밖)는 다시 보내지 않고 ApiError로 낸다', async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ type: 'about:blank/not-found', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } })]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(read, { params: { eventId: 'e' } })).rejects.toMatchObject({ status: 404, type: 'not-found' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('FE-T4 409 idempotency-request-in-progress는 Retry-After 뒤 같은 키로 다시 보내고, 422 idempotency-key-reused는 버그로 보고 다시 보내지 않는다', async () => {
    vi.useFakeTimers();
    const prob = (status: number, type: string, ra?: string) =>
      new Response(JSON.stringify({ type: `https://peaket.example/problems/${type}`, status }), {
        status,
        headers: { 'content-type': 'application/problem+json', ...(ra ? { 'retry-after': ra } : {}) },
      });
    const a = fakeFetch([prob(409, 'idempotency-request-in-progress', '1'), ok({ ok: 1 })]);
    const reported: unknown[] = [];
    const c1 = createApiClient({ fetch: a.fn, baseUrls, random: () => 0, onBug: (e) => reported.push(e) });
    const p = c1.request(hold, { params: { eventId: 'e' }, body: { seats: [] } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(a.calls[1]!.init.headers.get('idempotency-key')).toBe(a.calls[0]!.init.headers.get('idempotency-key'));

    const b = fakeFetch([prob(422, 'idempotency-key-reused')]);
    const c2 = createApiClient({ fetch: b.fn, baseUrls, onBug: (e) => reported.push(e) });
    await expect(c2.request(hold, { params: { eventId: 'e' }, body: { seats: [] } })).rejects.toMatchObject({ status: 422 });
    expect(b.fn).toHaveBeenCalledOnce();
    expect(reported).toHaveLength(1);
  });

  it('FE-T46 ⑦ 호출마다 넘긴 시간 한도(timeoutMs)가 작업 종류의 한도를 바꾼다(좌석맵 저장 65초: 64,999ms에는 기다리고 65,000ms에 끊는다)', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const client = createApiClient({ fetch, baseUrls, maxRetries: 0 });
    let settled = false;
    const p = client.request(appeal, { body: {}, timeoutMs: 65_000 });
    p.catch(() => undefined).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(64_999);
    expect(settled).toBe(false);
    const done = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1);
    await done;
    // 넘기지 않으면 쓰기 15초 그대로
    const q = client.request(appeal, { body: {} });
    const done2 = expect(q).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await done2;
  });

  it('FE-T4 시간 초과는 작업 종류별(읽기 10초)로 걸고 화면을 떠날 때의 신호와 묶는다', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const client = createApiClient({ fetch, baseUrls, maxRetries: 0 });
    const p = client.request(read, { params: { eventId: 'e' } });
    const settled = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    const leave = new AbortController();
    const q = client.request(read, { params: { eventId: 'e' }, signal: leave.signal });
    leave.abort(new DOMException('떠남', 'AbortError'));
    await expect(q).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('경로 변수는 주소 조각으로 감싸고, 빠지면 보내지 않는다', async () => {
    const { fn, calls } = fakeFetch([ok()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await client.request(read, { params: { eventId: 'a/b c' } });
    expect(calls[0]!.url).toBe('https://api.peaket.example/v1/events/a%2Fb%20c');
    await expect(client.request(read, {})).rejects.toThrow(/eventId/);
  });
});

/** 신호에 붙은 듣기 함수를 센다(붙인 것 − 지운 것) */
function countListeners(signal: AbortSignal) {
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, l, o) => {
    if (type === 'abort') live.add(l);
    add(type, l, o);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, l, o) => {
    if (type === 'abort') live.delete(l);
    remove(type, l, o);
  });
  return () => live.size;
}

describe('새 맥락 리뷰 재현(BAS-210)', () => {
  it('FE-T15 AbortSignal.any가 없을 때 끊기지 않고 끝난 요청도, 다시 시도 사이 기다림도 화면 신호에 듣기를 남기지 않는다', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error 지원하지 않는 브라우저 흉내(iOS 16.4~17.3)
    AbortSignal.any = undefined;
    vi.useFakeTimers();
    try {
      const leave = new AbortController();
      const live = countListeners(leave.signal);
      const { fn } = fakeFetch([ok({ a: 1 }), new Response(null, { status: 503, headers: { 'retry-after': '1' } }), ok({ b: 2 })]);
      const client = createApiClient({ fetch: fn, baseUrls, random: () => 0 });
      await expect(client.request(read, { params: { eventId: 'e' }, signal: leave.signal })).resolves.toEqual({ a: 1 });
      expect(live()).toBe(0);
      const p = client.request(hold, { params: { eventId: 'e' }, body: {}, signal: leave.signal });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toEqual({ b: 2 });
      expect(live()).toBe(0);
    } finally {
      AbortSignal.any = original;
    }
  });

  it('www 호스트에서도 openapi가 쿠키 보안(linkCookie)을 단 작업은 쿠키를 싣고, 정적 JSON은 싣지 않는다', async () => {
    const linkProposal: Operation = { method: 'GET', path: '/v1/identity/link-proposals/{proposalId}', host: 'www', kind: 'read', cookie: true };
    const ranking: Operation = { method: 'GET', path: '/rankings/today.json', host: 'www', kind: 'read' };
    const { fn, calls } = fakeFetch([ok(), ok()]);
    const client = createApiClient({ fetch: fn, baseUrls: { www: 'https://www.peaket.example' } });
    await client.request(linkProposal, { params: { proposalId: 'p1' } });
    await client.request(ranking);
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[1]!.init.credentials).toBe('omit');
    expect(credentialsFor('www', { cookie: true })).toBe('include');
  });

  it('[ASVS v5.0.0-1.2.2] 경로 변수가 . 이나 .. 이면 다른 API 경로로 새지 않게 보내지 않는다', async () => {
    const { fn } = fakeFetch([ok(), ok()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(hold, { params: { eventId: '..' }, body: {} })).rejects.toThrow(/경로 변수/);
    await expect(client.request(hold, { params: { eventId: '.' }, body: {} })).rejects.toThrow(/경로 변수/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('FE-T4 사람이 같은 동작을 다시 시도하면 화면이 넘긴 같은 멱등키를 쓰고, 키가 UUID가 아니면 보내지 않는다', async () => {
    const { fn, calls } = fakeFetch([ok(), ok()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    const key = '0b6f0c5e-1d2a-4c3b-8e4f-5a6b7c8d9e0f';
    await client.request(hold, { params: { eventId: 'e' }, body: {}, idempotencyKey: key });
    await client.request(hold, { params: { eventId: 'e' }, body: {}, idempotencyKey: key });
    expect(calls.map((c) => c.init.headers.get('idempotency-key'))).toEqual([key, key]);
    await expect(client.request(hold, { params: { eventId: 'e' }, body: {}, idempotencyKey: 'not-a-uuid' })).rejects.toThrow(/멱등/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('FE-T3 T=0 두 호출에 application/json을 주면 사전 요청이 생기므로 보내지 않고 거절한다', async () => {
    const { fn } = fakeFetch([ok()]);
    const client = createApiClient({ fetch: fn, baseUrls });
    await expect(client.request(enter, { params: { eventId: 'e' }, body: {}, contentType: 'application/json' })).rejects.toThrow(/text\/plain/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('FE-T4 하한이 있으면 1만 번 뽑은 기다림이 모두 하한 이상·1.2배 이하이고 열 칸에 고르게(칸마다 9~11%) 퍼진다(하한이 기본 간격보다 큰 값과 작은 값)', () => {
    for (const hint of [{ retryAfterHeader: '3' }, { body: { pollHintMs: 200 } }] as const) {
      const floor = 'retryAfterHeader' in hint ? 3000 : 200;
      const bins = new Array<number>(10).fill(0);
      // 씨앗을 고정한 균등 난수(mulberry32). Math.random이면 칸마다 ±3.3표준편차를 우연히 벗어나 가끔 실패한다(CI 42528011764, 895 < 900)
      let state = 20261109;
      const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let i = 0; i < 10_000; i++) {
        const d = retryDelayMs({ ...hint, attempt: 0, random, nowMs: 0 });
        expect(d).toBeGreaterThanOrEqual(floor);
        expect(d).toBeLessThanOrEqual(floor * 1.2);
        bins[Math.min(9, Math.floor(((d - floor) / (floor * 0.2)) * 10))]!++;
      }
      for (const n of bins) {
        expect(n).toBeGreaterThanOrEqual(900);
        expect(n).toBeLessThanOrEqual(1100);
      }
    }
  });
});

describe('응답 읽기(새 맥락 리뷰 재현, BAS-210)', () => {
  it('[ASVS v5.0.0-15.3.6] 응답과 오류 본문은 공용 안전 파서로 읽어 __proto__·constructor 키가 든 JSON을 받지 않는다', async () => {
    const evil = (status: number, ct: string) => new Response('{"a":1,"__proto__":{"admin":true}}', { status, headers: { 'content-type': ct } });
    const { fn } = fakeFetch([evil(200, 'application/json'), evil(409, 'application/problem+json')]);
    const client = createApiClient({ fetch: fn, baseUrls, maxRetries: 0 });
    await expect(client.request(read, { params: { eventId: 'e' } })).rejects.toThrow(/쓸 수 없는 키/);
    const e = await client.request(read, { params: { eventId: 'e' } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).extensions).toEqual({});
  });
});
