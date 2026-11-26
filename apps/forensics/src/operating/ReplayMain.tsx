// F-04-17 운영 재생 화면. 정본: docs/features/forensic-replay.md §2.1~§2.3·§3.4, d5 §7.17.
// 받은 파일을 해독·검증한 세션으로 좌석 리플레이·타임라인·교차 필터를 그린다. 파일과 세션은 이 화면 메모리에만 둔다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { reconstructAt } from '../lib/forensics/checkpoint.ts';
import { timelineSeries, type ReplayFilter } from '../lib/replay/crossfilter.ts';
import { advancePlayback, initialPlayback } from '../lib/replay/playback.ts';
import type { PerfSample } from '../lib/replay/perf.ts';
import { droppedNotice, type ReplaySession } from '../lib/replay/session.ts';
import { CandidatePanel } from './CandidatePanel';
import { PerfStrip } from './PerfStrip';
import { ReplayFilters } from './ReplayFilters';
import { ReplayTimeline } from './ReplayTimeline';
import { SeatReplay } from './SeatReplay';

export function ReplayMain({ session }: { session: ReplaySession }) {
  const [playback, setPlayback] = useState(() => initialPlayback(session.bounds));
  const [filter, setFilter] = useState<ReplayFilter>(() => ({
    fromMs: session.bounds.fromMs,
    toMs: session.bounds.toMs,
  }));
  const [highlight, setHighlight] = useState<readonly number[]>([]);
  const lastFrame = useRef<number | null>(null);
  const keep = useMemo(() => new Uint8Array(session.columns.t_ms.length).fill(1), [session.columns]);
  const perfSample = useMemo<PerfSample>(() => ({ filterMs: [], frameMs: [], longTasks: 0 }), []);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number): void => {
      const previous = lastFrame.current;
      if (previous !== null) setPlayback((state) => advancePlayback(state, now - previous, session.bounds));
      lastFrame.current = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      lastFrame.current = null;
    };
  }, [session.bounds]);

  const seatState = useMemo(
    () => reconstructAt(session.checkpoints, session.columns, playback.playheadMs),
    [session.checkpoints, session.columns, playback.playheadMs],
  );
  const buckets = useMemo(
    () => timelineSeries(session.columns, keep, session.bounds, filter),
    [session.columns, keep, session.bounds, filter],
  );

  return (
    <main id="main" className="col" style={{ gap: 12, padding: '12px 16px 20px' }}>
      {session.dropped > 0 ? (
        <div className="banner banner-warning" role="status" aria-live="polite">
          <div className="banner-body">{droppedNotice(session.dropped)}</div>
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 420px)', gap: 16, alignItems: 'start' }}>
        <div className="col" style={{ gap: 16, minWidth: 0 }}>
          <SeatReplay state={seatState} seatCount={session.meta.seatCount} playheadMs={playback.playheadMs} highlight={highlight} />
          <ReplayTimeline playback={playback} bounds={session.bounds} buckets={buckets} onChange={setPlayback} />
        </div>
        <div className="col" style={{ gap: 16, minWidth: 0 }}>
          <ReplayFilters columns={session.columns} keep={keep} source={session.meta.source} filter={filter} onFilterChange={setFilter} />
          <CandidatePanel
            columns={session.columns}
            keep={keep}
            source={session.meta.source}
            bounds={session.bounds}
            filter={filter}
            onHighlight={setHighlight}
          />
        </div>
      </div>
      <PerfStrip sample={perfSample} />
    </main>
  );
}
