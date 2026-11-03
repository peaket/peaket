// 네 신호 계측(NFR-011, ADR-0077 결정 1·5, ADR-0069 결정 5, docs/observability.md §3·§8, docs/verification.md §2.7 지표 내보내기 층).
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { LATENCY_BUCKETS_SECONDS } from '../src/index.js';
import { gate, sample, slowGate, start, type Started } from './fixture.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.svc.close();
  s = undefined;
});

const H = 'http_server_request_duration_seconds';

describe('지연 히스토그램 칸', () => {
  test('ADR0077_표준칸20개는_observability_8의목록과같다', () => {
    const doc = readFileSync(new URL('../../../docs/observability.md', import.meta.url), 'utf8');
    const m = /목록\(초\)은 ([0-9., ]+)\(\+Inf\)이다/.exec(doc);
    expect(m, 'observability §8의 표준 칸 목록 문장').not.toBeNull();
    const listed = m![1].split(',').map((x) => Number(x.trim()));
    expect([...LATENCY_BUCKETS_SECONDS]).toEqual(listed);
    expect(LATENCY_BUCKETS_SECONDS).toHaveLength(20);
  });

  test('ADR0077_SLO와경보기준값이_모두칸경계에있다', () => {
    // ADR-0077 결정 1의 표와 ADR-0087 결정 29(FCP 1.8초·TTFB 0.8초)
    for (const v of [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8, 1, 1.5, 1.8, 2, 2.5, 3, 5, 10, 60]) {
      expect(LATENCY_BUCKETS_SECONDS).toContain(v);
    }
  });

  test('NFR011_응답한요청은_표준칸히스토그램에_경로틀라벨로든다', async () => {
    s = await start();
    expect((await s.inject({ method: 'GET', url: '/v1/demo/items/itm-secret-77' })).statusCode).toBe(200);
    expect((await s.inject({ method: 'GET', url: '/v1/demo/slow-120' })).statusCode).toBe(200);
    const text = await s.metrics();
    const base = { service: 'demo-svc', route: '/v1/demo/items/{itemId}', method: 'GET', status_class: '2xx' };
    expect(sample(text, `${H}_count`, base)).toBe(1);
    const les = text
      .split('\n')
      .filter((l) => l.startsWith(`${H}_bucket{`) && l.includes('route="/v1/demo/items/{itemId}"'))
      .map((l) => /le="([^"]+)"/.exec(l)![1]);
    expect(les).toEqual([...LATENCY_BUCKETS_SECONDS.map(String), '+Inf']);
    // 실제 자원 ID는 라벨에 들어가지 않는다(observability §8)
    expect(text).not.toMatch(/itm-secret-77/);
    // 시계로 잰 120ms는 0.15 칸에 들고 0.1 칸에는 들지 않는다
    const slow = { route: '/v1/demo/slow-120', status_class: '2xx' };
    expect(sample(text, `${H}_bucket`, { ...slow, le: '0.1' })).toBe(0);
    expect(sample(text, `${H}_bucket`, { ...slow, le: '0.15' })).toBe(1);
  });

  test('NFR011_맞는경로가없으면_route는unmatched', async () => {
    s = await start();
    await s.inject({ method: 'GET', url: '/v1/nope/abc-123' });
    const text = await s.metrics();
    expect(sample(text, `${H}_count`, { route: 'unmatched', status_class: '4xx' })).toBe(1);
    expect(text).not.toMatch(/abc-123/);
  });
});

describe('오류와 정상 분기', () => {
  test('VT_지표내보내기_5xx는오류카운터를올리고_정상분기카운터는그대로', async () => {
    s = await start();
    await s.inject({ method: 'GET', url: '/v1/demo/boom' });
    const text = await s.metrics();
    expect(sample(text, 'http_server_errors_total', { route: '/v1/demo/boom', status_class: '5xx' })).toBe(1);
    expect(sample(text, 'http_server_business_rejections_total', { route: '/v1/demo/boom' })).toBeUndefined();
  });

  test('VT_지표내보내기_409경합패배는정상분기카운터를올리고_오류카운터는그대로', async () => {
    s = await start();
    await s.inject({ method: 'POST', url: '/v1/demo/holds' });
    // 정상 분기 표시가 없는 409(처리 중)는 정상 분기가 아니다
    await s.inject({ method: 'POST', url: '/v1/demo/replays' });
    const text = await s.metrics();
    expect(sample(text, 'http_server_business_rejections_total', { route: '/v1/demo/holds', status_class: '4xx' })).toBe(1);
    expect(sample(text, 'http_server_business_rejections_total', { route: '/v1/demo/replays' })).toBeUndefined();
    expect(sample(text, 'http_server_errors_total', { route: '/v1/demo/holds' })).toBeUndefined();
  });
});

describe('처리 중 요청과 포화도', () => {
  test('ADR0077_처리중요청게이지는_처리기안에서1이고_끝나면0', async () => {
    s = await start();
    slowGate.current = gate();
    const pending = s.inject({ method: 'GET', url: '/v1/demo/wait' });
    await slowGate.current.reached;
    const labels = { service: 'demo-svc', route: '/v1/demo/wait', method: 'GET' };
    expect(sample(await s.metrics(), 'http_server_active_requests', labels)).toBe(1);
    slowGate.current.open();
    expect((await pending).statusCode).toBe(200);
    expect(sample(await s.metrics(), 'http_server_active_requests', labels)).toBe(0);
  });

  test('ADR0077_본문을다받은POST가_처리중에끊겨도_게이지는0으로돌아온다', async () => {
    s = await start({ PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const { port } = await s.svc.listen('127.0.0.1');
    slowGate.current = gate();
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/demo/wait', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {});
    req.end('{"a":1}');
    await slowGate.current.reached;
    const labels = { route: '/v1/demo/wait', method: 'POST' };
    expect(sample(await s.metrics(), 'http_server_active_requests', labels)).toBe(1);
    req.destroy();
    let after: number | undefined = 1;
    for (let i = 0; i < 50 && after !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = sample(await s.metrics(), 'http_server_active_requests', labels);
    }
    expect(after).toBe(0);
    slowGate.current.open();
  });

  test('ADR0077_Node기본지표_이벤트루프지연을낸다', async () => {
    s = await start();
    expect(await s.metrics()).toMatch(/^nodejs_eventloop_lag_seconds /m);
  });
});

describe('[ASVS v5.0.0-13.4.5] 지표·문서 경로', () => {
  test('지표는관리포트에서만_앱포트의/metrics는404', async () => {
    s = await start();
    expect((await s.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    const res = await s.svc.management.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect((await s.svc.management.inject({ method: 'GET', url: '/api-json' })).statusCode).toBe(404);
  });

  test('DT38_실행중인서비스는_API문서경로를내지않는다', async () => {
    s = await start();
    for (const url of ['/api', '/api-json', '/api-yaml', '/docs', '/docs-json']) {
      expect((await s.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});

describe('남은 시간(HTTP)', () => {
  test('GL5_처리기는받은남은시간을보고_다음호출에는상한과작은쪽을준다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/deadline', headers: { 'x-peaket-deadline-ms': '40' } });
    expect(res.json()).toEqual({ remaining: 30, next: 30 });
  });

  test('GL5_모자라면_504_deadline-exceeded_오류카운터에든다', async () => {
    s = await start();
    const res = await s.inject({ method: 'GET', url: '/v1/demo/need-20', headers: { 'x-peaket-deadline-ms': '5' } });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ type: 'https://peaket.example/problems/deadline-exceeded', status: 504 });
    expect(sample(await s.metrics(), 'http_server_errors_total', { route: '/v1/demo/need-20', status_class: '5xx' })).toBe(1);
  });

  test('GL5_본문을읽은뒤에도_처리기는같은요청맥락을본다', async () => {
    s = await start();
    const res = await s.inject({
      method: 'POST',
      url: '/v1/demo/deadline',
      headers: { 'x-peaket-deadline-ms': '70', 'content-type': 'application/json' },
      payload: JSON.stringify({ n: 7 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ n: 7, remaining: 70 });
  });

  test('GL5_실제소켓으로_본문을나눠보내도_처리기는같은요청맥락을본다', async () => {
    s = await start({ PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const { port } = await s.svc.listen('127.0.0.1');
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/v1/demo/deadline', headers: { 'x-peaket-deadline-ms': '90', 'content-type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.write('{"n":');
      setTimeout(() => req.end('8}'), 30);
    });
    expect(JSON.parse(body)).toEqual({ n: 8, remaining: 90 });
  });

  test('GL5_헤더가없으면_서비스상한', async () => {
    s = await start({ PEAKET_ENV: 'ci', PEAKET_MAX_DEADLINE_MS: '250' });
    expect((await s.inject({ method: 'GET', url: '/v1/demo/deadline' })).json()).toEqual({ remaining: 240, next: 100 });
  });
});
