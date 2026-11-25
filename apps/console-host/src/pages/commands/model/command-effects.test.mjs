// 명령 4·5 효과 줄 시험(F-03-7 T17, C-T33, 시험 먼저).
// 정본: docs/features/control-tower.md §3 '명령 4·5 효과 줄'(ack 뒤 10분 [가정], 차단 비율·추가 검증 통과율·이의 제기 수,
// 통과율 10%p [가정] 하락 또는 이의 5건 [가정]이면 SEV2). 값이 없으면 0이 아니라 '원천 연결 전'이다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
const load = () => import('./command-effects.ts');
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const MIN = 60_000;

const before = { blockedRatio: 0.02, passRate: 0.97, objections: 0 };
const after = { blockedRatio: 0.31, passRate: 0.84, objections: 6 };

test('F-03-7 T17-1 효과 줄은 명령 4·5만, ack 10분 0ms까지 보이고 1ms 뒤 사라진다', async () => {
  const { effectRowOf, EFFECT_WINDOW_MS } = await load();
  assert.equal(EFFECT_WINDOW_MS, 10 * MIN, '정본 10분');
  const at = effectRowOf({ type: 'BLOCK_ASN_IP', ackedAt: AT, nowMs: AT_MS + EFFECT_WINDOW_MS, before, after });
  assert.equal(at.visible, true);
  const late = effectRowOf({ type: 'BLOCK_ASN_IP', ackedAt: AT, nowMs: AT_MS + EFFECT_WINDOW_MS + 1, before, after });
  assert.equal(late.visible, false);
  assert.equal(effectRowOf({ type: 'KILL_SWITCH', ackedAt: AT, nowMs: AT_MS, before, after }), null);
  assert.equal(effectRowOf({ type: 'BLOCK_ASN_IP', ackedAt: null, nowMs: AT_MS, before, after }), null);
});

test('F-03-7 T17-2 차단 비율·추가 검증 통과율·이의 수를 실행 전과 나란히 보이고, 통과율 10%p 하락·이의 5건에 경고한다', async () => {
  const { effectRowOf } = await load();
  const row = effectRowOf({ type: 'BLOCK_ASN_IP', ackedAt: AT, nowMs: AT_MS + MIN, before, after });
  assert.deepEqual(row.blockedRatio, { before: 0.02, after: 0.31 });
  assert.deepEqual(row.passRate, { before: 0.97, after: 0.84 });
  assert.deepEqual(row.objections, { before: 0, after: 6 });
  assert.equal(row.warn, true);
  assert.equal(row.warnReason, 'passed-rate-drop', '통과율 하락이 먼저다');
  const ok = effectRowOf({ type: 'BOT_LEVEL', ackedAt: AT, nowMs: AT_MS + MIN, before, after: { blockedRatio: 0.03, passRate: 0.88, objections: 4 } });
  assert.equal(ok.warn, false, '9%p 하락·4건은 경고가 아니다');
});

test('F-03-7 T17-3 값이 없으면 0으로 그리지 않고 원천 연결 전으로 둔다', async () => {
  const { effectRowOf } = await load();
  const row = effectRowOf({ type: 'BOT_LEVEL', ackedAt: AT, nowMs: AT_MS + MIN });
  assert.equal(row.visible, true);
  assert.equal(row.kind, 'source-unavailable');
  assert.equal(row.blockedRatio, null);
  assert.equal(row.passRate, null);
  assert.equal(row.objections, null);
  assert.equal(row.warn, false);
});
