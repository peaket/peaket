// 명령 상세 + 본 시각 → 명령 카드 상태(F-03-4 T9·T10, C-T4·C-T7 ②, 시험 먼저 ADR 0372번).
// 정본: docs/features/control-tower.md §4 전이 표(T7 승인 대기 10분, T9 ack, T10 '3초를 넘으면 명령 카드에 전파 지연'·10초 실패),
// docs/design/d5-screen-blueprint.md §7.3 CMP-036 상태 표(pending-approval·rejected·propagating → acked·propagating 지연·failed·apply-*·revert-pending·reverted/auto-expired),
// docs/api/openapi.yaml CommandState(approvalExpiresAt, delivery{kind ACK|APPLY_CHECK, ackedCount, targetCount, unackedTargets}),
// 계획 docs/review/plans/F-03-4.md §4 card-state.ts. 시간 경계는 양쪽(3초 0ms·1ms 넘음, 승인 기한 1ms 전·0ms)을 본다.
// 구현 전 트리에는 model/card-state.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./card-state.ts');
const SEEN = Date.parse('2026-11-23T11:00:02.000Z');
/** control-tower §4 T10: ack가 3초를 넘으면 '전파 지연'(시험 값은 정본에서 적는다) */
const DELAY_MS = 3_000;
/** control-tower §4 T7: 승인 대기 10분 */
const APPROVAL_WINDOW_MS = 10 * 60_000;

const dispatched = (delivery) => commandState({ state: 'DISPATCHED', delivery });

test('F-03-4 T10 C-T7 ②-1 전파 지연 기준 상수는 정본 3초다', async () => {
  const { PROPAGATION_DELAY_MS } = await load();
  assert.equal(PROPAGATION_DELAY_MS, DELAY_MS);
});

test('F-03-4 T10 C-T7 ②-2 DISPATCHED를 본 뒤 3초 0ms까지는 전파 중(ack 진행 수 포함), 1ms 넘으면 전파 지연과 ack 못 한 대상 이름이다', async () => {
  const { commandCardState } = await load();
  const d = dispatched({ kind: 'ACK', ackedCount: 4, targetCount: 5, unackedTargets: ['purchase-svc-3'] });
  const at3s = commandCardState(d, { nowMs: SEEN + DELAY_MS, dispatchSeenAtMs: SEEN });
  assert.equal(at3s.kind, 'propagating');
  assert.equal(at3s.acked, 4);
  assert.equal(at3s.target, 5);
  const just = commandCardState(d, { nowMs: SEEN + 10, dispatchSeenAtMs: SEEN });
  assert.equal(just.kind, 'propagating');
  const late = commandCardState(d, { nowMs: SEEN + DELAY_MS + 1, dispatchSeenAtMs: SEEN });
  assert.equal(late.kind, 'propagating-delayed');
  assert.equal(late.acked, 4);
  assert.equal(late.target, 5);
  assert.deepEqual(late.unacked, ['purchase-svc-3']);
});

test('F-03-4 T10 C-T7 ②-3 FAILED는 바로 실패(다시 시도 가능)이고, 설정형 적용 확인(APPLY_CHECK)은 확인할 수 없음이다', async () => {
  const { commandCardState } = await load();
  const failed = commandCardState(commandState({ state: 'FAILED', lastError: 'purchase-svc-3 ack 시간 초과', delivery: { kind: 'ACK', ackedCount: 2, targetCount: 3, unackedTargets: ['purchase-svc-3'] } }), {
    nowMs: SEEN + 10_001,
    dispatchSeenAtMs: SEEN,
  });
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.retryable, true);
  const apply = commandCardState(dispatched({ kind: 'APPLY_CHECK', applyStatus: 'CHECKING' }), { nowMs: SEEN + 1, dispatchSeenAtMs: SEEN });
  assert.equal(apply.kind, 'apply-unknown');
});

test('F-03-4 T10 C-T7 ②-4 ACKED(ack 다 참)·REVERT_PENDING(남은 시간)·REVERTED·AUTO_EXPIRED·REJECTED·SUCCEEDED는 d5 상태 표의 칸이다', async () => {
  const { commandCardState } = await load();
  const at = { nowMs: SEEN + 60_000 };
  const acked = commandCardState(commandState({ state: 'ACKED', delivery: { kind: 'ACK', ackedCount: 5, targetCount: 5, unackedTargets: [] } }), at);
  assert.equal(acked.kind, 'acked');
  assert.equal(acked.acked, 5);
  assert.equal(acked.target, 5);
  const expiresAt = new Date(SEEN + 60_000 + 581_000).toISOString();
  const rp = commandCardState(commandState({ state: 'REVERT_PENDING', approvalExpiresAt: expiresAt }), at);
  assert.equal(rp.kind, 'revert-pending');
  assert.equal(rp.remainingMs, 581_000);
  assert.equal(commandCardState(commandState({ state: 'REVERTED' }), at).kind, 'reverted');
  assert.equal(commandCardState(commandState({ state: 'AUTO_EXPIRED' }), at).kind, 'auto-expired');
  assert.equal(commandCardState(commandState({ state: 'REJECTED' }), at).kind, 'rejected');
  assert.equal(commandCardState(commandState({ type: 'SCALE_CHANGE', state: 'SUCCEEDED', delivery: null }), at).kind, 'done');
});

test('F-03-4 T9 C-T4 ①-1 승인 대기의 남은 시간은 기한 1ms 전에 1ms, 기한·그 뒤에는 0이다(음수로 세지 않는다)', async () => {
  const { commandCardState } = await load();
  const created = Date.parse('2026-11-23T11:00:00.000Z');
  const expires = created + APPROVAL_WINDOW_MS;
  const d = commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', approvalExpiresAt: new Date(expires).toISOString(), canApprove: true, delivery: null });
  assert.deepEqual(
    [expires - 1, expires, expires + 5_000].map((nowMs) => {
      const s = commandCardState(d, { nowMs });
      return [s.kind, s.remainingMs];
    }),
    [
      ['pending-approval', 1],
      ['pending-approval', 0],
      ['pending-approval', 0],
    ],
  );
  // 만든 직후는 10분 그대로
  assert.equal(commandCardState(d, { nowMs: created }).remainingMs, APPROVAL_WINDOW_MS);
});
