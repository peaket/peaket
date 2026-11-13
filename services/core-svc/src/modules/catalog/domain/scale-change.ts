// 규모 올리기 규칙(ADR-0078 결정 1, POL-030): 판매 승인 뒤 T-30분 점검 시작 전까지 올리기만 한다.
// LARGE로 올릴 때 다른 LARGE 공연과 오픈 30분 안이면 409이고, commander가 재인증해 간격 예외를 고를 때만 통과한다.
import type { ShowScale } from './demand-forecast.js';
import { scaleRank } from './demand-forecast.js';

export const SCALE_CHANGE_CLOSE_MS = 30 * 60 * 1000;
export const LARGE_INTERVAL_MS = 30 * 60 * 1000;

export type ScaleChangeProblem = { type: string; status: number; title: string; extensions?: Record<string, unknown> };

export function checkScaleChange(input: {
  saleReview: string;
  currentScale: ShowScale | undefined;
  openAt: Date;
  now: Date;
  newScale: ShowScale;
  intervalException: boolean;
  role: string | undefined;
  otherLargeOpenAt: readonly Date[];
}): { ok: true } | { ok: false; problem: ScaleChangeProblem } {
  if (input.saleReview !== 'APPROVED') {
    return { ok: false, problem: { type: 'scale-change-not-approved', status: 422, title: '판매 승인된 공연만 규모를 올릴 수 있습니다' } };
  }
  if (input.now.getTime() >= input.openAt.getTime() - SCALE_CHANGE_CLOSE_MS) {
    return { ok: false, problem: { type: 'scale-change-closed', status: 409, title: '규모를 바꿀 수 있는 시각이 지났습니다' } };
  }
  if (input.currentScale === undefined || scaleRank(input.newScale) <= scaleRank(input.currentScale)) {
    return { ok: false, problem: { type: 'scale-change-not-up', status: 422, title: '지금보다 큰 규모로만 올릴 수 있습니다' } };
  }
  if (input.intervalException && input.role !== 'commander') {
    return { ok: false, problem: { type: 'commander-required', status: 403, title: '간격 예외는 commander만 쓸 수 있습니다' } };
  }
  if (input.newScale === 'LARGE') {
    const conflict = input.otherLargeOpenAt.some((t) => Math.abs(t.getTime() - input.openAt.getTime()) < LARGE_INTERVAL_MS);
    if (conflict && !input.intervalException) {
      return { ok: false, problem: { type: 'open-interval-conflict', status: 409, title: '다른 대규모 공연과 오픈 시각이 겹칩니다' } };
    }
  }
  return { ok: true };
}
