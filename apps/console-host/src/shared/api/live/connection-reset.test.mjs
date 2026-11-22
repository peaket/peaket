// 탭 하나의 관제 실시간 연결(connection.ts) 시험: 늘 여는 흐름 사건을 호스트 저장소에 넣고, reset이면 REST로 다시 읽는다(F-03-1 T2, FE-T28 ②).
// 정본: ADR-0100 결정 2 '빠지지 않게 다시 붙기'(reset이면 화면은 명령·경보·승인 대기를 REST로 다시 읽는다), frontend §4.4.4 'id와 다시 붙기', §3.10(호스트 슬라이스).
// 가짜 관제 API(live.test.fakes.mjs)로 본다. 모듈 상태가 전역이라 시나리오마다 파일을 나눈다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

test('F-03-1 T2 FE-T28 ②-4 reset을 받으면 다시 읽기 신호를 올리고 reset 구독자를 부르며, 호스트의 승인 대기를 명령 REST로 다시 읽는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  api.on('GET', '/v1/ops/commands', () => json(200, { items: [], nextCursor: null }));
  api.install();
  const c = await import('./connection.ts');
  const { hostStore } = await import('../../model/live-host.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const live = api.live().at(-1);
    const approval = { commandId: '6f1c1b5e-1d2a-4f3b-9c4d-5e6f7a8b9c0d', type: 'BLOCK_ASN_IP', state: 'PENDING_APPROVAL', approvalExpiresAt: '2026-11-23T01:30:00.000Z' };
    const alert = { alertId: 'a1', status: 'firing', startsAt: '2026-11-23T01:00:00.000Z', severity: 'SEV2', title: '결제 실패율', kind: 'slo' };
    live.stream.push(`retry: 10000\nid: 10\n\nid: 11\nevent: approval\ndata: ${JSON.stringify(approval)}\n\nid: 12\nevent: alert\ndata: ${JSON.stringify(alert)}\n\n`);
    live.stream.push(`event: presence\ndata: ${JSON.stringify({ eventId: E, operators: [{ accountRef: 'r1', role: 'operator', screen: 'dashboard' }] })}\n\n`);
    await drain();
    const s0 = hostStore.getState();
    assert.deepEqual(s0.commands.pending, [approval]);
    assert.deepEqual(
      s0.alerts.map((a) => a.alertId),
      ['a1'],
    );
    assert.deepEqual(s0.presence, [{ accountRef: 'r1', role: 'operator', screen: 'dashboard' }]);
    assert.equal(s0.connected, true);

    const resets = [];
    const off = c.onLive('reset', (p) => resets.push(p));
    const before = api.requests.length;
    live.stream.push('id: 40\nevent: reset\ndata: {"reason":"too-old"}\n\n');
    await drain();
    off();
    assert.deepEqual(resets, [{ reason: 'too-old' }]);
    assert.equal(hostStore.getState().resyncSeq, s0.resyncSeq + 1);
    // 승인 대기는 흐름으로만 채우는 호스트 슬라이스라, reset 뒤 호스트가 명령 REST(GET /v1/ops/commands)로 다시 읽어야 한다(ADR-0100 결정 2)
    const reread = api.requests.slice(before).filter((r) => r.method === 'GET' && r.path === '/v1/ops/commands');
    assert.ok(reread.length >= 1, `reset 뒤 명령 REST를 다시 읽지 않았다. 그 뒤 요청: ${JSON.stringify(api.requests.slice(before).map((r) => `${r.method} ${r.path}`))}`);
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
