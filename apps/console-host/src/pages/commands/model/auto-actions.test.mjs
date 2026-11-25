// 걸린 자동 조치 표시 시험(F-03-7 T18, C-T44 ⑦, 시험 먼저).
// 정본: docs/features/control-tower.md §12(늘 여는 흐름 autoAction), C-T44 ⑦(시간 조건 막대·깨지면 0·풀린 지 10분 '최근 풀림'),
// packages/console-contract HostState.autoActions({name,target,state,startedAt}). 본문 모양이 없는 사건은 이름·상태만 쓴다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
const load = () => import('./auto-actions.ts');
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const MIN = 60_000;

test('F-03-7 T18-1 걸린 조치는 이름·대상·상태·시작 시각과 시간 조건 막대를 보인다', async () => {
  const { autoActionView } = await load();
  const view = autoActionView(
    [{ name: '실시간 표 신선도 저하', target: '전체', state: 'STUCK', startedAt: AT, condition: { startedAt: AT, durationMs: 10 * MIN } }],
    AT_MS + 4 * MIN,
  );
  assert.equal(view.stuck.length, 1);
  assert.equal(view.stuck[0].name, '실시간 표 신선도 저하');
  assert.equal(view.stuck[0].target, '전체');
  assert.equal(view.stuck[0].progress.elapsedMs, 4 * MIN);
  assert.equal(view.stuck[0].progress.remainingMs, 6 * MIN);
  assert.equal(view.stuck[0].progress.ratio, 0.4);
  assert.equal(view.unavailable, false);
});

test('F-03-7 T18-2 풀린 조치는 10분 0ms까지 최근 풀림으로 남고 1ms 뒤 사라진다', async () => {
  const { autoActionView, RECENTLY_CLEARED_MS } = await load();
  const list = [{ name: '결제사 시험 재개', target: 'payment-svc', state: 'CLEARED', startedAt: AT, endedAt: AT }];
  const at = autoActionView(list, AT_MS + RECENTLY_CLEARED_MS);
  assert.equal(RECENTLY_CLEARED_MS, 10 * MIN);
  assert.equal(at.recentlyCleared.length, 1);
  assert.equal(at.stuck.length, 0);
  const late = autoActionView(list, AT_MS + RECENTLY_CLEARED_MS + 1);
  assert.equal(late.recentlyCleared.length, 0);
});

test('F-03-7 T18-3 본문이 없는 사건은 이름·상태만, 값이 없으면 원천 연결 전이고 0으로 그리지 않는다', async () => {
  const { autoActionView } = await load();
  const unknown = autoActionView([{ name: '원천 이름 없음', target: '', state: 'STUCK' }], AT_MS);
  assert.equal(unknown.stuck.length, 1);
  assert.equal(unknown.stuck[0].startedAt, null);
  assert.equal(unknown.stuck[0].progress, null);
  assert.equal(unknown.unavailable, false, '이름과 상태가 있으면 그린다');
  const none = autoActionView([], AT_MS);
  assert.equal(none.unavailable, true);
  assert.match(none.message, /원천 연결 전/);
});
