// F-04-18 성능 판정. 정본: docs/features/forensic-replay.md §7.1, d5 §7.17.
// 측정이 없으면 null로 두어 0이 합격으로 새지 않게 한다. 실제 측정은 동결 해제 뒤 측정 창 몫이다.
export const FILTER_P95_BUDGET_MS = 50;
export const FRAME_P95_BUDGET_MS = 20;

export interface PerfSample {
  filterMs: readonly number[];
  frameMs: readonly number[];
  longTasks: number;
}

export interface PerfStatus {
  /** 측정이 없으면 null */
  filterP95: number | null;
  frameP95: number | null;
  longTasks: number;
  filterOk: boolean;
  frameOk: boolean;
}

export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((95 / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function perfStatus(sample: PerfSample): PerfStatus {
  const filterP95 = p95(sample.filterMs);
  const frameP95 = p95(sample.frameMs);
  return {
    filterP95,
    frameP95,
    longTasks: sample.longTasks,
    filterOk: filterP95 !== null && filterP95 <= FILTER_P95_BUDGET_MS,
    frameOk: frameP95 !== null && frameP95 <= FRAME_P95_BUDGET_MS,
  };
}
