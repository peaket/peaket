// reset이면 목록과 열린 상세를 REST로 다시 읽고, stop 뒤에는 사건이 와도 읽지 않는다(F-03-4 T11 ④, 시험 먼저 ADR 0372번).
// 정본: ADR-0100 결정 2(reset이면 화면은 명령·경보·승인 대기를 REST로 다시 읽는다), 계획 docs/review/plans/F-03-4.md 1-9.
// 구현 전 트리에는 command-sync.ts가 없어 무대에서 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, E, commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const row = (state) => ({ commandId: C1, type: 'KILL_SWITCH', state, reason: '사유', eventId: E, createdAt: '2026-11-23T11:00:00.000Z', approvals: [], attempts: 1, canApprove: false });

test('F-03-4 T11 ④-1 reset을 받으면 목록과 열린 상세를 REST로 다시 읽어 바뀐 값을 그리고, stop 뒤에는 사건이 와도 읽지 않는다', async () => {
  const { syncHarness } = await import('./command-sync.test.harness.mjs');
  const h = await syncHarness({ role: 'operator', list: [row('ACKED')], details: { [C1]: commandState({ state: 'ACKED' }) } });
  try {
    h.sync.select(C1);
    await h.tick(0);
    const lists0 = h.listGets();
    const details0 = h.detailGets(C1);
    h.server.list = [row('REVERT_PENDING')];
    h.server.details[C1] = commandState({ state: 'REVERT_PENDING', approvalExpiresAt: '2026-11-23T11:20:00.000Z' });
    await h.push('reset', { reason: 'too-old' });
    assert.ok(h.listGets() > lists0, 'reset 뒤 목록을 다시 읽지 않았다');
    assert.ok(h.detailGets(C1) > details0, 'reset 뒤 열린 상세를 다시 읽지 않았다');
    assert.equal(h.lists.at(-1).items[0].state, 'REVERT_PENDING');
    assert.equal(h.shown.at(-1).state, 'REVERT_PENDING');

    h.sync.stop();
    const after = [h.listGets(), h.detailGets(C1)];
    await h.push('command', { commandId: C1, type: 'KILL_SWITCH', state: 'REVERTED', eventId: E, approvalExpiresAt: null });
    await h.tick(10_000);
    assert.deepEqual([h.listGets(), h.detailGets(C1)], after, 'stop 뒤에 다시 읽었다');
  } finally {
    h.stop();
  }
});
