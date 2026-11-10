// 정규 로그 줄(ADR-0069 결정 11, docs/observability.md §7, openspec 변경 add-service-logging 결정 2·3·5).
// OTel SDK 없이 도는 시험이다. 표본 문턱과 추적 문맥은 telemetry.test.ts가 SDK를 띄워 본다.
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { NestPinoLogger, PlatformConfigError, createPlatformLogger, createService, fakeClock, loadPlatformConfig } from '../src/index.js';
import { DemoModule, collector, start, type LogLine, type Started } from './fixture.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.svc.close();
  s = undefined;
});

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_VERSION: '1.4.2', PEAKET_AZ: 'apne2-az1', PEAKET_POD: 'demo-svc-7f9c-abcde' };

const only = (lines: LogLine[]) => {
  expect(lines).toHaveLength(1);
  return lines[0];
};

describe('정규 로그 줄의 필드', () => {
  test('[ASVS v5.0.0-16.2.1] ADR0069_정상요청은_줄하나에_필수필드와_정규로그줄필드가있다', async () => {
    s = await start(BASE, { now: Date.parse('2026-11-01T05:03:05.120Z') });
    const res = await s.inject({ method: 'GET', url: '/v1/demo/events/e-1/rich?q=raw', headers: { 'x-peaket-app': 'web', 'user-agent': CHROME } });
    expect(res.statusCode).toBe(200);
    const line = only(s.requests());
    expect(line).toMatchObject({
      // 줄을 쓴 때(처리기가 시계를 12ms 돌린 뒤 요청이 끝난 때)의 KST
      ts: '2026-11-01T14:03:05.132+09:00',
      level: 'info',
      service: 'demo-svc',
      env: 'ci',
      version: '1.4.2',
      az: 'apne2-az1',
      pod: 'demo-svc-7f9c-abcde',
      route: '/v1/demo/events/{eventId}/rich',
      method: 'GET',
      status: 200,
      durationMs: 12,
      msg: 'request',
      app: 'web',
      client: 'chrome/130',
      eventId: 'e-1',
      pg: 'toss',
      queuePhase: 'purchase',
      flags: ['seat-map-v2', 'degraded-payment'],
      orderId: '0b7e7c52-1111-4c2a-9e55-1d2a3b4c5d6e',
      dep: { redis: 7, pg: 1.5 },
      sampleRate: 1,
    });
    expect(line.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(line).not.toHaveProperty('err');
    // 원문 User-Agent·실제 경로·쿼리는 줄에 없다
    const text = JSON.stringify(line);
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('/v1/demo/events/e-1/rich');
    expect(text).not.toContain('q=raw');
  });

  test('[ASVS v5.0.0-16.2.5] ADR0053_identify는_가명만남기고_원문값은_줄어디에도없다', async () => {
    s = await start(BASE);
    await s.inject({ method: 'GET', url: '/v1/demo/events/e-1/rich' });
    const line = only(s.requests());
    for (const k of ['pidRef', 'sidRef', 'accountRef']) expect(line[k]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set([line.pidRef, line.sidRef, line.accountRef]).size).toBe(3);
    const text = s.raw.join('');
    for (const raw of ['p-123', 's-456', 'a-789']) expect(text).not.toContain(raw);
  });

  test('ADR0053_서비스뼈대의가명함수는_정규로그줄과같은키로_같은가명을준다', async () => {
    s = await start(BASE);
    await s.inject({ method: 'GET', url: '/v1/demo/events/e-1/rich' });
    const line = only(s.requests());
    // 업무 로그 줄(예: trust-svc 보안 로그의 처리자)이 원문 대신 쓰는 가명이 정규 로그 줄의 accountRef와 이어진다
    expect(s.svc.pseudonymizer.ref('a-789')).toBe(line.accountRef);
    expect(s.svc.pseudonymizer.ref('p-123')).toBe(line.pidRef);
    expect(JSON.stringify(s.svc.pseudonymizer)).toBe('"[LogPseudonymizer]"');
  });

  test('ADR0069_모르는값은_칸을뺀다', async () => {
    s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' });
    await s.inject({ method: 'GET', url: '/v1/demo/items/a1', headers: { 'x-peaket-app': 'evil<script>' } });
    const line = only(s.requests());
    // 시험 도구의 기본 User-Agent(lightMyRequest)는 계열을 모르는 값이라 other다
    expect(line.client).toBe('other');
    for (const k of ['app', 'az', 'pg', 'queuePhase', 'flags', 'dep', 'eventId', 'pidRef', 'err']) expect(line).not.toHaveProperty(k);
    expect(line.version).toBe('unknown');
    expect(typeof line.pod).toBe('string');
  });

  test('[ASVS v5.0.0-16.4.1] ADR0069_줄바꿈과따옴표가든값도_JSON한줄로_이스케이프된다', async () => {
    s = await start();
    s.raw.length = 0;
    await s.inject({ method: 'GET', url: '/v1/demo/newline' });
    const chunk = s.raw.join('');
    expect(chunk.trimEnd().split('\n')).toHaveLength(1);
    expect(only(s.requests()).flags).toEqual(['a\n{"level":"fatal","msg":"forged"}']);
    expect(s.lines.filter((l) => l.msg === 'forged')).toHaveLength(0);
  });
});

describe('오류의 err', () => {
  test('[ASVS v5.0.0-16.3.4] ADR0069_예상하지못한오류는_그요청의줄err에_이름메시지스택이남고_다른기록줄은없다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/boom' });
    const line = only(s.requests());
    expect(line).toMatchObject({ level: 'error', status: 500, traceId: res.json().traceId, sampleRate: 1 });
    const err = line.err as { type: string; message: string; stack: string };
    expect(err.type).toBe('Error');
    expect(err.message).toMatch(/secret_table/);
    expect(err.stack).toMatch(/DemoController\.boom/);
    // 예상하지 못한 오류를 따로 쓰던 줄(옛 reportToStderr)은 없다
    expect(s.lines.filter((l) => l.msg === 'unexpected error')).toHaveLength(0);
  });

  test('[ASVS v5.0.0-16.2.5] ADR0069_4xx는_err에_종류와상태문구만_본문이든원래메시지와스택이없다', async () => {
    s = await start();
    await s.inject({ method: 'POST', url: '/v1/demo/echo', headers: { 'content-type': 'application/json' }, payload: '{"password":"hunter2"' });
    await s.inject({ method: 'GET', url: '/v1/nope/123?token=abc' });
    const [bad, missing] = s.requests();
    expect(bad).toMatchObject({ level: 'warn', status: 400, err: { message: 'Bad Request' } });
    // Fastify 본문 해석 오류는 Nest가 HTTP 예외로 감싸 넘긴다. 종류 이름만 남는다
    expect((bad.err as { type: string }).type).toMatch(/^(FST_|HttpException|BadRequestException)/);
    expect(missing).toMatchObject({ level: 'warn', status: 404, route: 'unmatched', err: { message: 'Not Found' } });
    for (const l of [bad, missing]) expect(l.err).not.toHaveProperty('stack');
    const text = s.raw.join('');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('token=abc');
  });

  test('ADR0069_이름붙은오류는_Problem이름과제목이고_정상분기는_info', async () => {
    s = await start();
    await s.inject({ method: 'POST', url: '/v1/demo/holds' });
    await s.inject({ method: 'GET', url: '/v1/demo/busy' });
    const [hold, busy] = s.requests();
    expect(hold).toMatchObject({ level: 'info', status: 409, err: { type: 'seat-already-held', message: '좌석이 이미 선택되었습니다' }, sampleRate: 1 });
    expect(busy).toMatchObject({ level: 'warn', status: 429, err: { type: 'server-busy' }, sampleRate: 1 });
  });

  test('ADR0069_라우터앞에서끝난요청도_unmatched줄하나를_응답과같은traceId로남긴다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/x/%E0%A4%A' });
    const line = only(s.requests());
    expect(line).toMatchObject({ route: 'unmatched', status: 400, level: 'warn', traceId: res.json().traceId, sampleRate: 1 });
    expect(JSON.stringify(line)).not.toContain('E0%A4');
  });

  test('ADR0069_응답전에끊긴요청은_aborted줄하나를남긴다', async () => {
    s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const { port } = await s.svc.listen('127.0.0.1');
    const { gate, slowGate } = await import('./fixture.js');
    slowGate.current = gate();
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/demo/wait', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end('{"a":1}');
    await slowGate.current.reached;
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    slowGate.current.open();
    await new Promise((r) => setTimeout(r, 50));
    // 처리기가 끝난 뒤에 쓴다. status는 보내려던 응답의 상태다
    const line = only(s.requests());
    expect(line).toMatchObject({ msg: 'request aborted', aborted: true, route: '/v1/demo/wait', method: 'POST', status: 201 });
  });

  test('[ASVS v5.0.0-16.3.4] ADR0069_끊긴뒤에난_예상하지못한오류도_그요청줄의err에남는다', async () => {
    // 코드 리뷰(2026-11-01): 끊긴 때 줄을 먼저 써서 그 뒤 처리기가 던진 오류가 어디에도 남지 않았다(FND-050보다 후퇴)
    s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1000000', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const { port } = await s.svc.listen('127.0.0.1');
    const { gate, slowGate } = await import('./fixture.js');
    slowGate.current = gate();
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/demo/wait-boom', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end('{"a":1}');
    await slowGate.current.reached;
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    slowGate.current.open();
    await new Promise((r) => setTimeout(r, 50));
    const line = only(s.requests());
    expect(line).toMatchObject({ aborted: true, status: 500, level: 'error', sampleRate: 1, err: { type: 'Error', message: 'db exploded' } });
  });

  async function abortGet(path: string, headers: Record<string, string> = {}) {
    s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1000000', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const { port } = await s.svc.listen('127.0.0.1');
    const { gate, slowGate } = await import('./fixture.js');
    slowGate.current = gate();
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers });
    req.on('error', () => {});
    req.end();
    await slowGate.current.reached;
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    return slowGate.current;
  }

  test('[ASVS v5.0.0-16.3.4] ADR0069_본문없는요청이_끊긴뒤에난오류도_err에남는다', async () => {
    // 다시 본 리뷰(2026-11-01): GET은 끊기면 Fastify가 바로 onRequestAbort를 불러 상태와 err 없이 줄을 썼다
    const g = await abortGet('/v1/demo/wait-boom');
    g.open();
    await new Promise((r) => setTimeout(r, 50));
    expect(only(s!.requests())).toMatchObject({ aborted: true, status: 500, level: 'error', err: { message: 'db exploded on get' } });
  });

  test('ADR0069_끊긴뒤처리기가끝나지않아도_남은시간뒤에_aborted줄하나를남긴다', async () => {
    // 다시 본 리뷰(2026-11-01): 처리기가 응답을 보내지 않으면 줄이 영영 없었다. 남은 시간 + 1초 뒤에 쓴다
    await abortGet('/v1/demo/hang', { 'x-peaket-deadline-ms': '30' });
    expect(s!.requests()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1_200));
    const line = only(s!.requests());
    expect(line).toMatchObject({ aborted: true, route: '/v1/demo/hang', sampleRate: 1 });
    expect(line).not.toHaveProperty('status');
  });
});

describe('표본(SDK 없이 볼 수 있는 것)', () => {
  const RARE = { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1000000' };

  test('ADR0076_정상응답은_문턱밖이면_남지않는다', async () => {
    s = await start(RARE);
    for (let i = 0; i < 5; i++) await s.inject({ method: 'GET', url: '/v1/demo/items/a1' });
    // 백만 건에 한 건이라 다섯 번 모두 문턱 밖일 가능성이 매우 크다(남을 확률 약 0.0005%)
    expect(s.requests()).toHaveLength(0);
  });

  test('ADR0076_4xx_5xx와_전수표시는_비율과관계없이_sampleRate1로_남는다', async () => {
    s = await start(RARE);
    await s.inject({ method: 'POST', url: '/v1/demo/holds' });
    await s.inject({ method: 'GET', url: '/v1/demo/boom' });
    await s.inject({ method: 'GET', url: '/v1/demo/soon' });
    expect(s.requests().map((l) => [l.status, l.sampleRate])).toEqual([
      [409, 1],
      [500, 1],
      [200, 1],
    ]);
  });

  test('ADR0076_경로의SLO지연을넘은요청은_전수로남는다', async () => {
    s = await start(RARE);
    await s.inject({ method: 'GET', url: '/v1/demo/slow-120' });
    expect(only(s.requests())).toMatchObject({ status: 200, sampleRate: 1, durationMs: 120 });
  });

  test('ADR0125_실행중에_표본비율을_바꾼다', async () => {
    s = await start(RARE);
    s.svc.logs.setSampleOneIn(1);
    await s.inject({ method: 'GET', url: '/v1/demo/items/a1' });
    expect(only(s.requests()).sampleRate).toBe(1);
    expect(() => s?.svc.logs.setSampleOneIn(0)).toThrow(RangeError);
  });
});

describe('서비스 로거', () => {
  test('[ASVS v5.0.0-16.2.5] ADR0053_가림규칙이_연락처와인증값을가리고_paymentKey는뒤4자만남긴다', async () => {
    s = await start();
    await s.inject({ method: 'GET', url: '/v1/demo/log-inside' });
    const inside = s.lines.find((l) => l.msg === 'inside') as LogLine & { card: Record<string, string> };
    expect(inside).toMatchObject({ email: '[REDACTED]', card: { authorization: '[REDACTED]', paymentKey: '****abcd' }, service: 'demo-svc' });
    expect(s.raw.join('')).not.toMatch(/fan@example\.com|Bearer secret|tgen_2026/);
    // 요청 안의 줄에는 그 요청의 traceId가 자동으로 들어간다(observability §2 'Pino 로그 traceId 자동 주입')
    expect(inside.traceId).toBe(only(s.requests()).traceId);
  });

  test('[ASVS v5.0.0-16.2.5] ADR0053_가림규칙은_대소문자와_깊이에관계없이걸고_원래객체를바꾸지않는다', async () => {
    // 코드 리뷰(2026-11-01): 대문자 머리 이름(Authorization·Cookie)과 깊이 넷 이상의 칸이 그대로 남았다
    s = await start();
    const obj = { headers: { Authorization: 'Bearer AAA', Cookie: 'sid=BBB', 'Set-Cookie': 'x=1' }, Email: 'x@y.z', a: { b: { c: { d: { email: 'deep@x.y' } } } }, list: [{ PaymentKey: 'tgen_20261101wxyz' }] };
    s.svc.logger.info(obj, 'case');
    const text = s.raw.join('');
    for (const raw of ['Bearer AAA', 'sid=BBB', 'x=1', 'x@y.z', 'deep@x.y', 'tgen_2026']) expect(text).not.toContain(raw);
    expect(s.lines.find((l) => l.msg === 'case')).toMatchObject({ list: [{ PaymentKey: '****wxyz' }] });
    expect(obj.headers.Authorization).toBe('Bearer AAA');
  });

  test('[ASVS v5.0.0-16.2.5] ADR0053_가림규칙은_클래스객체와_child로거값에도건다', async () => {
    // 다시 본 리뷰(2026-11-01): 평범한 객체만 들여다봐 DTO(클래스 객체)와 child()로 붙인 값이 원문으로 남았다
    s = await start();
    class Dto {
      email = 'dto@x.y';
      nested = { accountId: 'a-dto' };
    }
    s.svc.logger.info({ body: new Dto() }, 'dto');
    s.svc.logger.child({ accountId: 'a-child', email: 'child@x.y' }).info('child');
    const text = s.raw.join('');
    for (const raw of ['dto@x.y', 'a-dto', 'a-child', 'child@x.y']) expect(text).not.toContain(raw);
    expect(s.lines.find((l) => l.msg === 'dto')).toMatchObject({ body: { email: '[REDACTED]', nested: { accountId: '[REDACTED]' } } });
  });

  test('[ASVS v5.0.0-16.2.5] ADR0053_err밖에든Error도_이름메시지스택만남기고_그안의칸을내보내지않는다', async () => {
    // 세 번째 리뷰(2026-11-01): Error를 그대로 둬 HTTP 클라이언트 오류의 config.headers.Authorization이 원문으로 나갔다
    s = await start();
    const e = Object.assign(new Error('upstream failed'), { config: { headers: { Authorization: 'Bearer SECRET' } }, email: 'a@b.c' });
    s.svc.logger.warn({ error: e, nested: { err: e } }, 'errors');
    const text = s.raw.join('');
    expect(text).not.toMatch(/Bearer SECRET|a@b\.c/);
    expect(s.lines.find((l) => l.msg === 'errors')).toMatchObject({ error: { type: 'Error', message: 'upstream failed' }, nested: { err: { type: 'Error' } } });
  });

  test('ADR0053_서로를가리키는객체도_줄이커지지않는다', async () => {
    // 세 번째 리뷰(2026-11-01): 같은 객체를 다시 만났는지 보지 않아 순환 객체 하나가 수십 MB 줄이 됐다
    s = await start();
    const order: Record<string, unknown> = { id: 'o-1' };
    order.items = Array.from({ length: 100 }, (_, i) => ({ i, order }));
    const self: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) self[`k${i}`] = self;
    s.raw.length = 0;
    const t = performance.now();
    s.svc.logger.info({ order, self }, 'cycles');
    expect(performance.now() - t).toBeLessThan(200);
    expect(s.raw.join('').length).toBeLessThan(200_000);
    expect(s.lines.find((l) => l.msg === 'cycles')).toMatchObject({ self: { k0: '[Circular]' } });
  });

  test('ADR0053_toJSON이자기자신을돌려주는객체도_칸을펼쳐가린다', async () => {
    // 네 번째 리뷰(2026-11-01): 돌려받은 같은 객체를 순환으로 봐 내용이 통째로 빠졌다
    s = await start();
    class Self {
      x = 1;
      email = 'e@x.y';
      toJSON() {
        return this;
      }
    }
    s.svc.logger.info({ s: new Self() }, 'self-json');
    expect(s.lines.find((l) => l.msg === 'self-json')).toMatchObject({ s: { x: 1, email: '[REDACTED]' } });
  });

  test('ADR0053_원문식별값칸도_가린다', async () => {
    s = await start();
    s.svc.logger.info({ pid: 'p-1', sessionId: 's-1', accountId: 'a-1', ip: '203.0.113.7', nested: { clientIp: '203.0.113.8' } }, 'raw ids');
    const line = s.lines.find((l) => l.msg === 'raw ids');
    expect(line).toMatchObject({ pid: '[REDACTED]', sessionId: '[REDACTED]', accountId: '[REDACTED]', ip: '[REDACTED]', nested: { clientIp: '[REDACTED]' } });
  });

  test('관리계정로그인·해제·재인증·패스키등록의1회용값도가린다(BOT-120·121·122)', async () => {
    s = await start();
    s.svc.logger.info({ loginStep: 'l-1', unlockToken: 'u-1', humanCheckToken: 'h-1', reauthStep: 'r-1', reauthToken: 't-1', nested: { registrationId: 'g-1' } }, 'one-time values');
    const line = s.lines.find((l) => l.msg === 'one-time values');
    expect(line).toMatchObject({ loginStep: '[REDACTED]', unlockToken: '[REDACTED]', humanCheckToken: '[REDACTED]', reauthStep: '[REDACTED]', reauthToken: '[REDACTED]', nested: { registrationId: '[REDACTED]' } });
  });

  test('ADR0069_NestJS자체기록도_같은모양의JSON한줄이다', () => {
    const c = collector();
    const logger = new NestPinoLogger(
      // 시험용으로 바로 만든 로거
      createLoggerForTest(c.stream),
    );
    logger.error('부트스트랩 실패', 'Error: x\n    at y', 'NestApplication');
    expect(c.lines[0]).toMatchObject({ level: 'error', msg: '부트스트랩 실패', context: 'NestApplication', service: 't' });
  });

  test('ADR0053_로컬CI에서_가명키가없으면_경고줄하나를남긴다', async () => {
    s = await start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' });
    expect(s.lines.filter((l) => l.level === 'warn' && String(l.msg).includes('PEAKET_LOG_PSEUDONYM_KEY'))).toHaveLength(1);
  });
});

describe('시작 설정', () => {
  test('ADR0053_운영에서_가명키가없으면_서비스가시작하지않는다', async () => {
    await expect(createService({ name: 'demo-svc', module: DemoModule, env: { PEAKET_ENV: 'prod' } })).rejects.toThrow(PlatformConfigError);
  });

  test('ADR0069_로그설정의_잘못된값은_시작하지않는다', () => {
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '0' })).toThrow(/PEAKET_LOG_SAMPLE_ONE_IN/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1.5' })).toThrow(/PEAKET_LOG_SAMPLE_ONE_IN/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'verbose' })).toThrow(/PEAKET_LOG_LEVEL/);
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_LOG_SLO_LATENCY_MS: '-1' })).toThrow(/PEAKET_LOG_SLO_LATENCY_MS/);
  });
});

function createLoggerForTest(stream: NodeJS.WritableStream) {
  return createPlatformLogger({ service: 't', env: 'ci', version: 'v', clock: fakeClock(), level: 'info', destination: stream });
}
