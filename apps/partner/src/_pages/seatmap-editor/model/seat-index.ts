// 좌석 찾기 색인(ADR-0264 결정 3 '좌석 층'): 좌석은 노드로 만들지 않으므로 누르기·상자 고르기는 팬 좌석맵 패키지의 구역별 격자 색인으로 찾는다
// (@peaket/seatmap buildGrids·hitTest). 에디터 문서를 그 색인이 읽는 열 배열로 옮긴다(좌석이 있는 구역만).
// 뿌리('@peaket/seatmap')는 Zod를 쓰는 Worker 메시지 정의까지 실어 하위 경로로 가져온다(ADR-0264 결정 42)
import { buildGrids, hitTest, type SectionGrid } from '@peaket/seatmap/grid';
import type { DecodedLayout } from '@peaket/seatmap/layout';
import type { EditorDoc } from './types.ts';

/** 누른 점에서 이 거리(cm) 안의 가장 가까운 좌석 [가정](팬 좌석맵 HIT_RADIUS와 같다) */
export const PICK_RADIUS_CM = 30;
const CELL = 200;

export interface SeatIndex {
  L: DecodedLayout;
  grids: SectionGrid[];
  /** 색인 k → 좌석 ID */
  ids: string[];
}

export function buildSeatIndex(doc: EditorDoc): SeatIndex | null {
  const seated = doc.order.map((id) => doc.sections[id]!).filter((s) => s.seats.length > 0);
  const N = seated.reduce((n, s) => n + s.seats.length, 0);
  if (N === 0) return null;
  const x = new Float32Array(N);
  const y = new Float32Array(N);
  const sectionStart = new Uint32Array(seated.length);
  const sectionEnd = new Uint32Array(seated.length);
  const bounds = new Float32Array(seated.length * 4);
  const ids: string[] = new Array(N);
  let k = 0;
  seated.forEach((s, si) => {
    sectionStart[si] = k;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const seat of s.seats) {
      x[k] = seat.x;
      y[k] = seat.y;
      ids[k] = seat.seatId;
      minX = Math.min(minX, seat.x);
      minY = Math.min(minY, seat.y);
      maxX = Math.max(maxX, seat.x);
      maxY = Math.max(maxY, seat.y);
      k++;
    }
    sectionEnd[si] = k - 1;
    bounds.set([minX, minY, maxX, maxY], si * 4);
  });
  // 격자 색인이 읽는 칸만 채운 풀린 좌석맵(팬 파일을 거치지 않는다)
  const L = { layoutVersion: 1, N, S: seated.length, x, y, attr: new Uint8Array(N), sectionStart, sectionEnd, bounds, seatIds: [], file: null } as unknown as DecodedLayout;
  return { L, grids: buildGrids(L, CELL), ids };
}

/** 세계 좌표(cm)의 점에서 가장 가까운 좌석 ID(없으면 null) */
export function seatAt(ix: SeatIndex | null, wx: number, wy: number, radius = PICK_RADIUS_CM): string | null {
  if (!ix) return null;
  const k = hitTest(ix.L, ix.grids, wx, wy, radius, CELL);
  return k < 0 ? null : ix.ids[k]!;
}

/** 상자(세계 좌표) 안의 좌석 ID: 상자가 덮는 격자 칸만 본다 */
export function seatsInBoxIndexed(ix: SeatIndex | null, box: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
  if (!ix) return [];
  const out: string[] = [];
  const { L, grids } = ix;
  for (let s = 0; s < L.S; s++) {
    if (box.maxX < L.bounds[s * 4]! || box.minX > L.bounds[s * 4 + 2]! || box.maxY < L.bounds[s * 4 + 1]! || box.minY > L.bounds[s * 4 + 3]!) continue;
    const g = grids[s]!;
    const c0 = Math.max(0, Math.floor((box.minX - g.minX) / CELL));
    const c1 = Math.min(g.cols - 1, Math.floor((box.maxX - g.minX) / CELL));
    const r0 = Math.max(0, Math.floor((box.minY - g.minY) / CELL));
    const r1 = Math.min(g.rows - 1, Math.floor((box.maxY - g.minY) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * g.cols + c;
        for (let i = g.start[cell]!; i < g.start[cell + 1]!; i++) {
          const k = g.items[i]!;
          const px = L.x[k]!;
          const py = L.y[k]!;
          if (px >= box.minX && px <= box.maxX && py >= box.minY && py <= box.maxY) out.push(ix.ids[k]!);
        }
      }
    }
  }
  return out;
}
