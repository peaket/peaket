// ops-svc 온세일 오픈 일정 HTTP 클라이언트(HttpOnsaleScheduleSource)를 실제 HTTP 서버로 본다
// (F-02-5 OPS-300, TR-03, 계획 3.1·8.4·14절 10, ADR-0334 결정 3, C-T75 ①).
// - core-svc 내부 경로 GET /internal/v1/events/onsale-opens?from=<ISO>&to=<ISO>는 서비스 사이 토큰을 받고
//   [{ eventId, opensAt(ISO), scale: LARGE|MEDIUM|SMALL|null }]를 준다. 구간은 [from, to)다.
// - 어댑터는 브로커 주소처럼 baseUrl을 받고, from/to를 ISO로, 토큰이 있으면 x-peaket-internal-token으로 보낸다.
// - 200이 아니거나 꼴이 틀리면 던진다(부르는 쪽 PublishOnsaleLogSampling이 SCHEDULE_UNAVAILABLE로 남긴다).
// - 시간 초과는 시험 값 250ms로 잰다(정본 값이 아니라 주입 값이다).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { HttpOnsaleScheduleSource } from '../src/modules/commands/index.js';

const TOKEN = 'f025-onsale-opens-token';
const FROM = Date.parse('2026-12-05T10:50:00.000Z');
const TO = Date.parse('2026-12-05T12:50:00.000Z');
const A = '1a000000-0000-4000-8000-00000000000a';
const B = '1b000000-0000-4000-8000-00000000000b';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** 시험용 HTTP 서버. 주소와 받은 요청을 돌려준다 */
async function serve(handler: Handler): Promise<{ url: string; calls: { url?: string; token?: string }[] }> {
  const calls: { url?: string; token?: string }[] = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, token: req.headers['x-peaket-internal-token'] as string | undefined });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('시험 서버 주소를 읽지 못했다');
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('F025-ONSALE core-svc 온세일 오픈 일정 클라이언트(TR-03)', () => {
  test('F025-ONSALE ① from·to를 ISO로 보내고 토큰을 싣고, 응답의 opensAt(ISO)·scale을 그대로 센다', async () => {
    const { url, calls } = await serve((_req, res) =>
      json(res, 200, {
        items: [
          { eventId: A, opensAt: new Date(FROM).toISOString(), scale: 'LARGE' },
          { eventId: B, opensAt: new Date(FROM + 30 * 60_000).toISOString(), scale: null },
        ],
      }),
    );
    const source = new HttpOnsaleScheduleSource({ baseUrl: url, token: TOKEN });
    const opens = await source.opensBetween(FROM, TO);
    expect(opens).toEqual([
      { eventId: A, opensAtMs: FROM, scale: 'LARGE' },
      { eventId: B, opensAtMs: FROM + 30 * 60_000, scale: null },
    ]);
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0]!.url!, url);
    expect(sent.pathname).toBe('/internal/v1/events/onsale-opens');
    expect(sent.searchParams.get('from')).toBe(new Date(FROM).toISOString());
    expect(sent.searchParams.get('to')).toBe(new Date(TO).toISOString());
    expect(calls[0]!.token).toBe(TOKEN);
  });

  test('F025-ONSALE ② 토큰이 없으면 헤더를 싣지 않고, baseUrl 끝의 /는 붙이지 않는다', async () => {
    const { url, calls } = await serve((_req, res) => json(res, 200, { items: [] }));
    const source = new HttpOnsaleScheduleSource({ baseUrl: `${url}/` });
    expect(await source.opensBetween(FROM, TO)).toEqual([]);
    expect(calls[0]!.token).toBeUndefined();
    const sent = new URL(calls[0]!.url!, url);
    expect(sent.pathname).toBe('/internal/v1/events/onsale-opens');
    expect(sent.searchParams.get('from')).toBe(new Date(FROM).toISOString());
    expect(sent.searchParams.get('to')).toBe(new Date(TO).toISOString());
  });

  test('F025-ONSALE ③ 200이 아니거나 items·eventId·opensAt·scale 꼴이 틀리면 던진다(빈 일정으로 삼키지 않는다)', async () => {
    for (const [label, handler] of [
      ['401', (_q: IncomingMessage, res: ServerResponse) => json(res, 401, { type: 'unauthorized' })],
      ['500', (_q: IncomingMessage, res: ServerResponse) => json(res, 500, { type: 'internal' })],
      ['items 없음', (_q: IncomingMessage, res: ServerResponse) => json(res, 200, {})],
      ['items 배열 아님', (_q: IncomingMessage, res: ServerResponse) => json(res, 200, { items: {} })],
      ['eventId 없음', (_q: IncomingMessage, res: ServerResponse) => json(res, 200, { items: [{ opensAt: new Date(FROM).toISOString(), scale: 'LARGE' }] })],
      ['opensAt 꼴', (_q: IncomingMessage, res: ServerResponse) => json(res, 200, { items: [{ eventId: A, opensAt: '2026-12-05', scale: 'LARGE' }] })],
      ['scale 모름', (_q: IncomingMessage, res: ServerResponse) => json(res, 200, { items: [{ eventId: A, opensAt: new Date(FROM).toISOString(), scale: 'HUGE' }] })],
      ['JSON 아님', (_q: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not-json');
      }],
    ] as const) {
      const { url } = await serve(handler);
      await expect(new HttpOnsaleScheduleSource({ baseUrl: url }).opensBetween(FROM, TO), label).rejects.toBeTruthy();
    }
  });

  test('F025-ONSALE ④ 주입한 시간 한도(250ms)를 넘으면 던진다(부르는 쪽이 SCHEDULE_UNAVAILABLE로 남긴다)', async () => {
    const { url } = await serve(() => undefined); // 답하지 않는다
    const source = new HttpOnsaleScheduleSource({ baseUrl: url, timeoutMs: 250 });
    const started = Date.now();
    await expect(source.opensBetween(FROM, TO)).rejects.toBeTruthy();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});
