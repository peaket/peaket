// F-04-18 연구 원천 한 축 분포(CMP-079 한 축). 정본: docs/features/forensic-replay.md §2.1, d5 §7.17.
// first_hold_ms를 10ms~10s 로그 24칸으로 나눈 세션 수 막대다. 칸을 고르면 그 시간 범위를 넘긴다.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Histogram } from '../lib/replay/candidate.ts';

const WIDTH = 440;
const HEIGHT = 190;
const LEFT = 40;
const BASE = HEIGHT - 28;

export function DistributionPlot({
  histogram,
  onSelect,
}: {
  histogram: Histogram;
  onSelect: (fromMs: number, toMs: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const ctx = element.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const max = Math.max(1, ...histogram.bins);
    const width = (WIDTH - LEFT - 10) / Math.max(1, histogram.bins.length);
    ctx.fillStyle = 'rgba(122,167,255,0.75)';
    for (let i = 0; i < histogram.bins.length; i += 1) {
      const height = (histogram.bins[i] / max) * (BASE - 12);
      ctx.fillRect(LEFT + i * width + 1, BASE - height, Math.max(1, width - 2), height);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(LEFT, 12);
    ctx.lineTo(LEFT, BASE);
    ctx.lineTo(WIDTH - 10, BASE);
    ctx.stroke();
    ctx.fillStyle = 'rgba(224,228,236,0.75)';
    ctx.font = '10px sans-serif';
    for (const index of [0, 8, 16, 24]) {
      const x = LEFT + (index / Math.max(1, histogram.bins.length)) * (WIDTH - LEFT - 10);
      const value = histogram.edges[index] ?? histogram.maxMs;
      ctx.fillText(value >= 1_000 ? `${Math.round(value / 1_000)}s` : `${Math.round(value)}ms`, x - 10, HEIGHT - 10);
    }
  }, [histogram]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const width = (WIDTH - LEFT - 10) / Math.max(1, histogram.bins.length);
    const index = Math.max(0, Math.min(histogram.bins.length - 1, Math.floor((x - LEFT) / width)));
    onSelect(histogram.edges[index], histogram.edges[index + 1]);
  };

  return (
    <canvas
      ref={canvas}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="입장 확정에서 첫 홀드 시도까지의 분포. 가로는 로그 눈금, 세로는 세션 수입니다."
      onPointerDown={onPointerDown}
      style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 6, background: '#171a21' }}
    />
  );
}
