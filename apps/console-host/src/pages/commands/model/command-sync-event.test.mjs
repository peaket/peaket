// 흐름의 command 사건은 다시 읽기 방아쇠로만 쓰고, 화면 값은 REST로 다시 읽은 값이다(F-03-4 T11 ①, 시험 먼저 ADR 0372번).
// 정본: ADR-0100(명령 확인의 정본은 REST 상세의 상태, SSE는 빨리 알리는 길), docs/api/openapi.yaml getOpsCommand('명령 확인의 정본은 이 응답의 상태다'),
// 계획 docs/review/plans/F-03-4.md 1-9('사건 본문은 다시 읽기의 방아쇠로만'), '감독에게' 4 (나)(사건 본문에 updatedAt·delivery가 없다).
// 시험이 정한 공개 인터페이스: model/command-sync.ts의 syncCommands({ role, onList(page), onDetail(detail) }) → { select(commandId | null), stop() }.
// 만들면 목록을 한 번 읽고, select한 명령의 상세를 읽는다. 구현 전 트리에는 command-sync.ts가 없어 무대에서 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, C2, E, commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const row = (id, state, type = 'KILL_SWITCH') => ({ commandId: id, type, state, reason: '사유', eventId: E, createdAt: '2026-11-23T11:00:00.000Z', approvals: [], attempts: 0, canApprove: false });

test('F-03-4 T11 ①-1 command 사건(본문에 updatedAt 없음)을 받으면 열린 명령은 상세를, 다른 명령은 목록을 REST로 다시 읽고 사건 본문 상태로 그리지 않는다', async () => {
  const { syncHarness } = await import('./command-sync.test.harness.mjs');
  const h = await syncHarness({
    role: 'operator',
    list: [row(C1, 'PENDING_APPROVAL', 'DEGRADED_MODE'), row(C2, 'ACKED')],
    details: { [C1]: commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', canApprove: true, delivery: null }) },
  });
  try {
    assert.equal(h.listGets(), 1, '처음에 목록을 한 번 읽는다');
    assert.deepEqual(
      h.lists.at(-1).items.map((r) => [r.commandId, r.state]),
      [
        [C1, 'PENDING_APPROVAL'],
        [C2, 'ACKED'],
      ],
    );
    h.sync.select(C1);
    await h.tick(0);
    assert.equal(h.detailGets(C1), 1);
    assert.equal(h.shown.at(-1).state, 'PENDING_APPROVAL');

    // 열린 명령: 사건은 ACKED라 하지만 REST 상세는 APPROVED다 → 화면은 REST 값
    h.server.details[C1] = commandState({ type: 'DEGRADED_MODE', state: 'APPROVED', canApprove: false, delivery: null });
    h.server.list = [row(C1, 'APPROVED', 'DEGRADED_MODE'), row(C2, 'ACKED')];
    await h.push('command', { commandId: C1, type: 'DEGRADED_MODE', state: 'ACKED', eventId: E, approvalExpiresAt: null });
    assert.equal(h.detailGets(C1), 2, '사건 하나에 상세 GET 하나');
    assert.equal(h.shown.at(-1).state, 'APPROVED');
    assert.equal(
      h.shown.some((d) => d.state === 'ACKED'),
      false,
      '사건 본문 상태로 상세를 그렸다',
    );

    // 다른 명령: 사건은 REVERTED라 하지만 REST 목록은 REVERT_PENDING이다 → 목록 줄은 REST 값, 그 명령 상세는 부르지 않는다
    h.server.list = [row(C1, 'APPROVED', 'DEGRADED_MODE'), row(C2, 'REVERT_PENDING')];
    const before = h.listGets();
    await h.push('command', { commandId: C2, type: 'KILL_SWITCH', state: 'REVERTED', eventId: E, approvalExpiresAt: null });
    assert.ok(h.listGets() > before, '다른 명령 사건 뒤 목록을 다시 읽지 않았다');
    assert.equal(h.detailGets(C2), 0);
    assert.deepEqual(
      h.lists.at(-1).items.map((r) => [r.commandId, r.state]),
      [
        [C1, 'APPROVED'],
        [C2, 'REVERT_PENDING'],
      ],
    );
  } finally {
    h.stop();
  }
});
