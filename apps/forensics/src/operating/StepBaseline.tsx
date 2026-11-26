// F-04-18 조사 원천 기준선(CMP-083). 정본: docs/features/forensic-replay.md §2.1, d5 §7.17.
// 행은 묶음 계정 여정, 열은 판매 시작 → 대기열 진입 → 입장 확정 → 첫 홀드 → 결제 시도 → 판매다.
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { EventColumns } from '../lib/forensics/events.ts';
import {
  baselineRows,
  journeys,
  stageBands,
  stageDurations,
  type StageName,
} from '../lib/replay/table.ts';

const WIDTH = 520;
const HEIGHT = 210;
const LEFT = 12;
const TOP = 38;
const COL_W = 98;
const STAGES: readonly StageName[] = ['saleToQueue', 'queueToAdmit', 'admitToHold', 'holdToPay', 'payToSale'];

function yOf(value: number): number {
  const span = Math.max(1, Math.min(5, Math.log10(Math.max(1, value))));
  return TOP + (1 - span / 5) * 120;
}

export function StepBaseline({
  columns,
  keep,
  onSelectSessions,
}: {
  columns: EventColumns;
  keep: Uint8Array;
  onSelectSessions: (sessions: readonly number[]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const memberSessions = useMemo(() => {
    const sessions = new Set<number>();
    for (let i = 0; i < columns.t_ms.length; i += 1) {
      if (keep[i] === 1 && columns.member[i] === 1) sessions.add(columns.session[i]);
    }
    return sessions;
  }, [columns, keep]);
  const memberJourneys = useMemo(
    () => journeys(columns, keep).filter((journey) => memberSessions.has(journey.session)),
    [columns, keep, memberSessions],
  );
  const bands = useMemo(() => baselineRows(stageBands(columns, keep, 0)), [columns, keep]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const ctx = element.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.font = '10px sans-serif';
    bands.forEach((band, index) => {
      const x = LEFT + index * COL_W;
      ctx.fillStyle = 'rgba(224,228,236,0.75)';
      ctx.fillText(band.stage.split(' → ')[0], x + 2, 14);
      ctx.fillText(band.stage.split(' → ')[1] ?? '', x + 2, 27);
      const top = yOf(band.p99);
      const bottom = yOf(band.p1);
      ctx.fillStyle = 'rgba(122,167,255,0.16)';
      ctx.fillRect(x + 6, top, COL_W - 18, Math.max(1, bottom - top));
      ctx.strokeStyle = 'rgba(122,167,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(x + 6, yOf(band.p50));
      ctx.lineTo(x + COL_W - 12, yOf(band.p50));
      ctx.stroke();
      for (const journey of memberJourneys) {
        const value = stageDurations(journey)[STAGES[index]];
        if (value === undefined) continue;
        ctx.fillStyle = 'rgba(255,196,92,0.9)';
        ctx.beginPath();
        ctx.arc(x + COL_W / 2, yOf(value), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.fillStyle = 'rgba(224,228,236,0.55)';
    ctx.fillText('1ms', 2, yOf(1) + 3);
    ctx.fillText('1s', 2, yOf(1_000) + 3);
    ctx.fillText('100s', 2, yOf(100_000) + 3);
  }, [bands, memberJourneys]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const index = Math.max(0, Math.min(STAGES.length - 1, Math.floor((x - LEFT) / COL_W)));
    const stage = STAGES[index];
    const sessions: number[] = [];
    for (const journey of memberJourneys) {
      if (stageDurations(journey)[stage] !== undefined) sessions.push(journey.session);
    }
    onSelectSessions(sessions);
  };

  return (
    <canvas
      ref={canvas}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label="단계별 시간 대 정상 기준선. 묶음 계정의 단계별 걸린 시간과 묶음 밖 여정의 1·50·99 백분위 띠입니다."
      onPointerDown={onPointerDown}
      style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 6, background: '#171a21' }}
    />
  );
}
