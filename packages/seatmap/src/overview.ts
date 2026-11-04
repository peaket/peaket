// 전체 배치도(CMP-021 overview, docs/design/d2-design-system.md CMP-024·§5, docs/features/seat-hold.md §10, BUILD_ORDER HOT-120).
// 구역 면은 등급 색을 보조로 칠한다: 가격이 높은 등급부터 heat.3·heat.2·heat.1, 넷째 등급부터는 면을 칠하지 않는다(글자로만 가른다).
// 면 위 글자는 heat.ink만 쓰고, 면 둘레에 border를 긋는다. 남은 좌석 상태(많음·적음·매진)는 늘 글자로 함께 적는다(색만으로 가르지 않는다).
import { color } from '@peaket/ds/tokens';
import { FLAG, type DecodedLayout } from './layout';
import type { ColorMode } from './paint';
import { STATE } from './wire';

/** 남은 좌석이 이 비율 이하면 '적음', 0이면 '매진'(경계는 아직 정하지 않았다, docs/design/d5 §6 33번) [가정] */
export const FEW_RATIO = 0.1;

export type SectionStatus = 'plenty' | 'few' | 'soldout';
export const STATUS_LABEL: Record<SectionStatus, string> = { plenty: '많음', few: '적음', soldout: '매진' };

/** 구역마다 좌석이 가장 많은 등급의 tiers 색인(같으면 앞 등급) */
export function sectionTiers(L: DecodedLayout): Uint8Array {
  const out = new Uint8Array(L.S);
  const count = new Uint32Array(16);
  for (let s = 0; s < L.S; s++) {
    count.fill(0);
    for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) count[L.attr[k]! & 15]!++;
    let best = 0;
    for (let t = 1; t < 16; t++) if (count[t]! > count[best]!) best = t;
    out[s] = best;
  }
  return out;
}

/** 구역 하나의 남은 좌석(판매 제외 좌석은 세지 않는다)과 상태 */
export function sectionStatus(L: DecodedLayout, state: Uint8Array, s: number): { free: number; sellable: number; status: SectionStatus } {
  let free = 0;
  let sellable = 0;
  for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
    if ((L.attr[k]! >> 4) & FLAG.EXCLUDED) continue;
    sellable++;
    if (state[k] === STATE.AVAILABLE) free++;
  }
  const status: SectionStatus = free === 0 ? 'soldout' : free / sellable <= FEW_RATIO ? 'few' : 'plenty';
  return { free, sellable, status };
}

/** 등급 순위(tiers 차례, 가격이 높은 등급이 앞)의 면 색. 넷째 등급부터는 칠하지 않는다(null) */
export function tierFace(rank: number, mode: ColorMode): string | null {
  const c = color[mode];
  return rank === 0 ? c['heat-3'] : rank === 1 ? c['heat-2'] : rank === 2 ? c['heat-1'] : null;
}

/** 전체 배치도에 쓰는 색(토큰) */
export function overviewPalette(mode: ColorMode) {
  const c = color[mode];
  return { bg: c.surface, line: c.border, ink: c['heat-ink'], stage: c.text, text: c.text };
}

/** 점(세계 좌표)이 다각형 안인가(짝수-홀수 규칙) */
export function pointInPolygon(points: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
