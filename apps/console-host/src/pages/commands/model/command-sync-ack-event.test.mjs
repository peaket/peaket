// 3초 다시 읽기를 기다리는 동안 상태가 바뀌어 command 사건이 오면 상세를 바로 다시 읽고, 끝 상태면 남은 타이머를 끈다(F-03-4 T11 ③, 시험 먼저 ADR 0372번).
// 정본: 계획 docs/review/plans/F-03-4.md T11('그 사이 ACKED 사건이 오면 남은 타이머를 끈다'), ADR-0100(정본은 REST).
// 구현 전 트리에는 command-sync.ts가 없어 무대에서 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, E, commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

test('F-03-4 T11 ③-1 DISPATCHED를 읽고 1.5초 뒤 ACKED 사건이 오면 상세를 한 번 읽고, 3초 타이머는 더 읽지 않는다', async () => {
  const { syncHarness } = await import('./command-sync.test.harness.mjs');
  const h = await syncHarness({
    role: 'operator',
    details: { [C1]: commandState({ type: 'ADMISSION_TARGET', state: 'DISPATCHED', delivery: { kind: 'ACK', ackedCount: 0, targetCount: 1, unackedTargets: ['admission-ctrl'] } }) },
  });
  try {
    h.sync.select(C1);
    await h.tick(0);
    assert.equal(h.detailGets(C1), 1);
    await h.tick(1_500);
    h.server.details[C1] = commandState({ type: 'ADMISSION_TARGET', state: 'ACKED', delivery: { kind: 'ACK', ackedCount: 1, targetCount: 1, unackedTargets: [] } });
    await h.push('command', { commandId: C1, type: 'ADMISSION_TARGET', state: 'ACKED', eventId: E, approvalExpiresAt: null });
    assert.equal(h.detailGets(C1), 2);
    assert.equal(h.shown.at(-1).state, 'ACKED');
    await h.tick(1_500);
    assert.equal(h.detailGets(C1), 2, '꺼야 할 3초 타이머가 상세를 다시 읽었다');
    await h.tick(10_000);
    assert.equal(h.detailGets(C1), 2);
  } finally {
    h.stop();
  }
});
