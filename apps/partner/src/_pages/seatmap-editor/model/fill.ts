// ② 좌석 채우기 계산(CMP-077 SeatFillRule, ADR-0264 결정 6·21). 순수 함수이고 에디터 Worker가 부른다(시험은 Worker 없이 node로 한다).
// - 무대 쪽: 구역 무게중심 → 무대 무게중심(무대가 없으면 캔버스 위 변 가운데) 방향 d. 오른쪽(무대를 보고) r = (−d.y, d.x).
// - 행: 직선은 d에 수직인 선, 곡선은 무대 무게중심이 중심인 호. 첫 행은 도형에서 무대에 가장 가까운 점에서 행 간격의 절반 안쪽, 그 뒤 행 간격마다.
// - 좌석: 행 위에 좌석 간격마다, 좌석 중심이 도형 안이고 도형 변에서 좌석 간격의 절반 이상 떨어진 자리만. 세로 통로는 행마다 도형이 덮는 길이를
//   (통로 수 + 1)묶음으로 고르게 나누고 묶음 사이에 통로 폭을 비운다.
// - 수: COUNT는 앞 행부터 채워 목표에 닿으면 멈춘다(마지막 행은 그 행 가운데에 가까운 자리부터). GRID는 앞 행부터 행 수만큼, 행마다 가운데를 기준으로.
// - 이름: 행은 무대에서 가까운 행부터 1·2·3 또는 A·B·…·Z·AA. 번호는 행마다 첫 번호부터, 무대를 보고 왼쪽(LEFT)·오른쪽(RIGHT)에서 세고 통로를 건너 이어 센다.
import { centroid, distanceToEdges, pointInPolygon, stageCenter } from './shapes.ts';
import type { FillRule, Pt, Shape } from './types.ts';

/** 채우기 기본값 [가정](d5 §6.5, openapi SeatFillRule) */
export const FILL_DEFAULTS = {
  seatSpacingCm: 50,
  rowSpacingCm: 90,
  aisles: 2,
  aisleWidthCm: 120,
  rowShape: 'STRAIGHT',
  rowLabel: 'NUMBER',
  firstNumber: 1,
  numberFrom: 'LEFT',
} as const;

/** 좌석 수 상한(서버 SEATMAP_MAX_SEATS, docs/features/seat-hold.md §10) */
export const MAX_SEATS = 50_000;

export type FullRule = Required<Omit<FillRule, 'targetCount' | 'rows' | 'seatsPerRow'>> & Pick<FillRule, 'targetCount' | 'rows' | 'seatsPerRow'>;

/** 빈 칸(undefined)은 기본값으로 */
export const fullRule = (r: FillRule): FullRule => ({ ...FILL_DEFAULTS, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) }) as FullRule;

export interface FilledSeat {
  row: string;
  number: number;
  x: number;
  y: number;
}

export interface FillResult {
  seats: FilledSeat[];
  /** 목표 좌석 수(COUNT targetCount, GRID 행 × 좌석) */
  target: number;
  /** 도형이 받는 수(COUNT: 모든 행의 자리 수, GRID: 도형 안에 남은 자리 수) */
  capacity: number;
}

/** 무대 쪽 좌표계 */
export interface Frame {
  /** 무대 무게중심 */
  S: Pt;
  /** 무대 쪽 단위 방향 */
  d: Pt;
  /** 무대를 보고 오른쪽 단위 방향 */
  r: Pt;
  /** 무대 → 구역 무게중심 각(라디안) */
  base: number;
}

export function frameOf(shape: readonly Pt[], stage: readonly Shape[], canvas: { width: number; height: number }): Frame {
  const S = stageCenter(stage, canvas);
  const C = centroid(shape);
  const vx = S[0] - C[0];
  const vy = S[1] - C[1];
  const len = Math.hypot(vx, vy);
  const d: Pt = len < 1e-9 ? [0, -1] : [vx / len, vy / len];
  return { S, d, r: [-d[1], d[0]], base: Math.atan2(-vy, -vx) };
}

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** (−π, π]로 감는다 */
function wrap(a: number): number {
  let v = a;
  while (v <= -Math.PI) v += 2 * Math.PI;
  while (v > Math.PI) v -= 2 * Math.PI;
  return v;
}

/** 좌석 하나의 '오른쪽 좌표'(같은 행 안의 차례. 직선은 r 투영, 곡선은 무대 둘레 각을 오른쪽으로) */
export function sideOf(f: Frame, shape: 'STRAIGHT' | 'CURVED', x: number, y: number): number {
  if (shape === 'STRAIGHT') return dot([x, y], f.r);
  return -wrap(Math.atan2(y - f.S[1], x - f.S[0]) - f.base);
}

/** 기울어진 직선 행·곡선 행에서 좌표를 정수로 반올림해도 중심 사이가 좌석 간격 이상이게 더하는 여유(cm) [가정](ADR-0264 결정 21) */
export const ROUND_MARGIN_CM = 1.5;

interface Row {
  /** 행 위 좌석 사이(오른쪽 좌표 단위) */
  step: number;
  /** 행 위의 자리(오른쪽 좌표) → 세계 좌표 */
  at: (s: number) => Pt;
  /** 도형이 덮는 구간(오른쪽 좌표, 차례대로) */
  spans: [number, number][];
}

/** 직선 행: 무대 쪽 좌표 t = p·d인 선 */
function straightRow(pts: readonly Pt[], f: Frame, t: number, spacing: number): Row {
  // 축에 맞은 행은 좌표가 정수라 여유가 없어도 된다
  const step = Math.abs(f.d[0]) < 1e-12 || Math.abs(f.d[1]) < 1e-12 ? spacing : spacing + ROUND_MARGIN_CM;
  const cuts: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const da = dot(a, f.d) - t;
    const db = dot(b, f.d) - t;
    if (da > 0 !== db > 0) {
      const u = da / (da - db);
      cuts.push(dot([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], f.r));
    }
  }
  cuts.sort((x, y) => x - y);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i += 2) spans.push([cuts[i]!, cuts[i + 1]!]);
  return { at: (s) => [f.d[0] * t + f.r[0] * s, f.d[1] * t + f.r[1] * s], spans, step };
}

/** 곡선 행: 무대 무게중심이 중심이고 반지름 R인 원. 오른쪽 좌표는 호 길이(구역 무게중심 쪽이 0) */
function curvedRow(pts: readonly Pt[], f: Frame, R: number, spacing: number): Row {
  // 호 길이가 아니라 현(두 좌석 중심 사이 직선)이 좌석 간격 + 여유가 되게 한다
  const chord = spacing + ROUND_MARGIN_CM;
  const step = chord >= 2 * R ? Infinity : 2 * R * Math.asin(chord / (2 * R));
  const [sx, sy] = f.S;
  const angles: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const fx = a[0] - sx;
    const fy = a[1] - sy;
    const A = dx * dx + dy * dy;
    if (A === 0) continue;
    const B = 2 * (fx * dx + fy * dy);
    const Cc = fx * fx + fy * fy - R * R;
    const disc = B * B - 4 * A * Cc;
    if (disc < 0) continue;
    const q = Math.sqrt(disc);
    for (const u of [(-B - q) / (2 * A), (-B + q) / (2 * A)]) {
      if (u >= 0 && u < 1) angles.push(wrap(Math.atan2(fy + dy * u, fx + dx * u) - f.base));
    }
  }
  angles.sort((x, y) => x - y);
  const at = (s: number): Pt => {
    const t = f.base - s / R;
    return [sx + R * Math.cos(t), sy + R * Math.sin(t)];
  };
  // 끊는 자리(구역 반대쪽, 각 ±π)가 도형 안이면 −π부터 안이다
  const behind = at(-Math.PI * R);
  let inside = pointInPolygon(pts, behind[0], behind[1]);
  const edges = [-Math.PI, ...angles, Math.PI];
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (inside) spans.push([-edges[i + 1]! * R, -edges[i]! * R]);
    if (i < angles.length) inside = !inside;
  }
  spans.sort((x, y) => x[0] - y[0]);
  return { at, spans, step };
}

/** 무대에서 가까운 차례의 행들 */
function* rowsOf(pts: readonly Pt[], f: Frame, rule: FullRule): Generator<Row> {
  const half = rule.rowSpacingCm / 2;
  if (rule.rowShape === 'CURVED') {
    const [sx, sy] = f.S;
    const rMin = pointInPolygon(pts, sx, sy) ? 0 : distanceToEdges(pts, sx, sy);
    const rMax = Math.max(...pts.map(([x, y]) => Math.hypot(x - sx, y - sy)));
    for (let R = rMin + half; R < rMax; R += rule.rowSpacingCm) yield curvedRow(pts, f, R, rule.seatSpacingCm);
    return;
  }
  const proj = pts.map((p) => dot(p, f.d));
  const near = Math.max(...proj);
  const far = Math.min(...proj);
  for (let t = near - half; t > far; t -= rule.rowSpacingCm) yield straightRow(pts, f, t, rule.seatSpacingCm);
}

/** 자리가 쓸 수 있는가: 중심이 도형 안이고 변에서 좌석 간격의 절반 이상 */
const usable = (pts: readonly Pt[], p: Pt, spacing: number) => pointInPolygon(pts, p[0], p[1]) && distanceToEdges(pts, p[0], p[1]) >= spacing / 2 - 1e-9;

/** COUNT: 행이 덮는 길이를 (통로 + 1)묶음으로 나눈 자리 */
function blockSeats(row: Row, rule: FullRule): number[] {
  if (row.spans.length === 0) return [];
  const lo = row.spans[0]![0];
  const hi = row.spans.at(-1)![1];
  const blocks = rule.aisles + 1;
  const len = (hi - lo - rule.aisles * rule.aisleWidthCm) / blocks;
  if (!(len >= row.step)) return [];
  const out: number[] = [];
  for (let j = 0; j < blocks; j++) {
    const start = lo + j * (len + rule.aisleWidthCm);
    const n = Math.floor(len / row.step + 1e-9);
    const pad = (len - n * row.step) / 2;
    for (let i = 0; i < n; i++) out.push(start + pad + row.step / 2 + i * row.step);
  }
  return out;
}

/** GRID: 행 가운데를 기준으로 좌석 수만큼(통로로 고르게 나눈 묶음) */
function gridSeats(row: Row, rule: FullRule, perRow: number): number[] {
  if (row.spans.length === 0) return [];
  const mid = (row.spans[0]![0] + row.spans.at(-1)![1]) / 2;
  const groups = rule.aisles + 1;
  const base = Math.floor(perRow / groups);
  const extra = perRow % groups;
  const sizes = Array.from({ length: groups }, (_, g) => base + (g < extra ? 1 : 0));
  if (!Number.isFinite(row.step)) return [];
  const width = perRow * row.step + rule.aisles * rule.aisleWidthCm;
  let cursor = mid - width / 2;
  const out: number[] = [];
  for (const n of sizes) {
    for (let i = 0; i < n; i++) out.push(cursor + row.step / 2 + i * row.step);
    cursor += n * row.step + rule.aisleWidthCm;
  }
  return out;
}

/** 행 이름: 숫자는 1·2·3, 알파벳은 A…Z, AA, AB… */
export function rowName(i: number, label: 'NUMBER' | 'ALPHA'): string {
  if (label === 'NUMBER') return String(i + 1);
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 채우기 규칙의 입력 오류(칸 → 문구). 비었으면 채울 수 있다 */
export function fillRuleErrors(r: FillRule): Record<string, string> {
  const e: Record<string, string> = {};
  const f = fullRule(r);
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  if (f.method === 'COUNT') {
    if (!int(f.targetCount) || f.targetCount! < 1 || f.targetCount! > MAX_SEATS) e.targetCount = `좌석 수는 1~${MAX_SEATS.toLocaleString('ko-KR')}석입니다`;
  } else {
    if (!int(f.rows) || f.rows! < 1) e.rows = '행 수는 1 이상입니다';
    if (!int(f.seatsPerRow) || f.seatsPerRow! < 1) e.seatsPerRow = '행마다 좌석 수는 1 이상입니다';
    if (!e.rows && !e.seatsPerRow && f.rows! * f.seatsPerRow! > MAX_SEATS) e.seatsPerRow = `좌석은 모두 ${MAX_SEATS.toLocaleString('ko-KR')}석까지입니다`;
  }
  if (!int(f.seatSpacingCm) || f.seatSpacingCm < 1) e.seatSpacingCm = '좌석 간격은 1cm 이상입니다';
  if (!int(f.rowSpacingCm) || f.rowSpacingCm < 1) e.rowSpacingCm = '행 간격은 1cm 이상입니다';
  else if (!e.seatSpacingCm && f.rowSpacingCm < f.seatSpacingCm) e.rowSpacingCm = '행 간격은 좌석 간격 이상이어야 합니다';
  if (!int(f.aisles) || f.aisles < 0 || f.aisles > 20) e.aisles = '세로 통로는 0~20개입니다';
  if (!int(f.aisleWidthCm) || f.aisleWidthCm < 1) e.aisleWidthCm = '통로 폭은 1cm 이상입니다';
  if (!int(f.firstNumber) || f.firstNumber < 1) e.firstNumber = '첫 번호는 1 이상입니다';
  return e;
}

/** 구역 하나를 채운다(규칙이 틀리면 빈 결과) */
export function fillSection(shape: readonly Pt[], rule: FillRule, stage: readonly Shape[], canvas: { width: number; height: number }): FillResult {
  const f = fullRule(rule);
  if (Object.keys(fillRuleErrors(rule)).length > 0) return { seats: [], target: 0, capacity: 0 };
  const frame = frameOf(shape, stage, canvas);
  const target = f.method === 'COUNT' ? f.targetCount! : f.rows! * f.seatsPerRow!;
  const rows: Pt[][] = [];
  let capacity = 0;
  let k = 0;
  for (const row of rowsOf(shape, frame, f)) {
    if (f.method === 'GRID' && k >= f.rows!) break;
    k++;
    const cands = (f.method === 'GRID' ? gridSeats(row, f, f.seatsPerRow!) : blockSeats(row, f)).map((s) => ({ s, p: row.at(s) })).filter((c) => usable(shape, c.p, f.seatSpacingCm));
    capacity += cands.length;
    if (cands.length > 0) rows.push(cands.map((c) => c.p));
    // COUNT의 받는 수는 모든 행을 센다. 행이 끝없이 늘지 않게 받는 수가 상한을 넘으면 멈춘다
    if (capacity > MAX_SEATS * 2) break;
  }
  const out: FilledSeat[] = [];
  let left = target;
  let named = 0;
  rows.forEach((row) => {
    if (left <= 0) return;
    let take = row.map((p) => ({ p, s: sideOf(frame, f.rowShape, p[0], p[1]) }));
    if (take.length > left) {
      // 마지막 행은 그 행 가운데에 가까운 자리부터(같으면 왼쪽부터)
      const lo = Math.min(...take.map((t) => t.s));
      const hi = Math.max(...take.map((t) => t.s));
      const mid = (lo + hi) / 2;
      take = [...take].sort((a, b) => Math.abs(a.s - mid) - Math.abs(b.s - mid) || a.s - b.s).slice(0, left);
    }
    take.sort((a, b) => (f.numberFrom === 'LEFT' ? a.s - b.s : b.s - a.s));
    const name = rowName(named++, f.rowLabel);
    take.forEach((t, i) => out.push({ row: name, number: f.firstNumber + i, x: Math.round(t.p[0]), y: Math.round(t.p[1]) }));
    left -= take.length;
  });
  return { seats: out, target, capacity: f.method === 'COUNT' ? capacity : Math.min(capacity, target) };
}

/** 결과 줄(role="status", d5 §6.5 '채우기 결과 부족') */
export function fillResultText(r: FillResult): string {
  const n = r.seats.length.toLocaleString('ko-KR');
  if (r.seats.length < r.target) return `${n}석이 들어갑니다(목표보다 ${(r.target - r.seats.length).toLocaleString('ko-KR')}석 적습니다). 도형을 넓히거나 좌석 간격을 줄이세요.`;
  return `${n}석이 들어갑니다.`;
}
