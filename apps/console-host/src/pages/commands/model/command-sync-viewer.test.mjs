// viewer는 목록만 보고 상세를 부르지 않는다(고르기·사건·reset 모두)(F-03-4 T8 C-T46 ③, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml getOpsCommand(operator·commander만, 'viewer는 목록만 보므로 부르지 못한다'), docs/design/d5-screen-blueprint.md §7.3 경로 표, 계획 1-1.
// 구현 전 트리에는 command-sync.ts가 없어 무대에서 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, E, commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

test('F-03-4 T8 C-T46 ③-5 viewer는 명령을 골라도·사건이 와도·reset이어도 상세 GET이 0이고 목록은 다시 읽는다', async () => {
  const { syncHarness } = await import('./command-sync.test.harness.mjs');
  const row = { commandId: C1, type: 'KILL_SWITCH', state: 'DISPATCHED', reason: '사유', eventId: E, createdAt: '2026-11-23T11:00:00.000Z', approvals: [], attempts: 1, canApprove: false };
  const h = await syncHarness({ role: 'viewer', list: [row], details: { [C1]: commandState({ state: 'DISPATCHED' }) } });
  try {
    h.sync.select(C1);
    await h.tick(0);
    await h.push('command', { commandId: C1, type: 'KILL_SWITCH', state: 'ACKED', eventId: E, approvalExpiresAt: null });
    await h.push('reset', { reason: 'too-old' });
    await h.tick(10_000);
    assert.equal(h.detailGets(C1), 0);
    assert.equal(h.shown.length, 0);
    assert.ok(h.listGets() >= 2, '처음 읽기와 reset 뒤 목록을 읽어야 한다');
  } finally {
    h.stop();
  }
});
