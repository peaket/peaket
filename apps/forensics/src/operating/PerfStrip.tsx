// F-04-18 상태 띠. 정본: docs/features/forensic-replay.md §2.1·§7.1, d5 §7.17.
// 이 기기에서 잰 값만 보인다. 측정이 없으면 0이 아니라 —다. 공유 시계는 더하지 않아 늘 복사 방식이다.
import { clockModeLabel, SHARED_CLOCK_ENABLED } from '../lib/replay/chart-runtime.ts';
import { perfStatus, type PerfSample } from '../lib/replay/perf.ts';

export function PerfStrip({ sample }: { sample: PerfSample }) {
  const status = perfStatus(sample);
  const filterText = status.filterP95 === null ? '—' : `${status.filterP95.toFixed(1)}ms`;
  const frameText = status.frameP95 === null ? '—' : `${status.frameP95.toFixed(1)}ms`;
  return (
    <div className="row wrap t-xs muted" role="status" aria-live="polite" style={{ gap: 14, padding: '6px 2px' }}>
      <span>필터 반영 {filterText}</span>
      <span>프레임 {frameText}</span>
      <span>긴 작업 {status.longTasks}</span>
      <span>공유 메모리 {clockModeLabel(SHARED_CLOCK_ENABLED)}</span>
    </div>
  );
}
