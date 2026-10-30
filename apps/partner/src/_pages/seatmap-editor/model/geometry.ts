// SCR-022 목업 배치본: 피켓 아레나 1층(무대 + 구역 6개, 2,400석)의 도형과 좌석 좌표. 좌표는 캔버스 보드 SCR-022의 SVG(viewBox 0 20 640 400) 그대로다.
// 좌석 좌표 계산은 보드 스크립트(ghost·a1Seats·rSeats·r1Rows)를 옮긴 것이다. 실제 계산은 에디터 Worker가 한다(frontend §3.9).
import type { EditorSeat, ViewBox, ZoneGeometry } from '@peaket/ds/SeatMapEditorCanvas';

export const FULL_VIEW: ViewBox = [0, 20, 640, 400];
/** A1구역(곡선 띠) 확대 */
export const A1_VIEW: ViewBox = [80, 196, 260, 196];
/** R1·R2구역 확대 */
export const R_VIEW: ViewBox = [180, 64, 280, 190];

export const STAGE: ZoneGeometry = { kind: 'rect', x: 240, y: 30, w: 160, h: 50, rx: 6 };

export type Grade = 'R' | 'S' | 'A';

export interface ArenaZone {
  id: 'R1' | 'R2' | 'S1' | 'S2' | 'A1' | 'A2';
  name: string;
  grade: Grade;
  seats: number;
  kindLabel: string;
  shape: ZoneGeometry;
  /** 배치 층 라벨 위치(이름 줄) */
  label: { x: number; y: number };
  /** 미리보기 라벨 알약의 왼쪽 위 */
  pill: { x: number; y: number };
  /** 휴대폰 미리보기 알약의 왼쪽 위(100×56) */
  mPill: { x: number; y: number };
}

export const ZONES: readonly ArenaZone[] = [
  { id: 'R1', name: 'R1구역', grade: 'R', seats: 300, kindLabel: '사각형', shape: { kind: 'rect', x: 205, y: 105, w: 110, h: 135, rx: 3 }, label: { x: 260, y: 166 }, pill: { x: 214, y: 152 }, mPill: { x: 210, y: 144 } },
  { id: 'R2', name: 'R2구역', grade: 'R', seats: 300, kindLabel: '사각형', shape: { kind: 'rect', x: 325, y: 105, w: 110, h: 135, rx: 3 }, label: { x: 380, y: 166 }, pill: { x: 334, y: 152 }, mPill: { x: 330, y: 144 } },
  { id: 'S1', name: 'S1구역', grade: 'S', seats: 450, kindLabel: '부채꼴', shape: { kind: 'path', d: 'M83.6 264.7A300 300 0 0 1 20 80L115 80A205 205 0 0 0 158.5 206.2Z' }, label: { x: 81, y: 156 }, pill: { x: 35, y: 142 }, mPill: { x: 31, y: 134 } },
  { id: 'S2', name: 'S2구역', grade: 'S', seats: 450, kindLabel: '부채꼴', shape: { kind: 'path', d: 'M620 80A300 300 0 0 1 556.4 264.7L481.5 206.2A205 205 0 0 0 525 80Z' }, label: { x: 559, y: 156 }, pill: { x: 513, y: 142 }, mPill: { x: 509, y: 134 } },
  { id: 'A1', name: 'A1구역', grade: 'A', seats: 450, kindLabel: '곡선 띠', shape: { kind: 'path', d: 'M314.8 380A300 300 0 0 1 97.1 280.7L167.7 217.2A205 205 0 0 0 316.4 285Z' }, label: { x: 215, y: 304 }, pill: { x: 169, y: 290 }, mPill: { x: 165, y: 282 } },
  { id: 'A2', name: 'A2구역', grade: 'A', seats: 450, kindLabel: '곡선 띠', shape: { kind: 'path', d: 'M542.9 280.7A300 300 0 0 1 325.2 380L323.6 285A205 205 0 0 0 472.3 217.2Z' }, label: { x: 425, y: 304 }, pill: { x: 379, y: 290 }, mPill: { x: 375, y: 282 } },
];

export function zone(id: ArenaZone['id']): ArenaZone {
  return ZONES.find((z) => z.id === id)!;
}

/** 등급별 미리보기 색(heat 3단계, 팬 좌석 선택과 같다) */
export const GRADE_FILL: Record<Grade, string> = { R: 'var(--heat-3)', S: 'var(--heat-2)', A: 'var(--heat-1)' };

/** 작은 지도 도형: 편집(회색 + 고른 구역 강조) 또는 미리보기(등급 색) */
export function miniShapes(mode: 'edit' | 'preview', focusId?: ArenaZone['id']) {
  const stage = { shape: STAGE, fill: 'var(--fill-weak-strong)' };
  const zones = ZONES.map((z) => ({
    shape: z.shape.kind === 'rect' ? ({ ...z.shape, rx: undefined } as ZoneGeometry) : z.shape,
    fill: mode === 'preview' ? GRADE_FILL[z.grade] : z.id === focusId ? 'var(--primary-subtle)' : 'var(--fill-weak-strong)',
  }));
  return [stage, ...zones];
}

/* ---------- 좌석 좌표(보드 스크립트를 옮김) ---------- */

const RAD = Math.PI / 180;

/** '② 좌석 채우기' 미리보기의 흐린 좌석 598석(A1구역, 무대를 향한 곡선 20행, 세로 통로 2개) */
export function ghostSeats(): EditorSeat[] {
  const counts = [26, 26, 27, 27, 28, 28, 29, 29, 30, 30, 31, 31, 31, 31, 32, 32, 32, 32, 33, 33];
  const a0 = 91 * RAD;
  const a1 = 138 * RAD;
  const out: EditorSeat[] = [];
  for (let k = 0; k < 20; k++) {
    const r = 209 + (k * 87) / 19;
    const n = counts[k]!;
    const third = Math.round(n / 3);
    const blocks = [third, third, n - 2 * third];
    const edge = 3 / r;
    const aisle = 12 / r;
    const step = (a1 - a0 - 2 * edge - 2 * aisle) / n;
    let ang = a0 + edge;
    for (const b of blocks) {
      for (let j = 0; j < b; j++) {
        const t = ang + (j + 0.5) * step;
        out.push({ x: 320 + r * Math.cos(t), y: 80 + r * Math.sin(t), kind: 'ghost' });
      }
      ang += b * step + aisle;
    }
  }
  return out;
}

/** A1구역 18열 × 25석. 18열 1~4·9·10·22~25번이 휠체어석, 9·10번은 위치 확인(W2) */
export function a1Seats(): EditorSeat[] {
  const a0 = 91 * RAD;
  const a1 = 138 * RAD;
  const out: EditorSeat[] = [];
  for (let k = 0; k < 18; k++) {
    const r = 209 + (k * 87) / 17;
    const edge = 3 / r;
    const aisle = 10 / r;
    const step = (a1 - a0 - 2 * edge - aisle) / 25;
    for (let j = 0; j < 25; j++) {
      const no = 25 - j;
      const t = a0 + edge + (j + 0.5) * step + (j >= 13 ? aisle : 0);
      const last = k === 17;
      const wc = last && (no <= 4 || no === 9 || no === 10 || no >= 22);
      const bad = last && (no === 9 || no === 10);
      out.push({ x: 320 + r * Math.cos(t), y: 80 + r * Math.sin(t), kind: wc ? 'wc' : 'normal', warn: bad });
    }
  }
  return out;
}

/** R1·R2구역 15열 × 20석. 'sel'은 R1 12열 5~16번 선택, 'over'는 R1 12열 7~9번이 13열 쪽으로 밀려 겹침 */
export function rSeats(mode: 'sel' | 'over'): EditorSeat[] {
  const out: EditorSeat[] = [];
  for (let s = 0; s < 2; s++) {
    for (let r = 1; r <= 15; r++) {
      const y = 109.5 + (r - 1) * 9;
      for (let j = 1; j <= 20; j++) {
        const x = 210.4 + (j - 1) * 4.8 + (j > 10 ? 8 : 0) + s * 120;
        const sel = mode === 'sel' && s === 0 && r === 12 && j >= 5 && j <= 16;
        const moved = mode === 'over' && s === 0 && r === 12 && j >= 7 && j <= 9;
        if (moved) out.push({ x: x + 0.6, y: y + 7, warn: true });
        else out.push({ x, y, kind: sel ? 'mine' : 'normal' });
      }
    }
  }
  return out;
}

/** 확대 미리보기(R1구역 15열 × 20석, 10번과 11번 사이 통로) */
export interface PreviewRow {
  label: string;
  seats: { gap?: boolean; warn?: boolean }[];
}

export function r1Rows(over = false): PreviewRow[] {
  const rows: PreviewRow[] = [];
  for (let r = 1; r <= 15; r++) {
    const seats: PreviewRow['seats'] = [];
    for (let c = 1; c <= 20; c++) {
      if (c === 11) seats.push({ gap: true });
      seats.push({ warn: over && r === 12 && c >= 7 && c <= 9 });
    }
    rows.push({ label: `${r}열`, seats });
  }
  return rows;
}

/** 도형 밖 좌석 3석(S2구역 1열 1~3번) */
export const OUTSIDE_SEATS: readonly [number, number][] = [
  [509.1, 113.3],
  [502.6, 139.3],
  [492.6, 164.2],
];
