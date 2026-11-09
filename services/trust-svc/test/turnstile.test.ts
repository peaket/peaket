// 사람 확인 서버 검증(docs/features/bot-defense.md §6, B-T5). 검증 API는 로컬 흉내 서버다(실제 Cloudflare를 부르지 않는다).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CircuitBreaker, systemClock } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TurnstileHumanCheck } from '../src/modules/scoring/adapters/turnstile-human-check.js';

interface Seen {
  body: URLSearchParams;
}
type Reply = (req: Seen, n: number, res: ServerResponse) => void | Promise<void>;
const json = (res: ServerResponse, o: object, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(o));
};
const ok = (res: ServerResponse, action = 'preverify') => json(res, { success: true, hostname: 'www.peaket.example', action, 'error-codes': [] });

let server: Server;
let reply: Reply;
let seen: Seen[];
let url: string;

beforeEach(async () => {
  seen = [];
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { body: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) };
      seen.push(s);
      void reply(s, seen.length, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/turnstile/v0/siteverify`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checker = (o: { breaker?: Pick<CircuitBreaker, 'run'>; secret?: string | undefined } = {}) =>
  new TurnstileHumanCheck({ url, secret: 'secret' in o ? o.secret : 'test-secret-value', hostname: 'www.peaket.example', ...(o.breaker ? { breaker: o.breaker } : {}) });
const req = (o: Partial<Parameters<TurnstileHumanCheck['verify']>[0]> = {}) => ({ token: 't-1', action: 'preverify' as const, remoteIp: '198.51.100.7', deadlineAtMs: Date.now() + 800, ...o });

describe('B-T5 사람 확인 서버 검증', () => {
  test('B-T5①_검증API가늦으면같은idempotency_key로한번다시묻는다', async () => {
    reply = async (_s, n, res) => {
      if (n === 1) await delay(600);
      ok(res);
    };
    await expect(checker().verify(req())).resolves.toBe('PASSED');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.get('idempotency_key')).toBeTruthy();
    expect(seen[1]!.body.get('idempotency_key')).toBe(seen[0]!.body.get('idempotency_key'));
  });

  test('B-T5②_두번모두늦으면검증보류이고_남은데드라인안에끝난다', async () => {
    reply = async (_s, _n, res) => {
      await delay(900);
      ok(res);
    };
    const start = Date.now();
    await expect(checker().verify(req())).resolves.toBe('PENDING');
    expect(seen).toHaveLength(2);
    expect(Date.now() - start).toBeLessThan(800);
  });

  test('B-T5_남은데드라인이200ms이하면다시묻지않고보류다', async () => {
    reply = async (_s, _n, res) => {
      await delay(400);
      ok(res);
    };
    await expect(checker().verify(req({ deadlineAtMs: Date.now() + 300 }))).resolves.toBe('PENDING');
    expect(seen).toHaveLength(1);
  });

  test.each([
    ['hostname', { success: true, hostname: 'evil.example', action: 'preverify' }],
    ['action', { success: true, hostname: 'www.peaket.example', action: 'lobby' }],
  ])('B-T5③_%s가다른토큰은실패다', async (_n, body) => {
    reply = (_s, _n2, res) => json(res, body);
    await expect(checker().verify(req())).resolves.toBe('FAILED');
    expect(seen).toHaveLength(1);
  });

  test('B-T5④_쓴토큰을다시보내면timeout-or-duplicate로실패이고보류가아니다', async () => {
    reply = (_s, _n, res) => json(res, { success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(checker().verify(req())).resolves.toBe('FAILED');
    expect(seen).toHaveLength(1);
  });

  test('B-T5⑤_검증API차단기가열리면호출하지않고보류다', async () => {
    reply = (_s, _n, res) => json(res, { oops: true }, 500);
    const breaker = new CircuitBreaker({ service: 'trust-svc', dependency: 'turnstile', minCalls: 1, failureRatePercent: 1, openMs: 60_000, clock: systemClock });
    const c = checker({ breaker });
    await expect(c.verify(req())).resolves.toBe('PENDING');
    const before = seen.length;
    await expect(c.verify(req())).resolves.toBe('PENDING');
    expect(seen.length).toBe(before);
    breaker.shutdown();
  });

  test('B-T5_서버오류는다시묻고그래도오류면보류다_토큰탓이아니다', async () => {
    reply = (_s, _n, res) => json(res, {}, 503);
    await expect(checker().verify(req())).resolves.toBe('PENDING');
    expect(seen).toHaveLength(2);
  });

  test('[ASVS v5.0.0-16.3.4] Cloudflare쪽내부오류·비밀키오류는_이용자실패로세지않고보류다', async () => {
    reply = (_s, _n, res) => json(res, { success: false, 'error-codes': ['internal-error'] });
    await expect(checker().verify(req())).resolves.toBe('PENDING');
    reply = (_s, _n, res) => json(res, { success: false, 'error-codes': ['invalid-input-secret'] });
    await expect(checker().verify(req())).resolves.toBe('PENDING');
  });

  test.each([
    ['빈 객체', {}],
    ['success 없음', { hostname: 'www.peaket.example', action: 'preverify' }],
    ['빈 error-codes', { success: false, 'error-codes': [] }],
  ])('낮음6_이상한200응답(%s)은이용자실패가아니라보류다', async (_n, body) => {
    reply = (_s, _n2, res) => json(res, body);
    await expect(checker().verify(req())).resolves.toBe('PENDING');
  });

  test('낮음6_JSON이아닌200응답도보류다', async () => {
    reply = (_s, _n, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>x</html>');
    };
    await expect(checker().verify(req())).resolves.toBe('PENDING');
  });

  test('토큰이잘못되면실패다', async () => {
    reply = (_s, _n, res) => json(res, { success: false, 'error-codes': ['invalid-input-response'] });
    await expect(checker().verify(req())).resolves.toBe('FAILED');
  });

  test('비밀키가없으면부르지않고보류다', async () => {
    reply = (_s, _n, res) => ok(res);
    await expect(checker({ secret: undefined }).verify(req())).resolves.toBe('PENDING');
    expect(seen).toHaveLength(0);
  });

  test('맞는응답은통과이고_비밀·토큰·IP를본문으로만보낸다', async () => {
    reply = (_s, _n, res) => ok(res);
    await expect(checker().verify(req())).resolves.toBe('PASSED');
    expect(seen[0]!.body.get('secret')).toBe('test-secret-value');
    expect(seen[0]!.body.get('response')).toBe('t-1');
    expect(seen[0]!.body.get('remoteip')).toBe('198.51.100.7');
  });

  test('IP모양이아니면remoteip를보내지않는다', async () => {
    reply = (_s, _n, res) => ok(res);
    await checker().verify(req({ remoteIp: 'not-an-ip' }));
    expect(seen[0]!.body.has('remoteip')).toBe(false);
  });
});
