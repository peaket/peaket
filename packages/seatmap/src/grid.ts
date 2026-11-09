// 구역별 격자 색인과 누른 좌석 찾기(docs/frontend.md §3.5 '구역별 격자 색인', BUILD_ORDER HOT-110).
// 칸(2m [가정]) → 좌석 색인 목록을 CSR(시작 위치 배열 + 항목 배열)로 둔다. 누른 점 둘레 3×3 칸만 본다.
// BAS-190 PoC는 구역을 차례로 보다 처음 맞은 구역에서 돌려줘 구역 경계에서 더 가까운 좌석을 놓칠 수 있었다. 여기서는 모든 후보 구역에서 가장 가깝다.
import { LayoutError, type DecodedLayout } from './layout';

/** 격자 칸 한 변(cm) [가정] */
export const CELL = 200;
/** 좌석 중심에서 이 거리(cm) 안을 누르면 그 좌석 [가정] */
export const HIT_RADIUS = 30;
/** 모든 구역 격자 칸 수의 상한(칸마다 4바이트, 약 16MB) [가정]. 넘는 파일은 풀지 않는다 */
export const MAX_GRID_CELLS = 4_000_000;

export interface SectionGrid {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** 칸 c의 항목은 items[start[c] .. start[c+1]) */
  start: Uint32Array;
  items: Uint32Array;
}

export function buildGrids(L: DecodedLayout, cell = CELL): SectionGrid[] {
  const grids: SectionGrid[] = [];
  let total = 0;
  for (let s = 0; s < L.S; s++) {
    const minX = L.bounds[s * 4]!;
    const minY = L.bounds[s * 4 + 1]!;
    const maxX = L.bounds[s * 4 + 2]!;
    const maxY = L.bounds[s * 4 + 3]!;
    const cols = Math.max(1, Math.ceil((maxX - minX + 1) / cell));
    const rows = Math.max(1, Math.ceil((maxY - minY + 1) / cell));
    total += cols * rows;
    if (total > MAX_GRID_CELLS) throw new LayoutError(`격자 칸이 ${MAX_GRID_CELLS}개를 넘는다(구역 ${s}까지 ${total})`);
    const start = new Uint32Array(cols * rows + 1);
    const a = L.sectionStart[s]!;
    const b = L.sectionEnd[s]!;
    const cellOf = (k: number) =>
      Math.min(rows - 1, Math.floor((L.y[k]! - minY) / cell)) * cols + Math.min(cols - 1, Math.floor((L.x[k]! - minX) / cell));
    for (let k = a; k <= b; k++) start[cellOf(k) + 1]!++;
    for (let c = 1; c < start.length; c++) start[c]! += start[c - 1]!;
    const items = new Uint32Array(b - a + 1);
    const fill = start.slice(0, -1);
    for (let k = a; k <= b; k++) items[fill[cellOf(k)]!++] = k;
    grids.push({ minX, minY, cols, rows, start, items });
  }
  return grids;
}

/**
 * 세계 좌표(cm)의 점에서 HIT_RADIUS 안의 가장 가까운 좌석 색인(없으면 -1). 같은 거리면 색인이 작은 좌석.
 * 반경이 칸보다 작아(30cm < 2m) 둘레 3×3 칸만 보면 빠짐이 없다.
 */
export function hitTest(L: DecodedLayout, grids: SectionGrid[], wx: number, wy: number, radius = HIT_RADIUS, cell = CELL): number {
  let best = -1;
  let bestD = radius * radius;
  for (let s = 0; s < L.S; s++) {
    if (wx < L.bounds[s * 4]! - radius || wx > L.bounds[s * 4 + 2]! + radius || wy < L.bounds[s * 4 + 1]! - radius || wy > L.bounds[s * 4 + 3]! + radius) continue;
    const g = grids[s]!;
    const cx = Math.floor((wx - g.minX) / cell);
    const cy = Math.floor((wy - g.minY) / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx;
        const Y = cy + dy;
        if (X < 0 || Y < 0 || X >= g.cols || Y >= g.rows) continue;
        const c = Y * g.cols + X;
        for (let i = g.start[c]!; i < g.start[c + 1]!; i++) {
          const k = g.items[i]!;
          const d = (L.x[k]! - wx) ** 2 + (L.y[k]! - wy) ** 2;
          if (d < bestD || (d === bestD && best >= 0 && k < best)) {
            bestD = d;
            best = k;
          }
        }
      }
    }
  }
  return best;
}

/** 카메라: 세계 좌표 → 화면(CSS px) = 세계 × scale + t */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

/** 화면 점(CSS px) → 좌석 색인 */
export function hitAtScreen(L: DecodedLayout, grids: SectionGrid[], cam: Camera, px: number, py: number): number {
  return hitTest(L, grids, (px - cam.tx) / cam.scale, (py - cam.ty) / cam.scale);
}

/** 상자(세계 좌표)를 화면(w×h)에 맞추는 카메라 */
export function cameraFit(w: number, h: number, bx: number, by: number, bw: number, bh: number): Camera {
  const scale = Math.min(w / bw, h / bh);
  return { scale, tx: (w - bw * scale) / 2 - bx * scale, ty: (h - bh * scale) / 2 - by * scale };
}
