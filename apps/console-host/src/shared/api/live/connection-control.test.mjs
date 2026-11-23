// 늘 여는 흐름의 control 사건(asyncapi OpsControl)을 호스트 control 슬라이스에 본문 그대로 넣는지(F-03-3 T5, 시험 먼저 ADR-0372).
// 정본: docs/features/control-tower.md §6의 6(입력 없음이면 위 상태 바 <입력 없음>), docs/design/d5-screen-blueprint.md §7.2('목표를 {n}명으로 유지합니다' 배너),
// docs/frontend.md §3.10(control 슬라이스), 계획 §4 'SSE control'({ eventId, kind, since?, inputStaleKinds?, targetNow?, budgetHoldAt?, lastDecrease?, updatedAt })·1-13.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

test('F-03-3 T5 C-T31 ①-4 control 사건의 입력 없음 본문(없는 입력·시작 시각·지금 목표)이 호스트 control 슬라이스에 그대로 들어가고, 다음 사건이 바꾼다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  api.on('GET', '/v1/ops/alerts', () => json(200, { items: [], seq: 0 }));
  api.on('GET', '/v1/ops/commands', () => json(200, { items: [], nextCursor: null }));
  api.install();
  const c = await import('./connection.ts');
  const { hostStore } = await import('../../model/live-host.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const live = api.live().at(-1);
    const noInput = {
      eventId: E,
      kind: 'no-input',
      since: '2026-11-23T11:03:41.000Z',
      inputStaleKinds: ['downstream_latency', 'budget_burn'],
      targetNow: 1234,
      updatedAt: '2026-11-23T11:04:12.000Z',
    };
    live.stream.push(`retry: 10000\nid: 1\n\nevent: control\ndata: ${JSON.stringify(noInput)}\n\n`);
    await drain();
    assert.deepEqual(hostStore.getState().control, noInput);
    const raise = { eventId: E, kind: 'raise-stopped', budgetHoldAt: '2026-11-23T11:05:00.000Z', targetNow: 1000, lastDecrease: { reason: 'budget_50', journey: 'hold', from: 1500, to: 1000 }, updatedAt: '2026-11-23T11:05:01.000Z' };
    live.stream.push(`event: control\ndata: ${JSON.stringify(raise)}\n\n`);
    await drain();
    assert.deepEqual(hostStore.getState().control, raise);
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
