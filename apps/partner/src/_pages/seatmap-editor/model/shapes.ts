// 좌석맵 에디터 도형 수학(ADR-0264 결정 3·7·12, d5 §6.5 ① 배치 그리기). 순수 함수만 둔다(Konva 없이 node로 시험한다).
// 저장 값은 늘 캔버스 안의 정수 꼭짓점 목록이다. 손잡이로 바꾼 값과 속성 패널에 숫자로 넣은 값은 같은 함수(rectPoints·arcPoints)를 지나 같은 꼭짓점이 된다.
// 사각형의 회전은 네 꼭짓점에서 다시 구한다(칸을 두지 않는다). 부채꼴·곡선 띠는 arc 매개변수에서 꼭짓점을 만든다.
import type { Arc, Pt, Shape } from './types.ts';

/** 격자 맞춤 간격(cm, 1m [가정], ADR-0264 결정 3) */
export const GRID_CM = 100;
/** 안내선 맞춤 거리(화면 px [가정], ADR-0264 결정 3) */
export const GUIDE_SNAP_PX = 6;
/** 화살표 한 번 10cm, Shift+화살표 1m [가정](frontend §5.6) */
export const NUDGE_CM = 10;
export const NUDGE_BIG_CM = 100;
/** 부채꼴·곡선 띠를 다각형으로 바꿀 때 한 변이 맡는 각도(도) [가정](ADR-0264 결정 20) */
export const ARC_STEP_DEG = 5;
/** [복제]가 옮기는 거리(cm) [가정] */
export const DUPLICATE_OFFSET_CM = 100;
/** 도형 하나의 꼭짓점 상한(서버 SEATMAP_MAX_POINTS와 같다, docs/features/seat-hold.md §10) */
export const MAX_POINTS = 1_000;
/** 캔버스 한 변 상한(cm, openapi SeatMapColumns.canvas) */
export const CANVAS_MAX = 100_000;

const RAD = Math.PI / 180;

/** 사각형 매개변수: 첫 꼭짓점(x, y), 가로·세로, 첫 꼭짓점을 축으로 한 회전(도). Konva Rect·Transformer의 값과 같은 뜻이다 */
export interface RectParams {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export const round = (v: number) => Math.round(v);

/** 회전 값 정리: 소수 첫째 자리, -180 초과 180 이하 */
export function normRotation(deg: number): number {
  let d = Math.round(deg * 10) / 10;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return Object.is(d, -0) ? 0 : d;
}

/** 속성 패널이 보이는 값으로 정리(위치·크기는 정수 cm, 회전은 소수 첫째 자리). 손잡이 값도 이것을 지나 숫자 입력과 같아진다 */
export const normRect = (p: RectParams): RectParams => ({ x: round(p.x), y: round(p.y), w: Math.max(1, round(p.w)), h: Math.max(1, round(p.h)), rotation: normRotation(p.rotation) });

/** 사각형 매개변수 → 네 정수 꼭짓점(첫 꼭짓점부터 시계 방향). 매개변수는 normRect로 먼저 정리한다 */
export function rectPoints(raw: RectParams): Pt[] {
  const p = normRect(raw);
  const r = p.rotation * RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const at = (dx: number, dy: number): Pt => [round(p.x + dx * c - dy * s), round(p.y + dx * s + dy * c)];
  return [at(0, 0), at(p.w, 0), at(p.w, p.h), at(0, p.h)];
}

/** 네 꼭짓점 → 사각형 매개변수(가로·세로는 정수, 회전은 소수 첫째 자리) */
export function rectParams(points: readonly Pt[]): RectParams {
  const [p0, p1, , p3] = points as [Pt, Pt, Pt, Pt];
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  return { x: p0[0], y: p0[1], w: round(w), h: round(h), rotation: normRotation(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) / RAD) };
}

/** 사각형으로 다시 읽을 수 있는 네 꼭짓점인가(다각형으로 바꾼 뒤에는 RECT 손잡이를 쓰지 않는다) */
export function isRectLike(points: readonly Pt[]): boolean {
  if (points.length !== 4) return false;
  const p = rectPoints(rectParams(points));
  return p.every(([x, y], i) => Math.abs(x - points[i]![0]) <= 1 && Math.abs(y - points[i]![1]) <= 1);
}

/**
 * arc 매개변수의 관계 검사(서버 422 SHAPE_PARAMS_INVALID와 같은 규칙, ADR-0264 결정 12). 맞으면 null.
 * 중심은 계약 범위(0~100,000)이고 캔버스를 주면 캔버스 안이어야 한다(ADR-0264 결정 36)
 */
export function arcProblem(a: Arc, c?: { width: number; height: number }): string | null {
  const ints = [a.cx, a.cy, a.innerRadius, a.outerRadius, a.startAngle, a.endAngle].every(Number.isInteger);
  if (!ints) return '정수로 넣어 주세요';
  const w = c?.width ?? CANVAS_MAX;
  const h = c?.height ?? CANVAS_MAX;
  if (a.cx < 0 || a.cy < 0 || a.cx > w || a.cy > h) return '중심은 캔버스 안이어야 합니다';
  if (a.innerRadius < 0 || a.outerRadius < 1) return '반지름이 범위를 벗어났습니다';
  if (a.innerRadius >= a.outerRadius) return '안쪽 반지름은 바깥 반지름보다 작아야 합니다';
  if (a.endAngle <= a.startAngle) return '끝각은 시작각보다 커야 합니다';
  if (a.endAngle - a.startAngle > 360) return '각도 범위는 360도까지입니다';
  if (a.startAngle < -360 || a.startAngle > 360 || a.endAngle < -360 || a.endAngle > 720) return '각도가 범위를 벗어났습니다';
  return null;
}

/**
 * arc → 다각형 꼭짓점(정수). 바깥 호를 시작각부터 끝각까지 ARC_STEP_DEG마다 잇고, 곡선 띠는 안쪽 호를 거꾸로, 부채꼴(안쪽 0)은 중심 한 점으로 닫는다.
 * 반올림으로 같은 점이 이어지면 하나만 둔다
 */
export function arcPoints(a: Arc): Pt[] {
  const span = a.endAngle - a.startAngle;
  const n = Math.max(1, Math.ceil(span / ARC_STEP_DEG));
  const ring = (r: number, reverse: boolean): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const k = reverse ? n - i : i;
      const t = (a.startAngle + (span * k) / n) * RAD;
      out.push([round(a.cx + r * Math.cos(t)), round(a.cy + r * Math.sin(t))]);
    }
    return out;
  };
  const pts = [...ring(a.outerRadius, false), ...(a.innerRadius > 0 ? ring(a.innerRadius, true) : [[round(a.cx), round(a.cy)] as Pt])];
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  return out;
}

/** 꼭짓점이 모두 캔버스 안(0 이상, 폭·높이 이하)인가 */
export const pointsInside = (pts: readonly Pt[], c: { width: number; height: number }) => pts.every(([x, y]) => x >= 0 && y >= 0 && x <= c.width && y <= c.height);

export function bbox(pts: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 도형 전체를 캔버스 안으로 옮긴다(꼴은 그대로). 캔버스보다 큰 도형은 넘는 꼭짓점만 가장자리로 붙인다.
 * 손잡이·숫자 입력·옮기기가 모두 이것을 지나 '꼭짓점은 캔버스 안 정수'를 지킨다(FE-T46 ②)
 */
export function fitInside(pts: readonly Pt[], c: { width: number; height: number }): Pt[] {
  const b = bbox(pts);
  const dx = b.minX < 0 ? -b.minX : b.maxX > c.width ? c.width - b.maxX : 0;
  const dy = b.minY < 0 ? -b.minY : b.maxY > c.height ? c.height - b.maxY : 0;
  return pts.map(([x, y]) => [Math.min(c.width, Math.max(0, round(x + dx))), Math.min(c.height, Math.max(0, round(y + dy)))] as Pt);
}

/** 꼭짓점 상자와 (있으면) arc 중심이 모두 캔버스 안에 머무는 옮김 범위 */
function moveRange(s: Shape, c: { width: number; height: number }): { x: [number, number]; y: [number, number] } {
  const b = bbox(s.points);
  const x: [number, number] = [-b.minX, c.width - b.maxX];
  const y: [number, number] = [-b.minY, c.height - b.maxY];
  if (s.arc) {
    x[0] = Math.max(x[0], -s.arc.cx);
    x[1] = Math.min(x[1], c.width - s.arc.cx);
    y[0] = Math.max(y[0], -s.arc.cy);
    y[1] = Math.min(y[1], c.height - s.arc.cy);
  }
  return { x, y };
}

/** 범위 안에서 0에 가장 가까운 값(범위가 비면 0) */
const nearestIn = (v: number, [lo, hi]: [number, number]) => (lo > hi ? 0 : Math.min(Math.max(v, lo), hi));

/** 도형을 옮긴다(arc도 함께). 꼭짓점이나 arc 중심이 캔버스 밖으로 나가는 만큼 덜 옮긴다(ADR-0264 결정 36) */
export function moveShape(s: Shape, dx: number, dy: number, c: { width: number; height: number }): Shape {
  const r = moveRange(s, c);
  const mx = nearestIn(dx, r.x);
  const my = nearestIn(dy, r.y);
  const points = s.points.map(([x, y]) => [round(x + mx), round(y + my)] as Pt);
  return { ...s, points, ...(s.arc ? { arc: { ...s.arc, cx: round(s.arc.cx + mx), cy: round(s.arc.cy + my) } } : {}) };
}

/** 사각형 매개변수로 도형을 고친다 */
export const withRect = (s: Shape, p: RectParams, c: { width: number; height: number }): Shape => ({ ...s, kind: 'RECT', points: fitInside(rectPoints(p), c) });

/** 꼭짓점과 arc 중심을 함께 캔버스 안으로 옮긴다(같은 만큼). 옮긴 양도 돌려준다. 다 들지 않으면 꼭짓점·중심을 가장자리로 자른다 */
export function placeInside(s: Shape, c: { width: number; height: number }): { shape: Shape; dx: number; dy: number } {
  const r = moveRange(s, c);
  const dx = nearestIn(0, r.x);
  const dy = nearestIn(0, r.y);
  const clampX = (v: number) => Math.min(c.width, Math.max(0, round(v)));
  const clampY = (v: number) => Math.min(c.height, Math.max(0, round(v)));
  const points = s.points.map(([x, y]) => [clampX(x + dx), clampY(y + dy)] as Pt);
  return { shape: { ...s, points, ...(s.arc ? { arc: { ...s.arc, cx: clampX(s.arc.cx + dx), cy: clampY(s.arc.cy + dy) } } : {}) }, dx, dy };
}

/** arc로 도형을 고친다(관계가 틀리면 그대로). 꼭짓점과 중심은 캔버스 안으로 함께 옮긴다 */
export function withArc(s: Shape, a: Arc, c: { width: number; height: number }): Shape {
  if (arcProblem(a)) return s;
  return placeInside({ ...s, points: arcPoints(a), arc: a }, c).shape;
}

/** 다각형 도구로 찍은 점 → 캔버스 안 정수 꼭짓점(밖 점은 가장자리로 자르고, 잘라서 같아진 이웃 점은 하나만, ADR-0264 결정 36) */
export function polygonFromClicks(pts: readonly Pt[], c: { width: number; height: number }): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of pts) {
    const p: Pt = [Math.min(c.width, Math.max(0, round(x))), Math.min(c.height, Math.max(0, round(y)))];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  return out;
}

/** 다각형 꼭짓점 하나를 옮긴다 */
export function moveVertex(s: Shape, i: number, x: number, y: number, c: { width: number; height: number }): Shape {
  const points = s.points.map((p, k) => (k === i ? ([Math.min(c.width, Math.max(0, round(x))), Math.min(c.height, Math.max(0, round(y)))] as Pt) : p));
  const { arc: _drop, ...rest } = s;
  return { ...rest, kind: 'POLYGON', points };
}

/** 변 i(꼭짓점 i와 i+1 사이) 가운데에 꼭짓점을 넣는다('＋ 꼭짓점 더하기'). 상한을 넘으면 그대로 */
export function insertVertex(s: Shape, i: number): Shape {
  if (s.points.length >= MAX_POINTS) return s;
  const a = s.points[i]!;
  const b = s.points[(i + 1) % s.points.length]!;
  const mid: Pt = [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)];
  const points = [...s.points.slice(0, i + 1), mid, ...s.points.slice(i + 1)];
  const { arc: _drop, ...rest } = s;
  return { ...rest, kind: 'POLYGON', points };
}

/** 꼭짓점 하나를 지운다(셋보다 적어지면 그대로) */
export function removeVertex(s: Shape, i: number): Shape {
  if (s.points.length <= 3) return s;
  const { arc: _drop, ...rest } = s;
  return { ...rest, kind: 'POLYGON', points: s.points.filter((_, k) => k !== i) };
}

/** 다각형 넓이 무게중심(넓이가 0이면 꼭짓점 평균) */
export function centroid(pts: readonly Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** 무대 도형들의 무게중심(넓이 가중). 무대가 없으면 캔버스 위 변 가운데(ADR-0264 결정 6) */
export function stageCenter(stage: readonly Shape[], c: { width: number; height: number }): Pt {
  if (stage.length === 0) return [c.width / 2, 0];
  let wx = 0;
  let wy = 0;
  let w = 0;
  for (const s of stage) {
    const area = Math.abs(polygonArea(s.points)) || 1;
    const [x, y] = centroid(s.points);
    wx += x * area;
    wy += y * area;
    w += area;
  }
  return [wx / w, wy / w];
}

export function polygonArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** 점이 다각형 안인가(짝홀 규칙. 변 위는 안으로 본다) */
export function pointInPolygon(pts: readonly Pt[], x: number, y: number): boolean {
  if (distanceToEdges(pts, x, y) === 0) return true;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 점에서 다각형 변까지 가장 가까운 거리 */
export function distanceToEdges(pts: readonly Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** 좌우 대칭 축(x): 무대가 있으면 무대 무게중심의 세로선, 없으면 캔버스 가운데 [가정](ADR-0264 결정 20) */
export function mirrorAxis(stage: readonly Shape[], c: { width: number; height: number }): number {
  return stage.length === 0 ? c.width / 2 : round(stageCenter(stage, c)[0]);
}

/** 세로선 x = axis에 대한 거울 꼴. 꼭짓점 차례를 거꾸로 해 돌림 방향을 지킨다. arc는 각도를 180 − θ로 바꾼다 */
export function mirrorShape(s: Shape, axis: number, c: { width: number; height: number }): Shape {
  return mirrorTransform(s, axis, c).shape;
}

/**
 * 좌우 대칭의 도형과 좌석 변환: 거울 꼴(x → 2·axis − x, 꼭짓점 차례는 거꾸로, arc는 각도 180 − θ)을 캔버스 안으로 옮긴 도형과 그 옮긴 양.
 * 좌석은 x → 2·axis − x + dx, y → y + dy로 따라간다(ADR-0264 결정 36)
 */
export function mirrorTransform(s: Shape, axis: number, c: { width: number; height: number }): { shape: Shape; dx: number; dy: number } {
  if (!s.arc) return placeInside({ ...s, points: [...s.points].reverse().map(([x, y]) => [round(2 * axis - x), y] as Pt) }, c);
  let start = 180 - s.arc.endAngle;
  let end = 180 - s.arc.startAngle;
  // 시작각을 0 이상 360 미만으로 옮겨 계약 범위(시작 -360~360, 끝 -360~720) 안에 둔다
  while (start < 0) {
    start += 360;
    end += 360;
  }
  while (start >= 360) {
    start -= 360;
    end -= 360;
  }
  const arc: Arc = { ...s.arc, cx: round(2 * axis - s.arc.cx), startAngle: start, endAngle: end };
  return placeInside({ ...s, points: arcPoints(arc), arc }, c);
}

/** 격자 맞춤(GRID_CM 배수로 반올림) */
export const snapGrid = (v: number, grid = GRID_CM) => Math.round(v / grid) * grid;

/** 맞춤 후보 선(다른 도형의 변·가운데선) */
export interface GuideLines {
  xs: number[];
  ys: number[];
}

export function guideLines(others: readonly (readonly Pt[])[]): GuideLines {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pts of others) {
    const b = bbox(pts);
    xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX);
    ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY);
  }
  return { xs, ys };
}

/**
 * 끄는 도형의 상자를 안내선에 맞춘다: 상자의 왼·가운데·오른 변(위·가운데·아래)과 가장 가까운 안내선이 threshold(세계 단위 = 화면 px ÷ 배율) 안이면
 * 그만큼 옮긴다. 맞은 선을 돌려준다(점선으로 그린다). 안내선이 없으면 격자(grid가 참일 때)로 상자 왼·위 변을 맞춘다
 */
export function snapBox(box: { minX: number; minY: number; maxX: number; maxY: number }, lines: GuideLines, threshold: number, grid: boolean): { dx: number; dy: number; guideX?: number; guideY?: number } {
  const pick = (edges: number[], cands: number[]) => {
    let best: { d: number; at: number } | undefined;
    for (const e of edges) for (const c of cands) if (Math.abs(c - e) <= threshold && (!best || Math.abs(c - e) < Math.abs(best.d))) best = { d: c - e, at: c };
    return best;
  };
  const bx = pick([box.minX, (box.minX + box.maxX) / 2, box.maxX], lines.xs);
  const by = pick([box.minY, (box.minY + box.maxY) / 2, box.maxY], lines.ys);
  const dx = bx ? bx.d : grid ? snapGrid(box.minX) - box.minX : 0;
  const dy = by ? by.d : grid ? snapGrid(box.minY) - box.minY : 0;
  return { dx, dy, ...(bx ? { guideX: bx.at } : {}), ...(by ? { guideY: by.at } : {}) };
}

/** 치수 글자 '가로 24.0m · 세로 12.0m'(d5 §6.5) */
export function dimensionText(pts: readonly Pt[], kind: Shape['kind']): string {
  if (kind === 'RECT' && pts.length === 4) {
    const r = rectParams(pts);
    return `가로 ${(r.w / 100).toFixed(1)}m · 세로 ${(r.h / 100).toFixed(1)}m`;
  }
  const b = bbox(pts);
  return `가로 ${((b.maxX - b.minX) / 100).toFixed(1)}m · 세로 ${((b.maxY - b.minY) / 100).toFixed(1)}m`;
}

/** 새 사각형(누른 점에서 끈 상자, 격자 맞춤) */
export function rectFromDrag(x0: number, y0: number, x1: number, y1: number, grid: boolean): RectParams {
  const s = (v: number) => (grid ? snapGrid(v) : round(v));
  const ax = s(Math.min(x0, x1));
  const ay = s(Math.min(y0, y1));
  const bx = s(Math.max(x0, x1));
  const by = s(Math.max(y0, y1));
  return { x: ax, y: ay, w: Math.max(GRID_CM, bx - ax), h: Math.max(GRID_CM, by - ay), rotation: 0 };
}

/** 새 부채꼴·곡선 띠의 기본 arc(누른 점이 중심, 무대 쪽을 향한 90도) [가정] */
export function defaultArc(kind: 'SECTOR' | 'ARC_BAND', cx: number, cy: number): Arc {
  return { cx: round(cx), cy: round(cy), innerRadius: kind === 'SECTOR' ? 0 : 1000, outerRadius: kind === 'SECTOR' ? 1500 : 2000, startAngle: 45, endAngle: 135 };
}

/** 손잡이 자리(곡선 띠·부채꼴): 바깥·안쪽 반지름 손잡이는 가운데 각, 각도 손잡이는 바깥 반지름 위 */
export function arcHandles(a: Arc): { outer: Pt; inner: Pt; start: Pt; end: Pt } {
  const mid = ((a.startAngle + a.endAngle) / 2) * RAD;
  const at = (r: number, t: number): Pt => [a.cx + r * Math.cos(t), a.cy + r * Math.sin(t)];
  return { outer: at(a.outerRadius, mid), inner: at(a.innerRadius, mid), start: at(a.outerRadius, a.startAngle * RAD), end: at(a.outerRadius, a.endAngle * RAD) };
}

/** 손잡이를 끈 점 → 바뀐 arc(반지름·각도는 정수로) */
export function dragArcHandle(a: Arc, handle: 'outer' | 'inner' | 'start' | 'end', x: number, y: number): Arc {
  const r = round(Math.hypot(x - a.cx, y - a.cy));
  let deg = round(Math.atan2(y - a.cy, x - a.cx) / RAD);
  if (handle === 'outer') return { ...a, outerRadius: Math.max(a.innerRadius + 1, r) };
  if (handle === 'inner') return { ...a, innerRadius: Math.min(a.outerRadius - 1, Math.max(0, r)) };
  // 각도는 지금 값 가까이로 옮겨 이어지게 한다(-180~180으로 끊기지 않게)
  const near = handle === 'start' ? a.startAngle : a.endAngle;
  while (deg - near > 180) deg -= 360;
  while (near - deg > 180) deg += 360;
  if (handle === 'start') return { ...a, startAngle: Math.max(a.endAngle - 360, Math.min(a.endAngle - 1, deg)) };
  return { ...a, endAngle: Math.min(a.startAngle + 360, Math.max(a.startAngle + 1, deg)) };
}
