// 좌석맵 업무 경고 검사기(ADR-0264 결정 15, FR-023, docs/design/d5 §6.5).
// 에디터 Worker·core-svc 가져오기 다시 보기·저장이 같은 함수를 부른다. 순수 함수만 두고 DOM·DB를 모른다.
// 경고는 저장을 막지 않는다. 좌석 ID는 경고마다 100개까지 싣고 seatCount에 전체 수를 적는다.

export type SeatMapWarningCode = 'W1' | 'W2' | 'W3' | 'SEAT_OVERLAP' | 'SEAT_OUTSIDE_SHAPE' | 'SVG_IGNORED';

export interface SeatMapWarning {
  code: SeatMapWarningCode;
  seatIds?: string[];
  seatCount?: number;
  ignored?: string[];
}

export interface CheckSeat {
  seatId: string;
  row: string;
  number: number;
  x: number;
  y: number;
  wheelchair?: boolean;
  unavailable?: boolean;
}

export interface CheckSection {
  sectionId: string;
  shape: { points: readonly (readonly [number, number])[] };
  fillRule?: { seatSpacingCm?: unknown };
  seats?: readonly CheckSeat[];
}

export interface CheckLayout {
  sections: readonly CheckSection[];
}

/** 경고마다 싣는 좌석 ID 상한 [가정] */
export const WARNING_SEAT_IDS_MAX = 100;
/** 좌석 간격이 없을 때 쓰는 기본값(cm) [가정] */
export const DEFAULT_SEAT_SPACING_CM = 50;
/** 좌석 간격 상한(cm) [가정]. 비정상적으로 큰 값이 겹침 격자를 한 칸으로 만들어 5만 석에서 O(n²)이 되는 것을 막는다 */
export const SEAT_SPACING_MAX_CM = 1_000;
/** 겹침 비교 상한 [가정]. 한 칸에 아주 촘촘히 몰린 비정상 배치에서도 한 번 훑게 한다(넘으면 경고를 넓게 잡는다) */
export const MAX_OVERLAP_COMPARISONS = 1_000_000;
/** W1의 휠체어석 기준: N/100을 올림하고 20석에서 멈춘다 [가정] */
export const WHEELCHAIR_PER_100 = 100;
export const WHEELCHAIR_MAX_REQUIRED = 20;

const seatIds = (ids: readonly string[]): string[] => ids.slice(0, WARNING_SEAT_IDS_MAX);

const seatsOf = (s: CheckSection): readonly CheckSeat[] => s.seats ?? [];

/** W1~W3: 휠체어석 기준. N은 판매 제외를 포함한 전체 좌석 수다 */
export function wheelchairWarnings(sections: readonly CheckSection[]): SeatMapWarning[] {
  const seats = sections.flatMap((s) => seatsOf(s));
  const wheelchairs = seats.filter((s) => s.wheelchair === true);
  const total = seats.length;
  if (total === 0) return [];
  const required = Math.min(Math.ceil(total / WHEELCHAIR_PER_100), WHEELCHAIR_MAX_REQUIRED);
  const out: SeatMapWarning[] = [];
  if (wheelchairs.length < required) {
    out.push({ code: 'W1', seatIds: seatIds(wheelchairs.map((s) => s.seatId)), seatCount: wheelchairs.length });
  }
  const w2 = adjacentWheelchairRuns(sections);
  if (w2.length > 0) out.push({ code: 'W2', seatIds: seatIds(w2), seatCount: w2.length });
  if (wheelchairs.length > 0 && wheelchairs.every((s) => s.unavailable === true)) {
    out.push({ code: 'W3', seatIds: seatIds(wheelchairs.map((s) => s.seatId)), seatCount: wheelchairs.length });
  }
  return out;
}

/** 같은 구역·같은 열에서 이어진 휠체어석 묶음의 양옆에 일반 좌석이 2석 이상씩 있을 때 그 묶음 */
function adjacentWheelchairRuns(sections: readonly CheckSection[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    const rows = new Map<string, CheckSeat[]>();
    for (const seat of seatsOf(s)) {
      const list = rows.get(seat.row);
      if (list) list.push(seat);
      else rows.set(seat.row, [seat]);
    }
    for (const list of rows.values()) {
      const sorted = [...list].sort((a, b) => a.number - b.number);
      for (let i = 0; i < sorted.length; ) {
        if (sorted[i]!.wheelchair !== true) {
          i++;
          continue;
        }
        let j = i;
        while (j < sorted.length && sorted[j]!.wheelchair === true) j++;
        const left = sorted.slice(0, i).filter((x) => x.wheelchair !== true).length;
        const right = sorted.slice(j).filter((x) => x.wheelchair !== true).length;
        if (left >= 2 && right >= 2) for (let k = i; k < j; k++) out.push(sorted[k]!.seatId);
        i = j;
      }
    }
  }
  return out;
}

/** 구역의 좌석 간격(cm). fillRule 값이 1 이상 정수면 그것(상한 1,000cm [가정]), 아니면 50 [가정] */
export function seatSpacingOf(section: CheckSection): number {
  const v = section.fillRule?.seatSpacingCm;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, SEAT_SPACING_MAX_CM) : DEFAULT_SEAT_SPACING_CM;
}

/**
 * 좌석 겹침: 두 좌석 중심 사이 거리가 두 좌석 구역의 좌석 간격 가운데 작은 쪽의 절반보다 가까우면 두 좌석 모두.
 * 같으면 경고가 아니다. 같은 좌표는 묶어 한 번에 세고, 격자로 이웃만 견주어 5만 석에서도 한 번 훑는다.
 * 비교 상한을 넘는 비정상 배치는 경고를 넓게 잡는다(경고는 저장을 막지 않는다)
 */
export function overlapWarnings(sections: readonly CheckSection[]): SeatMapWarning[] {
  const items = sections.flatMap((s) => seatsOf(s).map((seat) => ({ seat, spacing: seatSpacingOf(s) })));
  if (items.length < 2) return [];
  const hit = new Set<string>();
  // 같은 좌표의 좌석은 서로 반드시 겹친다. 대표 하나만 격자에 넣고, 대표가 겹치면 묶음 전체를 넣는다
  const groups = new Map<string, number[]>();
  items.forEach((x, i) => {
    const k = `${x.seat.x},${x.seat.y}`;
    const list = groups.get(k);
    if (list) list.push(i);
    else groups.set(k, [i]);
  });
  const members = new Map<number, number[]>();
  for (const g of groups.values()) {
    members.set(g[0]!, g);
    if (g.length > 1) for (const i of g) hit.add(items[i]!.seat.seatId);
  }
  const cell = Math.max(...items.map((x) => x.spacing), DEFAULT_SEAT_SPACING_CM);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const i of members.keys()) {
    const k = key(items[i]!.seat.x, items[i]!.seat.y);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const addGroup = (i: number) => {
    for (const k of members.get(i) ?? []) hit.add(items[k]!.seat.seatId);
  };
  let comparisons = 0;
  outer: for (const i of members.keys()) {
    const a = items[i]!;
    const cx = Math.floor(a.seat.x / cell);
    const cy = Math.floor(a.seat.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue;
          if (++comparisons > MAX_OVERLAP_COMPARISONS) {
            // 촘촘한 비정상 배치: 남은 좌석을 모두 겹침으로 넓게 잡고 멈춘다
            for (const x of items) hit.add(x.seat.seatId);
            break outer;
          }
          const b = items[j]!;
          const limit = Math.min(a.spacing, b.spacing) / 2;
          if (Math.hypot(a.seat.x - b.seat.x, a.seat.y - b.seat.y) < limit) {
            addGroup(i);
            addGroup(j);
          }
        }
      }
    }
  }
  return hit.size > 0 ? [{ code: 'SEAT_OVERLAP', seatIds: seatIds([...hit]), seatCount: hit.size }] : [];
}

/** 점이 다각형 안인가(변 위는 안으로 본다). 광선 교차 + 변 위 검사 */
export function pointInside(points: readonly (readonly [number, number])[], x: number, y: number): boolean {
  if (points.length < 3) return false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[j]!;
    if (onSegment(x1, y1, x2, y2, x, y)) return true;
  }
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onSegment(x1: number, y1: number, x2: number, y2: number, x: number, y: number): boolean {
  const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  if (Math.abs(cross) > 1e-9) return false;
  return x >= Math.min(x1, x2) - 1e-9 && x <= Math.max(x1, x2) + 1e-9 && y >= Math.min(y1, y2) - 1e-9 && y <= Math.max(y1, y2) + 1e-9;
}

/** 구역 다각형 밖 좌석. 변 위·안은 경고가 아니다 */
export function outsideWarnings(sections: readonly CheckSection[]): SeatMapWarning[] {
  const ids: string[] = [];
  for (const s of sections) {
    for (const seat of seatsOf(s)) if (!pointInside(s.shape.points, seat.x, seat.y)) ids.push(seat.seatId);
  }
  return ids.length > 0 ? [{ code: 'SEAT_OUTSIDE_SHAPE', seatIds: seatIds(ids), seatCount: ids.length }] : [];
}

/** 업무 경고 전체. 차례는 W1·W2·W3·겹침·도형 밖 */
export function checkSeatmap(layout: CheckLayout): SeatMapWarning[] {
  return [...wheelchairWarnings(layout.sections), ...overlapWarnings(layout.sections), ...outsideWarnings(layout.sections)];
}
