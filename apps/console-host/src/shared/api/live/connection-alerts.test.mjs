// 탭 하나의 관제 실시간 연결(connection.ts)이 처음 열 때 경보 목록 REST로 경보 슬라이스를 채우는지(F-03-3 T18, 시험 먼저 ADR-0372).
// 정본: ADR-0100 결정 2, docs/frontend.md §3.10(alerts 슬라이스)·§4.4.4, FE-T28 ②(경보 몫은 경보 목록 REST와 함께 F-03-3), 계획 §4 'GET /v1/ops/alerts'(응답 { items, seq })·1-15
// ('처음 열 때와 reset을 받을 때 이 목록으로 alerts 슬라이스를 갈아 끼우고, 그 사이 들어온 alert 사건(seq 뒤 순번)은 목록 위에 다시 얹는다').
// 가짜 관제 API(live.test.fakes.mjs)로 본다. 모듈 상태가 전역이라 시나리오마다 파일을 나눈다(reset은 connection-alerts-reset.test.mjs).
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const A = (id, o = {}) => ({ alertId: id, status: 'firing', startsAt: '2026-11-23T10:00:00.000Z', severity: 'SEV2', title: `경보 ${id}`, kind: 'slo', eventId: E, ...o });

test('F-03-3 T18 FE-T28 ②-16 처음 열 때 콘솔을 열기 전부터 걸린 경보를 목록 REST로 받고, 목록 응답 seq 뒤의 alert 사건은 목록 위에 다시 얹는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  let answer;
  const listed = new Promise((r) => (answer = r));
  api.on('GET', '/v1/ops/alerts', () => listed);
  api.on('GET', '/v1/ops/commands', () => json(200, { items: [], nextCursor: null }));
  api.install();
  const c = await import('./connection.ts');
  const { hostStore } = await import('../../model/live-host.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const live = api.live().at(-1);
    // 목록이 오기 전에 흐름이 먼저 열리고 그 뒤 순번의 경보가 온다
    live.stream.push(`retry: 10000\nid: 10\n\n`);
    live.stream.push(`id: 11\nevent: alert\ndata: ${JSON.stringify(A('al-new'))}\n\n`);
    await drain();
    const asked = api.requests.filter((r) => r.method === 'GET' && r.path === '/v1/ops/alerts');
    assert.equal(asked.length, 1, `처음 열 때 경보 목록을 한 번 읽어야 한다. 요청: ${JSON.stringify(api.requests.map((r) => `${r.method} ${r.path}`))}`);
    // 목록(seq 10): 콘솔을 열기 전부터 걸린 경보 둘
    answer(json(200, { items: [A('al-before-1', { severity: 'SEV1' }), A('al-before-2', { kind: 'control' })], seq: 10 }));
    await drain();
    const got = hostStore.getState().alerts.map((a) => a.alertId).sort();
    assert.deepEqual(got, ['al-before-1', 'al-before-2', 'al-new']);
    assert.equal(new Set(got).size, got.length, '겹친 경보가 있다');
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
