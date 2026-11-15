// A1V-09 payment 회차 정산 스케줄러 원천의 내부 토큰·쿼리 계약.
// core-svc의 settlement-due 경로가 공유 토큰을 요구하므로 payment 스케줄러도 같은 토큰을 보내야 한다.
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpDueEventSettlementSource } from '../src/modules/settlement/index.js';

describe('A1V-09 payment 회차 정산 원천 HTTP', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { url: string; token: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', token: String(req.headers['x-peaket-internal-token'] ?? '') });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/internal/v1/events/settlement-due' || url.searchParams.get('through') !== '2026-11-13' || url.searchParams.get('limit') !== '25') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'invalid-query' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [{ eventId: randomUUID(), promoterId: randomUUID(), endsAt: '2026-11-08T00:00:00.000Z' }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('주소를 읽지 못했다');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  test('through·limit을 query로 보내고 x-peaket-internal-token을 붙인다', async () => {
    const source = new HttpDueEventSettlementSource(baseUrl, 'a1v-internal-token');
    const items = await source.listDue('2026-11-13', 25);
    expect(items).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ token: 'a1v-internal-token' });
    const url = new URL(seen[0]!.url, 'http://127.0.0.1');
    expect(url.pathname).toBe('/internal/v1/events/settlement-due');
    expect(url.searchParams.get('through')).toBe('2026-11-13');
    expect(url.searchParams.get('limit')).toBe('25');
  });
});
