// 좌석 색 + 무늬(docs/design/tokens.json seat·pattern, docs/design/d2-design-system.md §1 '색만으로 가르지 않는다'·§5 대비, CMP-023, BUILD_ORDER HOT-110).
// 상태마다 색 토큰과 무늬를 함께 쓴다. 무늬는 좌석이 6 CSS px 이상일 때 그린다(그보다 작으면 보이지 않는다. 고를 수 있는 배율은 24px 이상, §5.11).
// 무늬 잉크: 체크(mine)·휠체어 아이콘은 그 모드의 glyph 토큰(토큰 설명), 빗금·X·점은 두 모드의 glyph 토큰(#ffffff·#16171b) 가운데 칠한 색과
// 대비가 큰 쪽이다. 같은 모드의 좌석 색만으로는 다크의 빗금·점이 3:1에 못 미쳐서다(2026-11-04 HOT-110, 모든 상태 3:1 이상을 시험한다).
import { pattern, seatColor, type SeatPattern, type SeatState } from '@peaket/ds/tokens';
import { FLAG } from './layout';
import { STATE } from './wire';

export type ColorMode = keyof typeof seatColor;

/** Canvas 2D에서 쓰는 것만(메인 스레드 캔버스·OffscreenCanvas 모두. 시험은 가짜로 바꾼다) */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
}

/** 무늬를 그리는 가장 작은 좌석 크기(CSS px) */
export const PATTERN_MIN_PX = 6;

/**
 * Worker 상태·플래그·내 선택 → 토큰 상태 이름. 판매 제외(EXCLUDED)가 가장 먼저이고, 판매·선택 불가(스냅샷 점유, 3)는 내가 골랐어도 판매 모양이다
 * (고른 사이 남이 판 좌석에 체크를 남기지 않는다). 내 좌석(mine)은 가능·다른 분 선택(서버는 내 홀드도 홀드로 보낸다)보다 앞선다.
 * 휠체어석은 가능할 때 wheelchair로 칠하고, 다른 상태에서는 그 상태로 칠한 뒤 휠체어 표시를 겹친다(drawSeat의 wheelchair, CMP-023).
 */
export function seatState(state: number, attr: number, mine: boolean, recentlyReleased = false): SeatState {
  const flags = attr >> 4;
  if (flags & FLAG.EXCLUDED) return 'unavailable';
  if (state === STATE.SOLD || state === STATE.UNAVAILABLE) return 'sold';
  if (mine) return 'mine';
  if (state === STATE.HELD) return 'held-by-others';
  if (recentlyReleased) return 'recently-released';
  return flags & FLAG.WHEELCHAIR ? 'wheelchair' : 'available';
}

export interface SeatStyle {
  state: SeatState;
  /** 칠할 색(recently-released는 테두리 색) */
  color: string;
  pattern: SeatPattern;
  /** 무늬·표시를 그리는 색 */
  ink: string;
}

/** WCAG 상대 휘도 대비 */
export function contrastRatio(a: string, b: string): number {
  const lum = (h: string) => {
    const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const INKS = [seatColor.light.glyph, seatColor.dark.glyph] as const;

export function seatStyle(s: SeatState, mode: ColorMode): SeatStyle {
  const palette = seatColor[mode];
  const color = s === 'recently-released' ? palette.available : palette[s];
  const ink = s === 'mine' || s === 'wheelchair' ? palette.glyph : INKS.reduce((a, b) => (contrastRatio(b, color) > contrastRatio(a, color) ? b : a));
  return { state: s, color, pattern: pattern.seat[s], ink };
}

/** 휠체어 표시: 바퀴(원)와 등받이(선) */
function wheelchairMark(ctx: Ctx2D, ink: string, sx: number, sy: number, q: number): void {
  ctx.strokeStyle = ink;
  ctx.beginPath();
  ctx.arc(sx + q / 4, sy + q / 3, q * 0.6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - q / 3, sy - q);
  ctx.lineTo(sx - q / 3, sy);
  ctx.stroke();
}

/**
 * 좌석 하나를 화면 좌표(sx, sy 중심, size 한 변 CSS px)에 그린다. ctx는 DPR이 반영된 변환 상태여야 한다.
 * wheelchair가 참이면(휠체어석인데 다른 상태로 칠한 경우) 휠체어 표시를 겹친다
 */
export function drawSeat(ctx: Ctx2D, st: SeatStyle, sx: number, sy: number, size: number, wheelchair = false): void {
  const h = size / 2;
  if (st.pattern === 'outline') {
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(1, size / 8);
    ctx.strokeRect(sx - h, sy - h, size, size);
    return;
  }
  ctx.fillStyle = st.color;
  ctx.fillRect(sx - h, sy - h, size, size);
  if (size < PATTERN_MIN_PX) return;
  ctx.strokeStyle = st.ink;
  ctx.fillStyle = st.ink;
  ctx.lineWidth = Math.max(1, size / 12);
  const q = size / 3;
  switch (st.pattern) {
    case 'diagonal-hatch': // 빗금 한 줄(다른 분 선택)
      ctx.beginPath();
      ctx.moveTo(sx - h, sy + h);
      ctx.lineTo(sx + h, sy - h);
      ctx.stroke();
      break;
    case 'cross-hatch': // X(판매·선택 불가)
      ctx.beginPath();
      ctx.moveTo(sx - q, sy - q);
      ctx.lineTo(sx + q, sy + q);
      ctx.moveTo(sx + q, sy - q);
      ctx.lineTo(sx - q, sy + q);
      ctx.stroke();
      break;
    case 'solid-with-check': // 체크(내 좌석)
      ctx.beginPath();
      ctx.moveTo(sx - q, sy);
      ctx.lineTo(sx - q / 3, sy + q * 0.8);
      ctx.lineTo(sx + q, sy - q * 0.7);
      ctx.stroke();
      break;
    case 'dotted': // 가운데 점(판매 제외)
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1, size / 10), 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'solid-with-icon':
      wheelchairMark(ctx, st.ink, sx, sy, q);
      return;
    case 'solid':
      break;
  }
  if (wheelchair) wheelchairMark(ctx, st.ink, sx, sy, q);
}
