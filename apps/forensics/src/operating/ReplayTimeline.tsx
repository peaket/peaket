// F-04-17 타임라인(CMP-039 scrub). 정본: docs/features/forensic-replay.md §2.1·§2.3, d5 §7.17.
// 재생·일시정지·배속·구간 고르기를 키보드와 숫자 입력으로도 할 수 있게 한다.
import { useState, type KeyboardEvent } from 'react';
import type { TimelineBucket } from '../lib/replay/crossfilter.ts';
import { parseOffset, rangeFromInput, setSpeed, timelineAria, timelineKey, type PlaybackState, type Speed } from '../lib/replay/playback.ts';
import type { ReplayBounds } from '../lib/replay/session.ts';
import { timelineRows } from '../lib/replay/table.ts';
import { ReplayTable } from './ReplayTable';

const SPEEDS: readonly { label: string; value: Speed }[] = [
  { label: '×1', value: 1 },
  { label: '×10', value: 10 },
  { label: '×60', value: 60 },
];

export function ReplayTimeline({
  playback,
  bounds,
  buckets,
  onChange,
}: {
  playback: PlaybackState;
  bounds: ReplayBounds;
  buckets: readonly TimelineBucket[];
  onChange: (next: PlaybackState) => void;
}) {
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const aria = timelineAria(playback, bounds);
  const percent = aria.max === aria.min ? 0 : ((aria.now - aria.min) / (aria.max - aria.min)) * 100;
  const maxBar = Math.max(
    1,
    ...buckets.map((bucket) => bucket.queueEnter + bucket.holdTry + bucket.conflict + bucket.sale),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = timelineKey(playback, { key: event.key, shiftKey: event.shiftKey }, bounds);
    if (next !== playback) {
      event.preventDefault();
      onChange(next);
    }
  };

  const applyRange = (): void => {
    if (parseOffset(fromText) === undefined || parseOffset(toText) === undefined) return;
    const range = rangeFromInput(fromText, toText, bounds);
    if (range !== undefined) onChange({ ...playback, range, anchorMs: null });
  };

  return (
    <section className="widget" aria-labelledby="fx-tl-h">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="fx-tl-h">
          타임라인
        </h2>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            onClick={() => onChange({ ...playback, playing: !playback.playing })}
            aria-pressed={playback.playing}
          >
            {playback.playing ? '일시정지' : '재생'}
          </button>
          {SPEEDS.map((speed) => (
            <button
              key={speed.value}
              className={playback.speed === speed.value ? 'chip chip-sm is-active' : 'chip chip-sm'}
              type="button"
              aria-pressed={playback.speed === speed.value}
              onClick={() => onChange(setSpeed(playback, speed.value))}
            >
              {speed.label}
            </button>
          ))}
        </div>
      </div>
      <div className="widget-body col" style={{ gap: 10 }}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="재생 위치"
          aria-valuemin={aria.min}
          aria-valuemax={aria.max}
          aria-valuenow={aria.now}
          aria-valuetext={aria.text}
          onKeyDown={onKeyDown}
          style={{ position: 'relative', height: 34, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', overflow: 'hidden' }}
        >
          <div className="row" style={{ alignItems: 'flex-end', gap: 1, height: '100%', padding: '4px 2px' }} aria-hidden="true">
            {buckets.map((bucket) => {
              const total = bucket.queueEnter + bucket.holdTry + bucket.conflict + bucket.sale;
              return (
                <span
                  key={bucket.atMs}
                  style={{
                    flex: '1 1 0',
                    height: `${Math.max(2, (total / maxBar) * 100)}%`,
                    background: bucket.conflict > 0 ? 'var(--danger)' : bucket.sale > 0 ? 'var(--text)' : 'var(--text-muted)',
                    opacity: total === 0 ? 0.15 : 0.85,
                  }}
                />
              );
            })}
          </div>
          <span
            aria-hidden="true"
            style={{ position: 'absolute', top: 0, bottom: 0, left: `${percent}%`, width: 2, background: 'var(--brand, #7aa7ff)' }}
          />
        </div>
        <div className="row wrap between" style={{ gap: 8 }}>
          <span className="mono t-sm">{aria.text}</span>
          <div className="row wrap" style={{ gap: 6 }}>
            <label className="row t-xs muted" style={{ gap: 4 }}>
              시작
              <input className="input input-sm mono" value={fromText} onChange={(event) => setFromText(event.target.value)} placeholder="T+00:00" style={{ width: 84 }} />
            </label>
            <label className="row t-xs muted" style={{ gap: 4 }}>
              끝
              <input className="input input-sm mono" value={toText} onChange={(event) => setToText(event.target.value)} placeholder="T+01:00" style={{ width: 84 }} />
            </label>
            <button className="btn btn-ghost btn-sm" type="button" onClick={applyRange}>
              구간 적용
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange({ ...playback, range: null, anchorMs: null })}>
              고르기 지우기
            </button>
          </div>
        </div>
        <details>
          <summary className="t-sm" style={{ cursor: 'pointer' }}>
            표로 보기
          </summary>
          <ReplayTable
            caption="초당 대기열 진입·홀드 시도·경합·판매"
            columns={[
              { key: 'second', label: '시각', value: (row: { second: string }) => row.second },
              { key: 'queueEnter', label: '대기열 진입', value: (row: { queueEnter: number }) => row.queueEnter },
              { key: 'holdTry', label: '홀드 시도', value: (row: { holdTry: number }) => row.holdTry },
              { key: 'conflict', label: '경합', value: (row: { conflict: number }) => row.conflict },
              { key: 'sale', label: '판매', value: (row: { sale: number }) => row.sale },
            ]}
            rows={timelineRows(buckets)}
          />
        </details>
      </div>
    </section>
  );
}
