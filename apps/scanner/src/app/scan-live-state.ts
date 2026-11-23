// 판정 화면의 상태 이름·판정 화면 유지 시간·변경분 배지(계획 docs/review/plans/F-05-4.md §3, RV-11).
// React를 모르는 순수 모듈이다(node --test가 그대로 읽는다). 화면 훅 useScanLive.ts가 이 값을 가져다 쓴다.
// 정본: offline-gate §6.4(판정 화면 2초 [가정]), d5 §8.3(상태)·§8.4('변경분 2분 넘게 못 받음').

export const LIVE_SCAN_STATES = ['준비 안 됨', '카메라 권한 대기', '판정 대기', '통과', '거부', '확인 필요', '다시 찍어 주세요', '카메라 고장(스태프)', '카메라 고장(책임자)'] as const;
export type LiveScanState = (typeof LIVE_SCAN_STATES)[number];

/** 판정 화면 유지 시간(ms) */
export const RESULT_HOLD_MS = 2_000;

/** 마지막 변경분 뒤 2분(120,000ms)을 넘으면 배지. 받은 적이 없으면 배지가 없다 */
export function changesBadgeOf(lastChangesAtMs: number | undefined, nowMs: number): string | undefined {
  if (lastChangesAtMs === undefined) return undefined;
  return nowMs - lastChangesAtMs > 120_000 ? '변경분 2분 넘게 못 받음' : undefined;
}
