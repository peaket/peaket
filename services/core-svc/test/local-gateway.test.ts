// 로컬 파트너 스택 게이트웨이 대역(test-int/local-gateway.ts, ADR-0264 결정 14) 시험. 실제 HTTP 서버로 띄워 부른다(넘길 곳은 가짜 fetch).
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { gatewayHandler } from '../test-int/local-gateway.js';

const ORIGIN = 'http://127.0.0.1:3001';
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start() {
  const state = { stopped: 0, upstream: [] as { url: string; headers: Record<string, string> }[] };
  const handler = gatewayHandler({
    partnerOrigin: ORIGIN,
    upstream: 'http://core.test',
    identity: { admin: { 'x-user-id': 'admin' }, member: { 'x-user-id': 'member' } },
    key: 'k-123',
    onStop: () => void state.stopped++,
    listFiles: async () => ['public/a.json'],
    fetch: (async (url: string, init: RequestInit) => {
      state.upstream.push({ url, headers: init.headers as Record<string, string> });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json', etag: '"3"' } });
    }) as typeof fetch,
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  return { state, base };
}

describe('로컬 게이트웨이 대역', () => {
  test('대역 조작은 열쇠가 맞을 때만 받고 Origin 없는 API 요청은 관리자로 넘기지 않고 거절한다 [ASVS v5.0.0-3.5.2] [ASVS v5.0.0-8.2.1]', async () => {
    const { state, base } = await start();
    // 열쇠 없는 멈추기·계정 바꾸기·파일 목록은 거절하고 상태를 바꾸지 않는다
    for (const p of ['/__local/stop', '/__local/as?role=member', '/__local/files']) expect((await fetch(base + p)).status).toBe(403);
    expect((await fetch(`${base}/__local/stop?key=wrong`)).status).toBe(403);
    expect(state.stopped).toBe(0);
    const as = await fetch(`${base}/__local/as?role=member&key=k-123`);
    expect(as.status).toBe(200);
    expect(as.headers.get('set-cookie')).toContain('local_as=member');
    expect((await fetch(`${base}/__local/files?key=k-123`)).status).toBe(200);
    // Origin 없는 API 요청(다른 프로그램·주소창)은 넘기지 않는다
    const bare = await fetch(`${base}/v1/partner/productions/x/seatmap`);
    expect(bare.status).toBe(403);
    expect(state.upstream).toHaveLength(0);
    // 다른 출처도 거절, 파트너 콘솔 출처는 넘기고 ETag·Retry-After를 노출한다
    expect((await fetch(`${base}/v1/partner/productions/x/seatmap`, { headers: { origin: 'http://evil.test' } })).status).toBe(403);
    const ok = await fetch(`${base}/v1/partner/productions/x/seatmap`, { headers: { origin: ORIGIN, 'x-user-id': 'forged' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-expose-headers')).toBe('ETag, Retry-After');
    expect(state.upstream).toHaveLength(1);
    // 보낸 신원 머리는 버리고 대역 계정 머리를 단다
    expect(state.upstream[0]!.headers['x-user-id']).toBe('admin');
    const pre = await fetch(`${base}/v1/partner/productions/x/seatmap`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-requested-with');
    expect((await fetch(`${base}/__local/stop?key=k-123`)).status).toBe(200);
    expect(state.stopped).toBe(1);
  });
});
