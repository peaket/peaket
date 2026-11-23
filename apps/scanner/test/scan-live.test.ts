// F-05-4 판정 화면 상태 이름·판정 화면 유지 시간·변경분 배지 경계 시험(계획 docs/review/plans/F-05-4.md §4 'ScanScreen.tsx(실제 연결), app/useScanLive.ts(새 훅)').
// 정본: docs/features/offline-gate.md §6.4 '스캐너 앱 판정 첫 구현'(판정 화면 2초 [가정]), docs/design/d5-screen-blueprint.md §8.3(상태)·§8.4('변경분 2분 넘게 못 받음').
// 화면 연결은 tools/web-checks/scanner-scan이 본다. 이 시험은 그 값을 정한 모듈(app/useScanLive.ts)을 동적으로 불러온다(없으면 각 시험이 단언에서 떨어진다).
import assert from 'node:assert/strict';
import { test } from 'node:test';

type LiveModule = {
  LIVE_SCAN_STATES: readonly string[];
  RESULT_HOLD_MS: number;
  changesBadgeOf(lastChangesAtMs: number | undefined, nowMs: number): string | undefined;
};
const MODULE = '../src/app/useScanLive.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<LiveModule>;
function live(): LiveModule {
  assert.equal(typeof loaded.changesBadgeOf, 'function', `${MODULE}의 changesBadgeOf가 없다`);
  return loaded as LiveModule;
}

test('GAT-140 실제 연결 판정 화면의 상태는 아홉이다(준비 안 됨·카메라 권한 대기·판정 대기·통과·거부·확인 필요·다시 찍어 주세요·카메라 고장 둘)', () => {
  assert.deepEqual([...live().LIVE_SCAN_STATES], ['준비 안 됨', '카메라 권한 대기', '판정 대기', '통과', '거부', '확인 필요', '다시 찍어 주세요', '카메라 고장(스태프)', '카메라 고장(책임자)']);
});

test('GAT-140 판정 화면은 2,000ms 유지한다(offline-gate §6.4 판정 화면 2초)', () => {
  assert.equal(live().RESULT_HOLD_MS, 2_000);
});

test('GAT-140 변경분 배지: 마지막 변경분 뒤 120,000ms는 배지 없음, 120,001ms부터 "변경분 2분 넘게 못 받음"이다', () => {
  const { changesBadgeOf } = live();
  const at = Date.parse('2026-11-23T10:00:00.000Z');
  assert.equal(changesBadgeOf(at, at), undefined);
  assert.equal(changesBadgeOf(at, at + 119_999), undefined);
  assert.equal(changesBadgeOf(at, at + 120_000), undefined);
  assert.equal(changesBadgeOf(at, at + 120_001), '변경분 2분 넘게 못 받음');
  assert.equal(changesBadgeOf(at, at + 600_000), '변경분 2분 넘게 못 받음');
});
