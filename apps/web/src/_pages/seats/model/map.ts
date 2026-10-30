// SCR-010 좌석맵 근사(add-screen-publishing design.md 결정 8): 보드가 그린 '카메라'(배율·중심)와 좌석 배치를 그대로 계산한다.
// 보드는 고정 폭 액자(휴대폰 344 · 태블릿 720 · 데스크톱 802)에 맞춘 px 값이다. 페이지에서는 액자 폭이 유동이라
// 모든 위치를 액자 가운데 기준(left:50%·top:50% + 보드 값)으로 바꿨다. 액자 높이는 보드대로 420 · 560 · 600.
// 실제 서비스의 Canvas·Web Worker 그리기, 휠·핀치 확대는 붙이지 않는다(d5 §5.10 '시연 흉내').
import type { CSSProperties } from 'react';
import { SEAT_COLS, SEAT_ROWS, seatClassAt, seatXY, type SeatScene } from '@/entities/seat';
import type { MapLevel } from './view';

export interface Cam {
  cx: number;
  cy: number;
  s: number;
}

export type MapBp = 'm' | 't' | 'd';

export interface MapBpConfig {
  /** 보드 액자 폭·높이 */
  fw: number;
  fh: number;
  over: Cam;
  mid: Cam;
  seat: Cam;
  /** 좌석 지름 */
  d: number;
  /** 미니맵 폭·높이·여백 */
  mm: { w: number; h: number; inset: number };
  /** 팝오버 폭(좌석 정보 · 방금 놓은 좌석) */
  pop: number;
  rec: number;
  /** 무대 방향 띠 폭·높이 */
  stage: { w: number; h: number };
}

// 태블릿 좌석 배율은 보드(3.3·중심 200)와 데스크톱(3.2·중심 199)이 거의 같아 데스크톱 값을 같이 쓴다(좌석 층을 하나로 그린다).
export const MAP_BP: Record<MapBp, MapBpConfig> = {
  m: {
    fw: 344,
    fh: 420,
    over: { cx: 500, cy: 278, s: 0.5 },
    mid: { cx: 500, cy: 240, s: 0.6 },
    seat: { cx: 450, cy: 210, s: 3.6 },
    d: 14,
    mm: { w: 84, h: 59, inset: 8 },
    pop: 168,
    rec: 232,
    stage: { w: 160, h: 20 },
  },
  t: {
    fw: 720,
    fh: 560,
    over: { cx: 500, cy: 278, s: 1.03 },
    mid: { cx: 500, cy: 240, s: 1.236 },
    seat: { cx: 500, cy: 199, s: 3.2 },
    d: 13,
    mm: { w: 112, h: 78, inset: 10 },
    pop: 176,
    rec: 240,
    stage: { w: 240, h: 22 },
  },
  d: {
    fw: 802,
    fh: 600,
    over: { cx: 500, cy: 278, s: 1.08 },
    mid: { cx: 500, cy: 240, s: 1.404 },
    seat: { cx: 500, cy: 199, s: 3.2 },
    d: 13,
    mm: { w: 126, h: 88, inset: 12 },
    pop: 184,
    rec: 248,
    stage: { w: 280, h: 22 },
  },
};

export function camFor(bp: MapBp, level: MapLevel): Cam {
  const c = MAP_BP[bp];
  return level === 'seats' ? c.seat : level === 'mid' ? c.mid : c.over;
}

/** 1000×600 배치도를 액자 가운데에 두는 층 모양(보드 cam()의 translate·scale을 가운데 기준으로) */
export function layerStyle(cam: Cam): CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 1000,
    height: 600,
    transformOrigin: '0 0',
    transform: `translate(${(-cam.s * cam.cx).toFixed(1)}px, ${(-cam.s * cam.cy).toFixed(1)}px) scale(${cam.s})`,
  };
}

const px = (n: number) => `${n.toFixed(1)}px`;
const fromCenter = (n: number) => `calc(50% + ${px(n)})`;

export interface SeatDot {
  key: string;
  cls: string;
  style: CSSProperties;
}

/**
 * 좌석 층(보드 seatLayer). 열은 무대 방향 띠(위 26px)와 아래 가장자리에 걸리지 않는 것만, 좌석은 가로로 halfW 안의 것만 그린다.
 * halfW는 그 중단점에서 액자가 가장 넓어질 때의 반폭이다(나머지는 액자의 overflow:hidden이 자른다).
 */
export function seatDots(bp: MapBp, scene: SeatScene, halfW: number): SeatDot[] {
  const { seat: k, fh, d } = MAP_BP[bp];
  const h = d / 2;
  const out: SeatDot[] = [];
  for (let r = 1; r <= SEAT_ROWS; r++) {
    const yc = 128 + (r - 1) * 7.6;
    const ty = fh / 2 - k.s * k.cy;
    if (ty + k.s * (yc - 2.1) - h < 26 || ty + k.s * yc + h > fh) continue;
    for (let c = 1; c <= SEAT_COLS; c++) {
      const q = seatXY(r, c);
      const dx = k.s * (q.x - k.cx);
      if (Math.abs(dx) > halfW - h) continue;
      const dy = k.s * (q.y - k.cy);
      const cls = seatClassAt(r, c, scene);
      const ring: CSSProperties = cls.includes('recent') ? { background: 'transparent', boxShadow: 'inset 0 0 0 2px var(--seat-available)' } : {};
      out.push({
        key: `${r}-${c}`,
        cls: cls.replace('recent', '').trim(),
        style: { position: 'absolute', left: fromCenter(dx - h), top: fromCenter(dy - h), width: d, height: d, borderRadius: '50%', ...ring },
      });
    }
  }
  return out;
}

/** 열 이름표(보드 rowLabels) */
export function rowLabels(bp: MapBp): { key: string; text: string; style: CSSProperties }[] {
  const { seat: k, fh, d } = MAP_BP[bp];
  const h = d / 2;
  const out: { key: string; text: string; style: CSSProperties }[] = [];
  for (let r = 1; r <= SEAT_ROWS; r++) {
    const yc = 128 + (r - 1) * 7.6;
    const ty = fh / 2 - k.s * k.cy;
    if (ty + k.s * (yc - 2.1) - h < 26 || ty + k.s * yc + h > fh) continue;
    const q = seatXY(r, 1);
    out.push({
      key: `r${r}`,
      text: `${r}열`,
      style: { position: 'absolute', left: `max(0px, ${fromCenter(k.s * (q.x - k.cx) - h - 26)})`, top: fromCenter(k.s * (q.y - k.cy) - 7) },
    });
  }
  return out;
}

/** 좌석 옆 팝오버·말풍선 자리(보드 near): 오른쪽 위, 액자를 넘으면 안쪽으로 */
export function nearStyle(bp: MapBp, row: number, col: number, w: number, hh: number): CSSProperties {
  const { seat: k, fh } = MAP_BP[bp];
  const q = seatXY(row, col);
  const dx = k.s * (q.x - k.cx);
  const py = fh / 2 + k.s * (q.y - k.cy);
  let top = py - hh - 14;
  if (top < 6) top = py + 14;
  return { position: 'absolute', left: `max(6px, min(${fromCenter(dx + 12)}, calc(100% - ${w + 6}px)))`, top: px(top), width: w };
}

/** 미니맵의 지금 보는 범위 사각형(보드 mini, 보드 액자 폭 기준 근사) */
export function minimapRect(bp: MapBp, level: MapLevel): CSSProperties {
  const { fw, fh, mm } = MAP_BP[bp];
  const k = camFor(bp, level);
  const tx = fw / 2 - k.s * k.cx;
  const ty = fh / 2 - k.s * k.cy;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const l = clamp(((-tx / k.s - 150) / 700) * mm.w, mm.w);
  const r = clamp((((fw - tx) / k.s - 150) / 700) * mm.w, mm.w);
  const t = clamp(((-ty / k.s - 30) / 490) * mm.h, mm.h);
  const b = clamp((((fh - ty) / k.s - 30) / 490) * mm.h, mm.h);
  return { position: 'absolute', left: px(l), top: px(t), width: px(r - l), height: px(b - t), border: '2px solid var(--primary)', borderRadius: 2 };
}
