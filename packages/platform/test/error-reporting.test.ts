// 서버 오류 수집 잠금(V-T39 ①, docs/verification.md V-T39, docs/observability.md §11 'Sentry', ADR-0356 결정 4, ASVS v5.0.0-14.2.3).
// createService로 띄운 시험 서비스의 DSN을 가짜 수신기(error-reporting-app.ts, 진짜 SDK가 보낸 사건 묶음 바이트를 받아 푼다)로 돌린다.
// 받은 원문 바이트 전체에서 본문·쿠키·쿼리·머리 값과 클라이언트 IP를 찾는다(푼 칸만 보면 다른 칸에 숨은 값을 놓친다).
// 바깥 호출의 추적 머리(V-T31 ③)는 OTel SDK가 떠 있어야 보이므로 이 파일 맨 위에서 텔레메트리를 먼저 띄우고 서비스 모듈은 뒤에 읽는다.
// 끝낼 때 보내는 시간(2초 [가정])은 단언하지 않는다(가정 값, 계획 §6).
import { request as nodeHttpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ErrorEvent } from '@sentry/core';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { startTelemetry } from '../src/telemetry.js';
import { TRACE_PROPAGATION_HEADERS, probeTraceHeaders } from '../src/testing.js';

const telemetry = startTelemetry({ serviceName: 'demo-svc', version: '1.4.2', env: 'ci', spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })] });

type App = typeof import('./error-reporting-app.js');
type Fixture = typeof import('./fixture.js');
type Platform = typeof import('../src/index.js');
let app: App;
let fx: Fixture;
let platform: Platform;

// 서비스 전체를 불러오는 준비는 붐비는 CI에서 기본 제한을 넘을 수 있어 준비 단계만 60초로 둔다(telemetry.test.ts와 같은 까닭)
beforeAll(async () => {
  app = await import('./error-reporting-app.js');
  fx = await import('./fixture.js');
  platform = await import('../src/index.js');
  // OTel http 계측은 CommonJS의 http 모듈 객체를 고친다(Fastify가 require할 때). ESM의 이름 가져오기(오류 수집 보내기의 node:http request)도
  // 그 고친 함수를 보게 맞춘다: 계측이 걸린 가장 나쁜 경우에도 보내는 요청에 추적 문맥이 실리지 않는지 보려는 것이다(아래 대조 요청이 확인한다)
  syncBuiltinESMExports();
}, 60_000);
afterAll(async () => {
  await telemetry.shutdown();
});

const BASE = { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_VERSION: '1.4.2' };
/** 요청에 실을 값. 어느 것도 받은 사건 바이트에 나오면 안 된다 */
const SECRETS = {
  email: 'fan.secret@example.com',
  phone: '010-5555-0199',
  note: 'body-secret-4410',
  cookie: 'cookie-secret-7781',
  query: 'query-secret-3302',
  header: 'header-secret-9917',
  ip: '203.0.113.77',
  forwardedIp: '198.51.100.23',
};
const SENTRY_TRACE_HEADERS = [...TRACE_PROPAGATION_HEADERS, 'sentry-trace'];

interface Running {
  svc: Awaited<ReturnType<Platform['createService']>>;
  lines: Record<string, unknown>[];
  raw: string[];
  closed: boolean;
}
const running: Running[] = [];
const receivers: Awaited<ReturnType<App['startFakeReceiver']>>[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) if (!r.closed) await r.svc.close();
  for (const r of receivers.splice(0)) await r.close();
  vi.unstubAllEnvs();
});

async function start(env: Record<string, string>): Promise<Running> {
  const { raw, lines, stream } = fx.collector();
  const svc = await platform.createService({ name: 'demo-svc', module: app.ErrModule, env, clock: platform.fakeClock(), logDestination: stream });
  const r = { svc, lines, raw, closed: false };
  running.push(r);
  return r;
}
async function close(r: Running): Promise<void> {
  r.closed = true;
  await r.svc.close();
}
async function receiver(o?: Parameters<App['startFakeReceiver']>[0]) {
  const r = await app.startFakeReceiver(o);
  receivers.push(r);
  return r;
}

/** 로그인한 팬의 요청: 이메일·전화번호 본문, 쿼리 문자열, 쿠키, 머리, 클라이언트 IP(직접·전달)를 싣는다 */
function fanRequest(r: Running, method: string, path: string, payload?: string, extraHeaders: Record<string, string> = {}) {
  return r.svc.http.inject({
    method,
    url: `${path}?q=${SECRETS.query}`,
    remoteAddress: SECRETS.ip,
    headers: {
      'content-type': 'application/json',
      cookie: `sid=${SECRETS.cookie}; theme=dark`,
      'x-fan-note': SECRETS.header,
      'x-forwarded-for': SECRETS.forwardedIp,
      ...extraHeaders,
    },
    payload: payload ?? JSON.stringify({ email: SECRETS.email, phone: SECRETS.phone, note: SECRETS.note }),
  });
}
const traceIdOf = (res: { payload: string }) => (JSON.parse(res.payload) as { traceId: string }).traceId;
const requestLines = (r: Running) => r.lines.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('request'));

describe('V-T39 ① 서버 오류 수집 잠금', () => {
  test('V-T39 ① [ASVS v5.0.0-14.2.3] 로그인한 요청의 5xx 사건에 IP·본문·쿠키·쿼리 값이 없고 사용자는 accountRef뿐이다', async () => {
    const recv = await receiver();
    const s = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    expect(s.svc.errorReporting.enabled).toBe(true);
    const res = await fanRequest(s, 'POST', '/v1/err/profile');
    expect(res.statusCode).toBe(500);
    const traceId = traceIdOf(res);
    await recv.waitFor(1);
    await s.svc.errorReporting.flush(5_000);

    expect(recv.rejected).toEqual([]);
    const events = recv.events();
    expect(events).toHaveLength(1);
    const [event] = events;
    // 받은 바이트 전체(묶음 머리·항목·본문)와 보낸 요청의 주소·머리에서 찾는다
    const everything = recv.envelopes.map((e) => `${e.url}\n${JSON.stringify(e.headers)}\n${e.raw.toString('utf8')}`).join('\n');
    for (const [what, value] of Object.entries(SECRETS)) expect(everything, what).not.toContain(value);
    expect(everything).not.toContain(app.RAW_ACCOUNT_ID);
    expect(everything).not.toContain('ip_address');
    expect(everything).not.toContain('{{auto}}');

    // 사용자 칸은 정규 로그 줄과 같은 가명 accountRef 하나뿐이다
    const [line] = requestLines(s);
    expect(line.accountRef).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(event.user).toEqual({ id: line.accountRef });
    // 응답과 같은 traceId 태그. 받는 곳이 연결 주소로 IP를 짐작하지 않게 한다
    expect((event.tags as Record<string, unknown>).traceId).toBe(traceId);
    expect(event).not.toHaveProperty('request');
    expect((event.sdk as { settings?: unknown }).settings).toEqual({ infer_ip: 'never' });
    // 진짜 오류가 갔다(쿼리 글은 남고 매개변수 값은 빠진 사본)
    const [exception] = (event.exception as { values: { type: string; value: string }[] }).values;
    expect(exception.type).toBe('DrizzleQueryError');
    expect(exception.value).toContain('insert into fan_profile (email, phone, note) values ($1, $2, $3)');
    // 사건 묶음 머리와 항목의 사건 ID가 같다(묶음 형식과 짝)
    expect(recv.envelopes[0].header.event_id).toBe(event.event_id);
    // 오류 수집으로 보내는 요청도 바깥 호출이다: 추적 문맥을 싣지 않는다
    for (const h of SENTRY_TRACE_HEADERS) expect(recv.envelopes[0].headers, h).not.toHaveProperty(h);
    // 시작 로그 한 줄은 켬과 까닭만 남기고 DSN(공개 키)은 남기지 않는다
    expect(s.lines.find((l) => l.kind === 'error-reporting')).toMatchObject({ kind: 'error-reporting', enabled: true });
    expect(s.raw.join('')).not.toContain(recv.key);
  });

  test('V-T39 ① 4xx와 정상 분기 거절은 보내지 않는다', async () => {
    const recv = await receiver();
    const s = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    const statuses: number[] = [];
    // 같은 요청 모양으로: 깨진 본문(400), 없는 경로(404), 좌석 경합(정상 분기 409), 과부하(429)
    statuses.push((await fanRequest(s, 'POST', '/v1/err/crash', '{"email":')).statusCode);
    statuses.push((await fanRequest(s, 'POST', '/v1/err/nowhere')).statusCode);
    statuses.push((await fanRequest(s, 'POST', '/v1/err/hold')).statusCode);
    statuses.push((await fanRequest(s, 'POST', '/v1/err/busy')).statusCode);
    // 마지막에 5xx 하나: 빈 결과가 통과로 새지 않게 이것만 1건 와야 한다
    const crash = await fanRequest(s, 'POST', '/v1/err/crash');
    statuses.push(crash.statusCode);
    expect(statuses).toEqual([400, 404, 409, 429, 500]);
    await recv.waitFor(1);
    await s.svc.errorReporting.flush(5_000);
    const events = recv.events();
    expect(events.map((e) => (e.tags as Record<string, unknown>).traceId)).toEqual([traceIdOf(crash)]);
    expect((events[0].exception as { values: { value: string }[] }).values[0].value).toBe('profile store exploded');
  });

  test('V-T39 ① DSN이 비면 수신기 요청이 0이고 서비스가 뜬다', async () => {
    const recv = await receiver();
    // Sentry SDK 기본 환경 변수(SENTRY_DSN)가 있어도 PEAKET_SENTRY_DSN이 비면 끈다
    vi.stubEnv('SENTRY_DSN', recv.dsn);
    for (const empty of [undefined, '', '   ']) {
      const env: Record<string, string> = { ...BASE, SENTRY_DSN: recv.dsn };
      if (empty !== undefined) env.PEAKET_SENTRY_DSN = empty;
      const off = await start(env);
      expect(off.svc.errorReporting.enabled, JSON.stringify(empty)).toBe(false);
      expect(off.lines.find((l) => l.kind === 'error-reporting')).toMatchObject({ kind: 'error-reporting', enabled: false });
      expect((await fanRequest(off, 'POST', '/v1/err/crash')).statusCode).toBe(500);
      const ready = await off.svc.management.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      await off.svc.errorReporting.flush(1_000);
      await close(off);
    }
    // 같은 수신기로 켠 서비스의 5xx가 도착할 때까지 기다린 뒤 센다(끈 서비스의 사건이 늦게 오는 것도 잡히게)
    const on = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    const crash = await fanRequest(on, 'POST', '/v1/err/crash');
    await recv.waitFor(1);
    await on.svc.errorReporting.flush(5_000);
    expect(recv.envelopes).toHaveLength(1);
    expect(recv.rejected).toEqual([]);
    expect(recv.events().map((e) => (e.tags as Record<string, unknown>).traceId)).toEqual([traceIdOf(crash)]);
  });

  test('V-T39 ① [ASVS v5.0.0-14.2.3] local·ci 밖에서는 http:// DSN이면 끄고 경고 한 줄을 남기며, https://면 켠다(RV012-1)', async () => {
    // 정본 docs/api/guidelines.md §8 바깥 호출 표의 오류 수집 행은 HTTPS다. 평문 받는 곳은 로컬 가짜 수신기(local·ci)에만 허락한다
    const recv = await receiver();
    const httpsDsn = recv.dsn.replace(/^http:/, 'https:');
    const INTERNAL = 'internal-token-for-error-reporting-test';
    const deployed = (env: string) => ({ ...BASE, PEAKET_ENV: env, PEAKET_INTERNAL_TOKEN: INTERNAL, PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 3).toString('base64') });
    for (const env of ['prod', 'staging', 'demo']) {
      const off = await start({ ...deployed(env), PEAKET_SENTRY_DSN: recv.dsn });
      expect(off.svc.errorReporting.enabled, env).toBe(false);
      // 시작 로그는 오류 수집 줄 하나이고 경고(꼴 틀림)다. DSN(공개 키)은 남기지 않는다
      const lines = off.lines.filter((l) => l.kind === 'error-reporting');
      expect(lines, env).toHaveLength(1);
      expect(lines[0], env).toMatchObject({ level: 'warn', enabled: false, reason: 'invalid-dsn' });
      expect(off.raw.join(''), env).not.toContain(recv.key);
      expect((await fanRequest(off, 'POST', '/v1/err/crash', undefined, { 'x-peaket-internal-token': INTERNAL })).statusCode, env).toBe(500);
      await off.svc.errorReporting.flush(1_000);
      await close(off);
      // https:// DSN이면 같은 환경에서 켠다
      const on = await start({ ...deployed(env), PEAKET_SENTRY_DSN: httpsDsn });
      expect(on.svc.errorReporting.enabled, env).toBe(true);
      expect(on.lines.filter((l) => l.kind === 'error-reporting'), env).toMatchObject([{ level: 'info', enabled: true }]);
      await close(on);
    }
    // local·ci에서는 http:// 가짜 수신기도 받는다. 그 사건이 온 뒤 세면 운영 환경 서비스의 사건은 0건이다
    const local = await start({ ...BASE, PEAKET_ENV: 'local', PEAKET_SENTRY_DSN: recv.dsn });
    expect(local.svc.errorReporting.enabled).toBe(true);
    await close(local);
    const ci = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    expect(ci.svc.errorReporting.enabled).toBe(true);
    const crash = await fanRequest(ci, 'POST', '/v1/err/crash');
    await recv.waitFor(1);
    await ci.svc.errorReporting.flush(5_000);
    expect(recv.rejected).toEqual([]);
    expect(recv.events().map((e) => (e.tags as Record<string, unknown>).traceId)).toEqual([traceIdOf(crash)]);
  });

  test('V-T39 ① [ASVS v5.0.0-14.2.3] SDK를 켜도 바깥 호출에 sentry-trace·baggage·traceparent가 없다', async () => {
    const recv = await receiver();
    const s = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    const recorded = await probeTraceHeaders(async (url) => {
      // 대조: 이 시험 무대에서 node:http 요청이 계측되어 traceparent가 실린다(아니면 아래 '없다'는 아무것도 보지 않은 것이다)
      await new Promise<void>((resolve, reject) => {
        const req = nodeHttpRequest(`${url}/control-node-http`, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end();
      });
      app.outbound.baseUrl = url;
      const res = await s.svc.http.inject({ method: 'GET', url: '/v1/err/call-out' });
      expect(res.statusCode).toBe(200);
      // 표본 표시를 켠 span과 Baggage가 있는 맥락에서 낸 5xx: 오류 수집으로 보내는 요청에도 추적 문맥이 실리지 않아야 한다
      expect((await fanRequest(s, 'POST', '/v1/err/crash')).statusCode).toBe(500);
      await recv.waitFor(1);
    });
    expect(recorded.map((r) => r.url)).toEqual(['/control-node-http', '/v1/payments/tgen_abc/confirm']);
    expect(recorded[0].headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    for (const h of SENTRY_TRACE_HEADERS) expect(recorded[1].headers, h).not.toHaveProperty(h);
    expect(recv.envelopes).toHaveLength(1);
    for (const h of SENTRY_TRACE_HEADERS) expect(recv.envelopes[0].headers, h).not.toHaveProperty(h);
  });

  test('V-T39 ① 서비스를 닫으면 남은 사건을 보낸 뒤 끝난다', async () => {
    // 늦게 답하는 받는 곳: close가 보내기를 기다리지 않으면 닫힌 때 답이 아직 없다
    const recv = await receiver({ respondAfterMs: 300 });
    const s = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    expect((await fanRequest(s, 'POST', '/v1/err/crash')).statusCode).toBe(500);
    await close(s);
    expect(recv.answered()).toBe(1);
    expect(recv.events()).toHaveLength(1);
  });

  test('OPS-050 받는 곳이 답하지 않아도 5xx 응답과 서비스 닫기가 끝난다', async () => {
    const recv = await receiver({ hang: true });
    const s = await start({ ...BASE, PEAKET_SENTRY_DSN: recv.dsn });
    expect((await fanRequest(s, 'POST', '/v1/err/crash')).statusCode).toBe(500);
    await recv.waitFor(1);
    // 시험 제한(기본 5초) 안에 닫혀야 한다. 받는 곳을 기다리며 멈추면 시험이 시간 초과로 실패한다
    await close(s);
    expect(recv.answered()).toBe(0);
  });

  test('V-T39 ① beforeSend는 요청·이동 기록·추가 칸을 지우고 사용자는 id만 두며 남은 칸은 로그와 같이 가린다', () => {
    // Sentry 서버 SDK가 요청 자료 통합을 켰을 때 사건에 싣는 칸들(Sentry 사건 형식 'request'·'user'·'breadcrumbs'·'extra')
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'a'.repeat(32),
      level: 'error',
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      tags: { traceId: 'b'.repeat(32), email: SECRETS.email },
      user: { id: 'ref-22', email: SECRETS.email, ip_address: SECRETS.ip, username: 'fan' },
      request: { url: `https://api.peaket.example/v1/err/profile?q=${SECRETS.query}`, query_string: `q=${SECRETS.query}`, cookies: { sid: SECRETS.cookie }, headers: { 'x-fan-note': SECRETS.header }, data: { phone: SECRETS.phone } },
      breadcrumbs: [{ message: SECRETS.note }],
      extra: { note: SECRETS.note },
      contexts: { runtime: { name: 'node' }, trace: { trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16) }, request: { ip: SECRETS.forwardedIp } },
      sdk: { name: 'sentry.javascript.core', version: '11.15.0' },
    };
    const out = platform.lockEvent(event);
    expect(out).not.toHaveProperty('request');
    expect(out).not.toHaveProperty('breadcrumbs');
    expect(out).not.toHaveProperty('extra');
    expect(out.user).toEqual({ id: 'ref-22' });
    expect(Object.keys(out.contexts ?? {}).sort()).toEqual(['runtime', 'trace']);
    expect(out.tags?.traceId).toBe('b'.repeat(32));
    expect(out.sdk).toEqual({ name: 'sentry.javascript.core', version: '11.15.0', settings: { infer_ip: 'never' } });
    const text = JSON.stringify(out);
    for (const [what, value] of Object.entries(SECRETS)) expect(text, what).not.toContain(value);
  });
});
