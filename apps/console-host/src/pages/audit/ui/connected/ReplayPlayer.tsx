// 인시던트 리플레이 플레이어(SCR-031, d5 §7.4): 명령 원장·체크포인트 사건을 시간축에 놓고 재생한다.
// 휴대폰 배치에는 그리지 않는다(d5 §3.9). 사건 글은 텍스트 노드로만 그린다.
import { replayAt, type ReplayEvent } from '../../model/audit';

export const REPLAY_SPEEDS = [1, 2, 4] as const;

function elapsedLabel(fromMs: number, atMs: number): string {
  const s = Math.max(0, Math.floor((atMs - fromMs) / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function ReplayPlayer({
  timeline,
  layout,
  positionMs,
  playing,
  speed,
  onToggle,
  onSeek,
  onSpeed,
}: {
  timeline: readonly ReplayEvent[];
  layout: 'phone' | 'tablet' | 'desktop';
  positionMs: number;
  playing: boolean;
  speed: number;
  onToggle: () => void;
  onSeek: (ms: number) => void;
  onSpeed: (speed: number) => void;
}) {
  if (layout === 'phone') return null;
  const first = timeline[0]?.atMs ?? positionMs;
  const last = timeline[timeline.length - 1]?.atMs ?? positionMs;
  const at = replayAt(timeline, positionMs);
  return (
    <section className="widget" aria-labelledby="replay-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="replay-h">
          인시던트 리플레이
        </h2>
        <span className="badge">{timeline.length}개 사건</span>
      </div>
      <div className="widget-body col" style={{ padding: 12, gap: 10 }}>
        {timeline.length === 0 ? (
          <p className="t-sm muted">이 기간에 재생할 사건이 없습니다.</p>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" type="button" onClick={onToggle}>
                {playing ? '일시정지' : '재생'}
              </button>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => onSeek(first)}>
                처음으로
              </button>
              {REPLAY_SPEEDS.map((s) => (
                <button key={s} className={speed === s ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} type="button" onClick={() => onSpeed(s)} aria-pressed={speed === s}>
                  {s}×
                </button>
              ))}
              <span className="t-xs muted" aria-live="polite">
                {elapsedLabel(first, positionMs)} / {elapsedLabel(first, last)}
              </span>
            </div>
            <label className="field">
              <span className="label">재생 위치</span>
              <input
                className="input"
                type="range"
                min={first}
                max={last}
                step={1000}
                value={Math.min(Math.max(positionMs, first), last)}
                onChange={(e) => onSeek(Number(e.target.value))}
                aria-label="재생 위치"
              />
            </label>
            <ol className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
              {timeline.map((e, i) => {
                const current = i === at.index;
                return (
                  <li key={`${e.atMs}:${e.kind}:${i}`} className="t-sm" aria-current={current ? 'true' : undefined} style={{ opacity: i <= at.index ? 1 : 0.45 }}>
                    <span className="muted">{elapsedLabel(first, e.atMs)}</span> · <strong>{e.label}</strong>
                    {e.detail ? <span className="muted"> — {e.detail}</span> : null}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
