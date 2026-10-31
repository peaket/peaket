// RFC 9457 Problem(docs/api/guidelines.md §2, ADR-0081, openspec 변경 add-service-template 결정 3).
import { afterEach, describe, expect, test } from 'vitest';
import { ProblemError, createService, loadPlatformConfig } from '../src/index.js';
import { DemoModule, start, type Started } from './fixture.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.svc.close();
  s = undefined;
});

const TRACE = /^[0-9a-f]{32}$/;

describe('오류 응답 본문', () => {
  test('GL2_이름붙은오류는_type_URI와_표준칸_확장필드를싣는다', async () => {
    s = await start();
    const res = await s.inject({ method: 'POST', url: '/v1/demo/holds?x=1' });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const body = res.json();
    expect(body).toMatchObject({
      type: 'https://peaket.example/problems/seat-already-held',
      title: '좌석이 이미 선택되었습니다',
      status: 409,
      detail: 'A-12는 방금 다른 분이 선택했습니다.',
      instance: '/v1/demo/holds',
      suggestedSeats: ['A-13', 'A-14'],
    });
    expect(body.traceId).toMatch(TRACE);
    expect(body).not.toHaveProperty('debug');
  });

  test('[ASVS v5.0.0-16.5.1] 예상하지못한오류는_500_일반문구와traceId만_내고_원본은서버기록에남긴다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['status', 'title', 'traceId', 'type']);
    expect(body).toMatchObject({ type: 'about:blank', title: 'Internal Server Error', status: 500 });
    expect(res.payload).not.toMatch(/secret_table|SELECT|at DemoController/);
    // [ASVS v5.0.0-16.3.4] 같은 traceId로 원본 예외를 그 요청의 정규 로그 줄에 남긴다
    const lines = s.requests();
    expect(lines).toHaveLength(1);
    const entry = lines[0] as { traceId: string; err: { type: string; message: string }; route: string; method: string };
    expect(entry.traceId).toBe(body.traceId);
    expect(entry.err.message).toMatch(/secret_table/);
    expect(entry).toMatchObject({ route: '/v1/demo/boom', method: 'GET', status: 500, level: 'error' });
  });

  test('GL2_없는경로는_404_about_blank', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/nope/123' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Not Found', status: 404 });
    expect(res.json()).not.toHaveProperty('detail');
  });

  test('GL2_JSON이아닌본문은_400_about_blank', async () => {
    s = await start();
    const res = await s.inject({ method: 'POST', url: '/v1/demo/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400 });
    expect(res.json()).not.toHaveProperty('detail');
  });

  test('[ASVS v5.0.0-16.5.1] statusCode를단일반오류는_그상태를믿지않고500이며_서버기록에남는다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/upstream' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ type: 'about:blank', status: 500 });
    expect(res.payload).not.toMatch(/token=abc|identity-svc/);
    expect(s.requests()).toMatchObject([{ status: 500, err: { type: 'Error' } }]);
  });

  test('GL2_HTTP예외의상태가4xx·5xx가아니면_500으로답하고_기록한다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/redirect' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ type: 'about:blank', status: 500 });
    expect(s.requests()).toMatchObject([{ status: 500, err: { type: 'HttpException' } }]);
  });

  test('GL2_잘못된URL은_400Problem이고_요청경로를되돌려주지않으며_지표에든다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/x/%E0%A4%A' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400 });
    expect(res.json().traceId).toMatch(TRACE);
    expect(res.payload).not.toMatch(/E0|v1\/x/);
    const text = await s.metrics();
    expect(text).toMatch(/http_server_request_duration_seconds_count\{[^}]*route="unmatched"[^}]*status_class="4xx"[^}]*\} 1/);
  });

  test('GL2_서버바쁨은_429와_Retry-After', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/busy' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.json()).toMatchObject({ type: 'https://peaket.example/problems/server-busy', status: 429 });
  });

  test('[ASVS v5.0.0-13.4.2] 로컬에서디버그를켜면_500에_debug가실린다', async () => {
    s = await start({ PEAKET_ENV: 'local', PEAKET_DEBUG_ERRORS: 'true' });
    const body = (await s.inject({ method: 'GET', url: '/v1/demo/boom' })).json();
    expect(body.debug).toMatchObject({ name: 'Error' });
    expect(body.debug.message).toMatch(/secret_table/);
    expect(body.debug.stack.length).toBeLessThanOrEqual(10);
  });
});

describe('ProblemError 만들기', () => {
  test('GL2_확장필드가표준칸을덮거나_이름이케밥이아니거나_상태가오류가아니면던진다', () => {
    expect(() => new ProblemError({ type: 'x', status: 409, title: 't', extensions: { status: 200 } })).toThrow(/표준 칸/);
    expect(() => new ProblemError({ type: 'x', status: 409, title: 't', extensions: { traceId: 'a' } })).toThrow(/표준 칸/);
    expect(() => new ProblemError({ type: 'Seat_Held', status: 409, title: 't' })).toThrow(/케밥/);
    expect(() => new ProblemError({ type: 'x', status: 200, title: 't' })).toThrow(/4xx/);
    expect(() => new ProblemError({ type: 'x', status: 429, title: 't', retryAfterSeconds: 1.5 })).toThrow(/Retry-After/);
  });
});

describe('[ASVS v5.0.0-13.4.2] 시작 설정 검사', () => {
  test.each([
    ['운영', { PEAKET_ENV: 'prod', PEAKET_DEBUG_ERRORS: 'true' }],
    ['데모', { PEAKET_ENV: 'demo', PEAKET_DEBUG_ERRORS: 'true' }],
    ['스테이징', { PEAKET_ENV: 'staging', PEAKET_DEBUG_ERRORS: 'true' }],
    ['환경 없음(운영으로 본다)', { PEAKET_DEBUG_ERRORS: 'true' }],
  ])('ADR0081_%s에서_디버그를켜면_시작하지않는다', async (_name, env) => {
    await expect(createService({ name: 'demo-svc', module: DemoModule, env })).rejects.toThrow(/PEAKET_DEBUG_ERRORS/);
  });

  test('ADR0081_잘못된값은_시작하지않는다', () => {
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'production' })).toThrow(/PEAKET_ENV/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_DEBUG_ERRORS: 'yes' })).toThrow(/PEAKET_DEBUG_ERRORS/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PORT: '9000', PEAKET_MANAGEMENT_PORT: '9000' })).toThrow(/포트/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_MAX_DEADLINE_MS: '0' })).toThrow(/PEAKET_MAX_DEADLINE_MS/);
  });

  test('ADR0081_기본값', () => {
    expect(loadPlatformConfig({})).toEqual({
      env: 'prod',
      debugErrors: false,
      port: 8080,
      managementPort: 9464,
      maxDeadlineMs: 15_000,
      version: 'unknown',
      logLevel: 'info',
      sampleOneIn: 10,
      defaultSloLatencyMs: 500,
    });
  });
});
