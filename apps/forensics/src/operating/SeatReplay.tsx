// F-04-17 좌석 리플레이. 정본: docs/features/forensic-replay.md §2.3·§3.4, d5 §7.17, d2 CMP-021 replay 변형.
// 색과 무늬를 함께 쓰고, 같은 집계를 표로도 보인다. 실제 회차 좌석 배치는 파일에 없어 좌석 번호 격자로 그린다.
import { useEffect, useMemo, useRef } from 'react';
import { SEAT_STATE } from '../lib/forensics/events.ts';
import { formatOffset } from '../lib/replay/playback.ts';
import { seatLegend } from '../lib/replay/table.ts';
import { ReplayTable } from './ReplayTable';

const WIDTH = 880;
const HEIGHT = 520;
const COLOR: Record<number, string> = {
  [SEAT_STATE.EMPTY]: '#3a3f4a',
  [SEAT_STATE.HELD]: '#d9a441',
  [SEAT_STATE.PAYING]: '#7aa7ff',
  [SEAT_STATE.SOLD]: '#e5484d',
};

function drawPattern(ctx: CanvasRenderingContext2D, pattern: string, x: number, y: number, cell: number): void {
  if (cell < 3) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  if (pattern === 'diagonal-hatch') {
    ctx.beginPath();
    ctx.moveTo(x, y + cell);
    ctx.lineTo(x + cell, y);
    ctx.stroke();
  } else if (pattern === 'cross-hatch') {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + cell, y + cell);
    ctx.moveTo(x + cell, y);
    ctx.lineTo(x, y + cell);
    ctx.stroke();
  } else if (pattern === 'solid-with-check') {
    ctx.beginPath();
    ctx.moveTo(x + cell * 0.2, y + cell * 0.55);
    ctx.lineTo(x + cell * 0.45, y + cell * 0.8);
    ctx.lineTo(x + cell * 0.82, y + cell * 0.25);
    ctx.stroke();
  }
  ctx.restore();
}

export function SeatReplay({
  state,
  seatCount,
  playheadMs,
  highlight = [],
}: {
  state: Uint8Array;
  seatCount: number;
  playheadMs: number;
  highlight?: readonly number[];
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const legend = useMemo(() => seatLegend(), []);
  const highlighted = useMemo(() => new Set(highlight), [highlight]);
  const counts = useMemo(() => {
    const out: Record<number, number> = {
      [SEAT_STATE.EMPTY]: 0,
      [SEAT_STATE.HELD]: 0,
      [SEAT_STATE.PAYING]: 0,
      [SEAT_STATE.SOLD]: 0,
    };
    for (let i = 0; i < state.length; i += 1) out[state[i]] = (out[state[i]] ?? 0) + 1;
    return out;
  }, [state]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const ctx = element.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = '#171a21';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (seatCount <= 0) return;
    const columns = Math.max(1, Math.ceil(Math.sqrt(seatCount * 1.6)));
    const rows = Math.max(1, Math.ceil(seatCount / columns));
    const cell = Math.max(1, Math.min(6, Math.floor(WIDTH / columns), Math.floor(HEIGHT / rows)));
    const offsetX = Math.floor((WIDTH - columns * cell) / 2);
    const offsetY = Math.floor((HEIGHT - rows * cell) / 2);
    const patternOf = new Map(legend.map((item) => [item.state, item.pattern]));
    for (let seat = 0; seat < seatCount; seat += 1) {
      const x = offsetX + (seat % columns) * cell;
      const y = offsetY + Math.floor(seat / columns) * cell;
      const value = state[seat] ?? SEAT_STATE.EMPTY;
      ctx.fillStyle = COLOR[value] ?? COLOR[SEAT_STATE.EMPTY];
      ctx.fillRect(x, y, cell, cell);
      drawPattern(ctx, patternOf.get(value) ?? 'solid', x, y, cell);
      if (highlighted.has(seat) && cell >= 2) {
        ctx.strokeStyle = '#f4f4f5';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cell - 1), Math.max(1, cell - 1));
      }
    }
  }, [state, seatCount, legend, highlighted]);

  return (
    <section className="widget" aria-labelledby="fx-map-h">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="fx-map-h">
          좌석 리플레이
        </h2>
        <span className="mono t-sm">{formatOffset(playheadMs)}</span>
      </div>
      <div className="widget-body col" style={{ gap: 10 }}>
        <canvas
          ref={canvas}
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-label={`좌석 리플레이. ${formatOffset(playheadMs)}의 좌석 상태입니다. 빈 좌석 ${counts[SEAT_STATE.EMPTY]}석, 홀드 ${counts[SEAT_STATE.HELD]}석, 결제 중 ${counts[SEAT_STATE.PAYING]}석, 판매 ${counts[SEAT_STATE.SOLD]}석.`}
          style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 6 }}
        />
        <div className="row wrap" style={{ gap: 12 }}>
          {legend.map((item) => (
            <span key={item.state} className="row t-xs muted" style={{ gap: 5 }}>
              <span
                aria-hidden="true"
                data-pattern={item.pattern}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  border: '1px solid var(--border)',
                  background: COLOR[item.state] ?? COLOR[SEAT_STATE.EMPTY],
                }}
              />
              {item.label}
            </span>
          ))}
          <span className="row t-xs muted" style={{ gap: 5 }}>
            <span
              aria-hidden="true"
              style={{ width: 12, height: 12, borderRadius: 2, border: '2px solid #f4f4f5', background: 'transparent' }}
            />
            고른 영역
          </span>
        </div>
        <ReplayTable
          caption="좌석 상태 요약(표로 보기)"
          columns={[
            { key: 'label', label: '상태', value: (row: { label: string }) => row.label },
            { key: 'count', label: '좌석 수', value: (row: { count: number }) => row.count.toLocaleString('ko-KR') },
          ]}
          rows={legend.map((item) => ({ label: item.label, count: counts[item.state] ?? 0 }))}
        />
      </div>
    </section>
  );
}
