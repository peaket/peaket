// 탭 하나의 관제 실시간 연결(connection.ts) 시험: 서버가 흐름을 닫으면 액세스 토큰을 갱신하고 다시 붙고, 갱신이 401이면 로그인으로 간다(F-03-1 T4, FE-T28 ④).
// 정본: frontend §4.4.4 '닫힘'(브라우저는 토큰을 갱신한 뒤 다시 붙는다, 갱신이 401이면 로그인 화면), ADR-0360 결정 11(갱신 뒤 1초 + 0~5초).
// 가짜 관제 API(live.test.fakes.mjs)와 Node 가짜 시계(mock.timers)로 본다. 모듈 상태가 전역이라 시나리오마다 파일을 나눈다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const REOPEN_MS = 1_000; // ADR-0360 결정 11 '1초 + 0~5초', 무작위 0

test('F-03-1 T4 FE-T28 ④-8 서버가 닫으면 POST /v1/ops/auth/access-tokens로 갱신하고 1초 뒤 Last-Event-ID로 다시 붙으며, 다음 닫힘의 갱신이 401이면 로그인으로 간다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  let refreshStatus = 204;
  api.on('POST', '/v1/ops/auth/access-tokens', () => json(refreshStatus, refreshStatus === 401 ? { type: 'https://peaket.example/problems/unauthorized', title: '로그인이 필요합니다', status: 401 } : {}));
  api.install();
  let login = 0;
  const c = await import('./connection.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test', onUnauthorized: () => (login += 1) });
    await drain();
    assert.equal(api.live().length, 1);
    const first = api.live()[0];
    first.stream.push('retry: 10000\nid: 77\n\n');
    await drain();
    // 토큰 만료로 서버가 닫는다
    first.stream.end();
    await drain();
    const refreshes = () => api.requests.filter((r) => r.method === 'POST' && r.path === '/v1/ops/auth/access-tokens').length;
    assert.equal(refreshes(), 1);
    mock.timers.tick(REOPEN_MS - 1);
    await drain();
    assert.equal(api.live().length, 1);
    mock.timers.tick(1);
    await drain();
    assert.equal(api.live().length, 2);
    assert.equal(api.live()[1].headers['last-event-id'], '77');
    assert.equal(login, 0);

    // 세션이 끝나 서버가 다시 닫고, 이번에는 갱신이 401
    refreshStatus = 401;
    api.live()[1].stream.end();
    await drain();
    assert.equal(refreshes(), 2);
    assert.equal(login, 1);
    mock.timers.tick(10 * 60_000);
    await drain();
    assert.equal(api.live().length, 2, '로그인으로 간 뒤에는 다시 열지 않는다');
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
