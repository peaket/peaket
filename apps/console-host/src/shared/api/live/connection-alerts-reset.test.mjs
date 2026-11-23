// reset을 받으면 경보 목록 REST를 한 번 불러 경보 슬라이스를 갈아 끼우고, 목록 seq 뒤의 alert 사건은 다시 얹는지(F-03-3 T18, 시험 먼저 ADR-0372).
// 정본: ADR-0100 결정 2(reset이면 화면은 명령·경보·승인 대기를 REST로 다시 읽는다), FE-T28 ②(경보 몫은 F-03-3), docs/frontend.md §3.10·§4.4.4,
// 계획 §4 'GET /v1/ops/alerts'·1-15. 처음 열기는 connection-alerts.test.mjs가 본다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const A = (id, o = {}) => ({ alertId: id, status: 'firing', startsAt: '2026-11-23T10:00:00.000Z', severity: 'SEV2', title: `경보 ${id}`, kind: 'slo', eventId: E, ...o });

test('F-03-3 T18 FE-T28 ②-17 reset을 받으면 경보 목록을 한 번 다시 읽어 슬라이스를 갈아 끼우고(그 사이 사라진 경보는 빠짐), 목록 seq 뒤 사건은 다시 얹으며 겹침이 없다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  const answers = [];
  api.on('GET', '/v1/ops/alerts', () => new Promise((r) => answers.push(r)));
  api.on('GET', '/v1/ops/commands', () => json(200, { items: [], nextCursor: null }));
  api.install();
  const c = await import('./connection.ts');
  const { hostStore } = await import('../../model/live-host.ts');
  const alertsNow = () => hostStore.getState().alerts.map((a) => a.alertId);
  try {
    c.startLive({ origin: 'https://ops-api.test', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const live = api.live().at(-1);
    live.stream.push(`retry: 10000\nid: 5\n\n`);
    await drain();
    // 처음 목록: 경보 둘(seq 5)
    assert.equal(answers.length, 1, '처음 열 때 경보 목록을 읽지 않았다');
    answers[0](json(200, { items: [A('al-1'), A('al-3')], seq: 5 }));
    await drain();
    assert.deepEqual(alertsNow().sort(), ['al-1', 'al-3']);

    // 1시간 넘게 끊겼다 붙어 reset(too-old)을 받는다
    live.stream.push('id: 40\nevent: reset\ndata: {"reason":"too-old"}\n\n');
    await drain();
    assert.equal(answers.length, 2, 'reset 뒤 경보 목록을 다시 읽지 않았다');
    // 다시 읽는 동안 흐름으로 두 사건이 온다: 41은 목록(seq 45)에 이미 든 것, 46은 목록 뒤
    live.stream.push(`id: 41\nevent: alert\ndata: ${JSON.stringify(A('al-6'))}\n\n`);
    live.stream.push(`id: 46\nevent: alert\ndata: ${JSON.stringify(A('al-5', { severity: 'SEV1' }))}\n\n`);
    await drain();
    // 목록(seq 45): al-3은 그 사이 풀린 지 60분이 넘어 빠졌다
    answers[1](json(200, { items: [A('al-1'), A('al-6')], seq: 45 }));
    await drain();
    const after = alertsNow();
    assert.deepEqual([...after].sort(), ['al-1', 'al-5', 'al-6']);
    assert.equal(new Set(after).size, after.length, '겹친 경보가 있다');
    // 한 번만 읽었다
    assert.equal(api.requests.filter((r) => r.method === 'GET' && r.path === '/v1/ops/alerts').length, 2);
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
