// v0 좌석맵 화면 모델과 그리기(docs/features/seat-hold.md §14 동작 7, K5의 v0).
// 화면 파일의 순수 함수(public/v0-seatmap/seatmap-model.js)를 Node에서 바로 부른다. DOM과 캔버스 없이,
// 그리기는 호출을 적는 가짜 Canvas 2D 문맥(Ctx2D 모양)으로 본다.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GRADE_COLOR,
  GRADE_COLORS,
  HELD_COLOR,
  MAX_SCALE,
  MAX_SELECT,
  MIN_SCALE,
  SEAT_RADIUS,
  SOLD_COLOR,
  applyChanges,
  createSeatModel,
  drawSeatMap,
  fitView,
  panBy,
  pruneSelection,
  seatAt,
  toggleSelection,
  zoomAt,
  type Ctx2D,
  type Seat,
  type SeatModel,
  type SeatStatus,
  type View,
} from '../public/v0-seatmap/seatmap-model.js';

const seat = (id: string, x: number, y: number, status: SeatStatus = 'AVAILABLE', grade = 'R'): Seat => ({ id, section: 'A', row: '1', number: 1, x, y, grade, status });

/** 좌석 n개를 한 줄에 간격 10으로 */
const line = (n: number, status: SeatStatus = 'AVAILABLE'): Seat[] => Array.from({ length: n }, (_, i) => seat(`A-1-${i + 1}`, i * 10, 0, status));

const screenOf = (view: View, s: { x: number; y: number }): [number, number] => [s.x * view.scale + view.offsetX, s.y * view.scale + view.offsetY];

// ───────────────────────── 모델 ─────────────────────────

describe('createSeatModel·applyChanges', () => {
  test('K5_좌석목록으로모델을만들면_좌석배열과ID찾기표가같은좌석을가리키고_받은배열은그대로다', () => {
    const input = [seat('A-1-1', 0, 0), seat('A-1-2', 10, 0, 'HELD'), seat('A-1-3', 20, 0, 'SOLD')];
    const before = structuredClone(input);
    const ids = input.map((s) => s.id);
    const model = createSeatModel(input);
    expect(input).toEqual(before);
    // K5의 v0: 좌석 객체 배열 하나(TypedArray가 아니다, §14 동작 7)
    expect(Array.isArray(model.seats)).toBe(true);
    expect(model.seats.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(model.byId.size).toBe(3);
    for (const s of model.seats) expect(model.byId.get(s.id)).toBe(s);
    expect(model.byId.get('A-1-2')).toMatchObject({ id: 'A-1-2', status: 'HELD', x: 10, y: 0 });
    // 변경분을 반영해도 받은 배열(원소 수·순서)은 그대로다
    applyChanges(model, [{ seatId: 'A-1-1', status: 'HELD' }]);
    expect(input.map((s) => s.id)).toEqual(ids);
  });

  test('K5_변경분을반영하면_그좌석상태만바뀌고실제로바뀐좌석수를돌려준다', () => {
    const model = createSeatModel(line(4));
    expect(applyChanges(model, [
      { seatId: 'A-1-1', status: 'HELD' },
      { seatId: 'A-1-2', status: 'SOLD' },
    ])).toBe(2);
    expect(model.seats.map((s) => [s.id, s.status]).sort()).toEqual([
      ['A-1-1', 'HELD'],
      ['A-1-2', 'SOLD'],
      ['A-1-3', 'AVAILABLE'],
      ['A-1-4', 'AVAILABLE'],
    ]);
    // 홀드가 풀리면 다시 빈 좌석이다(해제·만료 변경분)
    expect(applyChanges(model, [{ seatId: 'A-1-1', status: 'AVAILABLE' }])).toBe(1);
    expect(model.byId.get('A-1-1')?.status).toBe('AVAILABLE');
    expect(applyChanges(model, [])).toBe(0);
  });

  test('K5_모르는좌석과모르는상태는건너뛰고_같은상태로의변경은바뀐수에세지않는다', () => {
    const model = createSeatModel(line(3));
    const n = applyChanges(model, [
      { seatId: 'Z-9-9', status: 'HELD' },
      { seatId: 'A-1-1', status: 'RESERVED' },
      { seatId: 'A-1-1', status: 'held' },
      { seatId: 'A-1-1', status: '' },
      { seatId: 'A-1-2', status: 'AVAILABLE' },
      { seatId: 'A-1-3', status: 'HELD' },
    ]);
    expect(n).toBe(1);
    expect(model.byId.get('A-1-1')?.status).toBe('AVAILABLE');
    expect(model.byId.get('A-1-2')?.status).toBe('AVAILABLE');
    expect(model.byId.get('A-1-3')?.status).toBe('HELD');
    expect(model.byId.has('Z-9-9')).toBe(false);
    expect(model.seats).toHaveLength(3);
  });
});

// ───────────────────────── 보기(맞춤·확대·이동) ─────────────────────────

describe('fitView·zoomAt·panBy', () => {
  /** 모든 좌석 중심이 [여백, 폭-여백]×[여백, 높이-여백] 안이다 */
  function expectInside(model: SeatModel, view: View, width: number, height: number, padding: number): void {
    const eps = 1e-6;
    for (const s of model.seats) {
      const [sx, sy] = screenOf(view, s);
      expect(sx, `${s.id} x`).toBeGreaterThanOrEqual(padding - eps);
      expect(sx, `${s.id} x`).toBeLessThanOrEqual(width - padding + eps);
      expect(sy, `${s.id} y`).toBeGreaterThanOrEqual(padding - eps);
      expect(sy, `${s.id} y`).toBeLessThanOrEqual(height - padding + eps);
    }
  }
  /** 좌석이 차지한 범위가 쓸 수 있는 폭이나 높이 가운데 한쪽을 거의 채운다(맞춤 보기) */
  function fillRatio(model: SeatModel, view: View, width: number, height: number, padding: number): number {
    const xs = model.seats.map((s) => s.x);
    const ys = model.seats.map((s) => s.y);
    const spanX = (Math.max(...xs) - Math.min(...xs)) * view.scale;
    const spanY = (Math.max(...ys) - Math.min(...ys)) * view.scale;
    return Math.max(spanX / (width - 2 * padding), spanY / (height - 2 * padding));
  }
  const grid = (x0: number, y0: number, nx: number, ny: number, step: number): Seat[] => {
    const out: Seat[] = [];
    for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) out.push(seat(`G-${j + 1}-${i + 1}`, x0 + i * step, y0 + j * step));
    return out;
  };

  test('K5_맞춤보기는모든좌석이여백20안에들어오고_넓은배치는폭을거의채운다', () => {
    const model = createSeatModel(grid(100, 50, 11, 4, 100)); // x 100~1100, y 50~350
    const view = fitView(model, 960, 560);
    expect(Number.isFinite(view.scale) && view.scale > 0).toBe(true);
    expectInside(model, view, 960, 560, 20);
    expect(fillRatio(model, view, 960, 560, 20)).toBeGreaterThanOrEqual(0.8);
  });

  test('K5_맞춤보기는길쭉한배치와음수좌표와정한여백에서도모든좌석이화면안이다', () => {
    const cases: [Seat[], number, number, number | undefined][] = [
      [grid(0, 0, 2, 41, 50), 960, 560, undefined], // 세로로 긴 배치(y 0~2000)
      [grid(-500, -300, 5, 6, 100), 960, 560, undefined], // 음수 좌표
      [grid(5000, 7000, 30, 20, 10), 400, 300, 50], // 원점에서 먼 배치와 여백 50
    ];
    for (const [seats, w, h, padding] of cases) {
      const model = createSeatModel(seats);
      const view = padding === undefined ? fitView(model, w, h) : fitView(model, w, h, padding);
      const p = padding ?? 20;
      expectInside(model, view, w, h, p);
      expect(fillRatio(model, view, w, h, p)).toBeGreaterThanOrEqual(0.8);
    }
  });

  test('K5_좌석이하나면그좌석이화면안이고_좌석이없으면배율1이동0이다', () => {
    const one = createSeatModel([seat('A-1-1', 300, -40)]);
    const v1 = fitView(one, 960, 560);
    expect(Number.isFinite(v1.scale) && v1.scale > 0).toBe(true);
    expectInside(one, v1, 960, 560, 20);
    expect(fitView(createSeatModel([]), 960, 560)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  test('K5_확대축소는화면점아래의좌석좌표를고정한채_배율을factor배로바꾼다', () => {
    const view: View = { scale: 1, offsetX: 10, offsetY: -20 };
    const before = { ...view };
    for (const [factor, px, py] of [
      [2, 300, 200],
      [0.5, 0, 0],
      [1.25, 959, 559],
    ] as const) {
      const next = zoomAt(view, factor, px, py);
      expect(next.scale).toBeCloseTo(view.scale * factor, 9);
      // 누른 화면 점 아래의 좌석 좌표가 그대로다
      const wx = (px - view.offsetX) / view.scale;
      const wy = (py - view.offsetY) / view.scale;
      expect(wx * next.scale + next.offsetX).toBeCloseTo(px, 9);
      expect(wy * next.scale + next.offsetY).toBeCloseTo(py, 9);
    }
    // 순수 함수: 받은 보기를 바꾸지 않는다
    expect(view).toEqual(before);
  });

  test('K5_확대배율은MIN_SCALE과MAX_SCALE사이로잘리고_잘려도화면점은고정된다', () => {
    expect(MIN_SCALE).toBeGreaterThan(0);
    expect(MAX_SCALE).toBeGreaterThan(MIN_SCALE);
    const cases: [View, number, number][] = [
      [{ scale: 1, offsetX: 5, offsetY: 7 }, 1e6, MAX_SCALE],
      [{ scale: 1, offsetX: 5, offsetY: 7 }, 1e-6, MIN_SCALE],
      [{ scale: MAX_SCALE, offsetX: -300, offsetY: 40 }, 1.5, MAX_SCALE],
      [{ scale: MIN_SCALE, offsetX: 300, offsetY: 40 }, 0.5, MIN_SCALE],
    ];
    for (const [view, factor, want] of cases) {
      const next = zoomAt(view, factor, 123, 45);
      expect(next.scale, `factor ${factor}`).toBeCloseTo(want, 12);
      const wx = (123 - view.offsetX) / view.scale;
      const wy = (45 - view.offsetY) / view.scale;
      expect(wx * next.scale + next.offsetX).toBeCloseTo(123, 6);
      expect(wy * next.scale + next.offsetY).toBeCloseTo(45, 6);
    }
    // 휠을 계속 굴려도 범위를 넘지 않는다
    let v: View = { scale: 1, offsetX: 0, offsetY: 0 };
    for (let i = 0; i < 200; i += 1) v = zoomAt(v, 1.1, 480, 280);
    expect(v.scale).toBeLessThanOrEqual(MAX_SCALE);
    for (let i = 0; i < 400; i += 1) v = zoomAt(v, 1 / 1.1, 480, 280);
    expect(v.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  test('K5_끌기이동은화면좌표로옮기고_배율은그대로이며받은보기를바꾸지않는다', () => {
    const view: View = { scale: 2.5, offsetX: 10, offsetY: 20 };
    expect(panBy(view, 30, -45)).toEqual({ scale: 2.5, offsetX: 40, offsetY: -25 });
    expect(panBy(view, 0, 0)).toEqual(view);
    expect(view).toEqual({ scale: 2.5, offsetX: 10, offsetY: 20 });
  });
});

// ───────────────────────── 누름 판정 ─────────────────────────

describe('seatAt', () => {
  test('K5_누른점에서좌석반지름x배율과6가운데큰반경안의_가장가까운좌석을고른다', () => {
    // 배율 2: 반경 = max(SEAT_RADIUS × 2, 6)
    const view: View = { scale: 2, offsetX: 10, offsetY: 20 };
    const r = Math.max(SEAT_RADIUS * 2, 6);
    const model = createSeatModel([seat('A-1-1', 100, 50), seat('A-1-2', 105, 50), seat('A-1-3', 200, 50)]);
    // 화면 좌표: A-1-1 (210,120), A-1-2 (220,120), A-1-3 (410,120)
    expect(seatAt(model, view, 210, 120)?.id).toBe('A-1-1');
    expect(seatAt(model, view, 214, 120)?.id).toBe('A-1-1'); // 둘 다 반경 안, 더 가까운 쪽
    expect(seatAt(model, view, 216, 120)?.id).toBe('A-1-2');
    expect(seatAt(model, view, 410, 120 + r)?.id).toBe('A-1-3'); // 반경 경계는 안이다
    expect(seatAt(model, view, 410, 120 + r + 0.5)).toBeUndefined();
    expect(seatAt(model, view, 410 - r - 0.5, 120)).toBeUndefined();
  });

  test('K5_배율이작아도누름판정반경은6이고_배율이크면반경도커진다', () => {
    const model = createSeatModel([seat('A-1-1', 100, 50)]);
    const small: View = { scale: 0.5, offsetX: 0, offsetY: 0 }; // 좌석 (50,25)
    expect(SEAT_RADIUS * small.scale).toBeLessThan(6);
    expect(seatAt(model, small, 56, 25)?.id).toBe('A-1-1');
    expect(seatAt(model, small, 56.5, 25)).toBeUndefined();
    const big: View = { scale: 4, offsetX: 0, offsetY: 0 }; // 좌석 (400,200)
    const rBig = SEAT_RADIUS * 4;
    expect(rBig).toBeGreaterThan(6);
    expect(seatAt(model, big, 400 + rBig, 200)?.id).toBe('A-1-1');
    expect(seatAt(model, big, 400 + rBig + 0.5, 200)).toBeUndefined();
  });

  test('K5_좌석이없으면누른곳에좌석이없다', () => {
    expect(seatAt(createSeatModel([]), { scale: 1, offsetX: 0, offsetY: 0 }, 0, 0)).toBeUndefined();
  });
});

// ───────────────────────── 고르기 ─────────────────────────

describe('toggleSelection·pruneSelection', () => {
  test('K5_빈좌석은누르면고르고_다시누르면고르기가풀린다', () => {
    const selected = new Set<string>();
    const s = seat('A-1-1', 0, 0);
    expect(toggleSelection(selected, s)).toBe('selected');
    expect([...selected]).toEqual(['A-1-1']);
    expect(toggleSelection(selected, s)).toBe('unselected');
    expect(selected.size).toBe(0);
  });

  test('K5_다른분선택과판매좌석은고를수없고_고른집합은그대로다', () => {
    const selected = new Set<string>(['A-1-9']);
    expect(toggleSelection(selected, seat('A-1-1', 0, 0, 'HELD'))).toBe('unavailable');
    expect(toggleSelection(selected, seat('A-1-2', 10, 0, 'SOLD'))).toBe('unavailable');
    expect([...selected]).toEqual(['A-1-9']);
  });

  test('K5_한번에10석까지만고르고_11번째는limit이며_하나를풀면다시고를수있다', () => {
    expect(MAX_SELECT).toBe(10);
    const seats = line(11);
    const selected = new Set<string>();
    for (const s of seats.slice(0, 10)) expect(toggleSelection(selected, s), s.id).toBe('selected');
    expect(toggleSelection(selected, seats[10]!)).toBe('limit');
    expect(selected.size).toBe(10);
    expect(selected.has('A-1-11')).toBe(false);
    expect(toggleSelection(selected, seats[0]!)).toBe('unselected');
    expect(toggleSelection(selected, seats[10]!)).toBe('selected');
    expect(selected.size).toBe(10);
  });

  test('K5_변경분으로빈좌석이아니게된고른좌석을빼고_뺀ID를돌려준다', () => {
    const model = createSeatModel(line(4));
    const selected = new Set(['A-1-1', 'A-1-2', 'A-1-3']);
    expect(pruneSelection(model, selected)).toEqual([]);
    expect(selected.size).toBe(3);
    applyChanges(model, [
      { seatId: 'A-1-1', status: 'HELD' },
      { seatId: 'A-1-3', status: 'SOLD' },
      { seatId: 'A-1-4', status: 'HELD' },
    ]);
    expect([...pruneSelection(model, selected)].sort()).toEqual(['A-1-1', 'A-1-3']);
    expect([...selected]).toEqual(['A-1-2']);
  });
});

// ───────────────────────── 그리기(K5의 v0: 좌석마다 경로 하나, 묶어 그리기 없음) ─────────────────────────

type Shape = 'arc' | 'rect';
type Call =
  | { op: 'clearRect'; x: number; y: number; w: number; h: number }
  | { op: 'beginPath' }
  | { op: 'arc'; x: number; y: number; r: number; a0: number; a1: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'fill'; style: unknown }
  | { op: 'stroke'; style: unknown; lineWidth: number };

/** Canvas 2D 문맥 대신 부른 순서와 그때의 색·선 굵기를 적는다(Ctx2D에 없는 메서드를 부르면 실패한다) */
function recordingCtx(): { ctx: Ctx2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: Ctx2D = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    clearRect: (x, y, w, h) => void calls.push({ op: 'clearRect', x, y, w, h }),
    beginPath: () => void calls.push({ op: 'beginPath' }),
    arc: (x, y, r, a0, a1) => void calls.push({ op: 'arc', x, y, r, a0, a1 }),
    rect: (x, y, w, h) => void calls.push({ op: 'rect', x, y, w, h }),
    fill: () => void calls.push({ op: 'fill', style: ctx.fillStyle }),
    stroke: () => void calls.push({ op: 'stroke', style: ctx.strokeStyle, lineWidth: ctx.lineWidth }),
  };
  return { ctx, calls };
}

interface SeatDraw {
  shapes: Shape[];
  fills: { style: unknown; shape: Shape }[];
  strokes: { style: unknown; lineWidth: number }[];
}

/**
 * 적은 호출을 좌석마다 묶는다. 원은 중심이 좌석의 화면 좌표와 같으면, 사각형은 좌석 중심을 품으면 그 좌석의 모양이다.
 * 채우기·테두리는 마지막 beginPath 뒤의 경로에 든 모양들에 붙는다(Canvas 2D의 경로 규칙)
 */
function analyse(calls: Call[], model: SeatModel, view: View) {
  const eps = 1e-6;
  const centers = model.seats.map((s) => ({ id: s.id, c: screenOf(view, s) }));
  const seatOfArc = (x: number, y: number) => centers.find(({ c }) => Math.abs(c[0] - x) < eps && Math.abs(c[1] - y) < eps)?.id;
  const seatOfRect = (x: number, y: number, w: number, h: number) => {
    const [x0, x1] = [Math.min(x, x + w), Math.max(x, x + w)];
    const [y0, y1] = [Math.min(y, y + h), Math.max(y, y + h)];
    const inside = centers.filter(({ c }) => c[0] >= x0 - eps && c[0] <= x1 + eps && c[1] >= y0 - eps && c[1] <= y1 + eps);
    const mid: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
    inside.sort((a, b) => Math.hypot(a.c[0] - mid[0], a.c[1] - mid[1]) - Math.hypot(b.c[0] - mid[0], b.c[1] - mid[1]));
    return inside[0]?.id;
  };
  const perSeat = new Map<string, SeatDraw>(model.seats.map((s) => [s.id, { shapes: [], fills: [], strokes: [] }]));
  const paths: { seat: string | undefined; shape: Shape }[][] = [];
  let current: { seat: string | undefined; shape: Shape }[] | undefined;
  let shapesBeforeFirstPath = 0;
  let beginPaths = 0;
  for (const c of calls) {
    if (c.op === 'clearRect') continue;
    if (c.op === 'beginPath') {
      beginPaths += 1;
      current = [];
      paths.push(current);
      continue;
    }
    if (c.op === 'arc' || c.op === 'rect') {
      if (!current) {
        shapesBeforeFirstPath += 1;
        current = [];
        paths.push(current);
      }
      const id = c.op === 'arc' ? seatOfArc(c.x, c.y) : seatOfRect(c.x, c.y, c.w, c.h);
      const size = c.op === 'arc' ? c.r : Math.min(Math.abs(c.w), Math.abs(c.h));
      expect(size, `${c.op} 크기`).toBeGreaterThan(0);
      current.push({ seat: id, shape: c.op });
      if (id) perSeat.get(id)!.shapes.push(c.op);
      continue;
    }
    for (const s of current ?? []) {
      if (!s.seat) continue;
      if (c.op === 'fill') perSeat.get(s.seat)!.fills.push({ style: c.style, shape: s.shape });
      else perSeat.get(s.seat)!.strokes.push({ style: c.style, lineWidth: c.lineWidth });
    }
  }
  const mixedPaths = paths.map((p) => [...new Set(p.map((s) => s.seat).filter(Boolean))]).filter((s) => s.length > 1);
  return { perSeat, mixedPaths, shapesBeforeFirstPath, beginPaths };
}

/** 그리기 시험의 좌석: 화면에서 40 간격(배율 2, 좌석 간격 20). 마지막 좌석은 화면 밖 */
function drawFixture() {
  const seats: Seat[] = [
    seat('vip', 10, 10, 'AVAILABLE', 'VIP'),
    seat('s', 30, 10, 'AVAILABLE', 'S'),
    seat('odd', 50, 10, 'AVAILABLE', 'ZZ'), // 정하지 않은 등급
    seat('held', 70, 10, 'HELD'),
    seat('sold', 90, 10, 'SOLD'),
    seat('picked', 110, 10, 'AVAILABLE', 'R'),
    seat('mine', 130, 10, 'HELD'),
    seat('far', 5000, 5000, 'AVAILABLE', 'A'), // 화면 밖
  ];
  const model = createSeatModel(seats);
  const view: View = { scale: 2, offsetX: 0, offsetY: 0 };
  const o = { selected: new Set(['picked']), mine: new Set(['mine']), width: 400, height: 100 };
  return { model, view, o };
}

describe('drawSeatMap', () => {
  test('K5_상태별색은서로다르고_다른분선택과판매의색은어느등급색과도다르다', () => {
    const gradeColors = [...Object.values(GRADE_COLORS), DEFAULT_GRADE_COLOR];
    expect(HELD_COLOR).not.toBe(SOLD_COLOR);
    for (const c of [HELD_COLOR, SOLD_COLOR]) expect(gradeColors).not.toContain(c);
  });

  test('K5_빈좌석은등급색원_다른분선택은회색원_판매는짙은회색사각형으로그린다', () => {
    const { model, view, o } = drawFixture();
    const { ctx, calls } = recordingCtx();
    drawSeatMap(ctx, model, view, o);
    const { perSeat } = analyse(calls, model, view);
    const filledWith = (id: string) => perSeat.get(id)!.fills;
    const expectCircle = (id: string, color: string) => {
      expect(filledWith(id), id).toContainEqual({ style: color, shape: 'arc' });
      expect(perSeat.get(id)!.shapes, id).not.toContain('rect');
    };
    expectCircle('vip', GRADE_COLORS.VIP!);
    expectCircle('s', GRADE_COLORS.S!);
    expectCircle('odd', DEFAULT_GRADE_COLOR);
    expectCircle('far', GRADE_COLORS.A!);
    expectCircle('held', HELD_COLOR);
    expect(filledWith('sold'), 'sold').toContainEqual({ style: SOLD_COLOR, shape: 'rect' });
    expect(perSeat.get('sold')!.shapes, 'sold').not.toContain('arc');
    // 상태가 다른 좌석의 채우기 색이 섞이지 않는다
    expect(filledWith('vip').map((f) => f.style)).not.toContain(HELD_COLOR);
    expect(filledWith('held').map((f) => f.style)).not.toContain(GRADE_COLORS.R);
  });

  test('K5_내가고른좌석은굵은테두리3이고_내홀드는이중테두리라_다른좌석과모양이다르다', () => {
    const { model, view, o } = drawFixture();
    const { ctx, calls } = recordingCtx();
    drawSeatMap(ctx, model, view, o);
    const { perSeat } = analyse(calls, model, view);
    expect(perSeat.get('picked')!.strokes.map((s) => s.lineWidth), 'picked').toContain(3);
    expect(perSeat.get('picked')!.shapes, 'picked').toContain('arc');
    // 고른 좌석도 빈 좌석이라 등급 색 원 위에 테두리를 더한다(§14 동작 7 '빈 좌석은 등급 색 원 … 내가 고른 좌석은 굵은 테두리')
    expect(perSeat.get('picked')!.fills, 'picked 채우기').toContainEqual({ style: GRADE_COLORS.R, shape: 'arc' });
    expect(perSeat.get('mine')!.strokes.length, 'mine 테두리 수').toBeGreaterThanOrEqual(2);
    for (const id of ['vip', 's', 'odd', 'held', 'sold', 'far']) {
      const strokes = perSeat.get(id)!.strokes;
      expect(strokes.length, `${id} 테두리 수`).toBeLessThanOrEqual(1);
      expect(strokes.filter((s) => s.lineWidth >= 3), `${id} 굵은 테두리`).toEqual([]);
    }
  });

  test('K5_좌석마다따로경로를그려_한경로에두좌석이없고_화면밖좌석까지모두그려센다', () => {
    const { model, view, o } = drawFixture();
    const { ctx, calls } = recordingCtx();
    const n = drawSeatMap(ctx, model, view, o);
    expect(n).toBe(8);
    const { perSeat, mixedPaths, shapesBeforeFirstPath, beginPaths } = analyse(calls, model, view);
    expect(mixedPaths).toEqual([]);
    expect(shapesBeforeFirstPath).toBe(0);
    expect(beginPaths).toBeGreaterThanOrEqual(8);
    for (const [id, d] of perSeat) expect(d.fills.length, `${id} 채우기`).toBeGreaterThanOrEqual(1);
    // 화면 밖(400×100 밖) 좌석도 그렸다
    const [fx, fy] = screenOf(view, model.byId.get('far')!);
    expect(fx > o.width || fy > o.height).toBe(true);
    expect(perSeat.get('far')!.shapes.length).toBeGreaterThanOrEqual(1);
  });

  test('K5_그릴때마다화면전체를지우고모든좌석을다시그린다', () => {
    const { model, view, o } = drawFixture();
    for (let round = 0; round < 2; round += 1) {
      const { ctx, calls } = recordingCtx();
      if (round === 1) applyChanges(model, [{ seatId: 'vip', status: 'HELD' }]);
      expect(drawSeatMap(ctx, model, view, o), `round ${round}`).toBe(8);
      const clears = calls.filter((c): c is Extract<Call, { op: 'clearRect' }> => c.op === 'clearRect');
      expect(clears.some((c) => c.x <= 0 && c.y <= 0 && c.x + c.w >= o.width && c.y + c.h >= o.height), `round ${round} 전체 지우기`).toBe(true);
      const firstClear = calls.findIndex((c) => c.op === 'clearRect');
      const firstPath = calls.findIndex((c) => c.op === 'beginPath');
      expect(firstClear, `round ${round} 지우기가 그리기보다 먼저`).toBeLessThan(firstPath);
      const { perSeat } = analyse(calls, model, view);
      for (const [id, d] of perSeat) expect(d.fills.length, `round ${round} ${id}`).toBeGreaterThanOrEqual(1);
      if (round === 1) expect(perSeat.get('vip')!.fills).toContainEqual({ style: HELD_COLOR, shape: 'arc' });
    }
  });

  test('K5_좌석2천개도묶지않고좌석마다경로를하나씩그린다', () => {
    const seats: Seat[] = [];
    for (let r = 0; r < 40; r += 1) for (let c = 0; c < 50; c += 1) seats.push(seat(`A-${r + 1}-${c + 1}`, c * 10, r * 10, (['AVAILABLE', 'HELD', 'SOLD'] as const)[(r + c) % 3]));
    const model = createSeatModel(seats);
    const view: View = { scale: 1, offsetX: 5, offsetY: 5 };
    const { ctx, calls } = recordingCtx();
    expect(drawSeatMap(ctx, model, view, { selected: new Set(), mine: new Set(), width: 960, height: 560 })).toBe(2_000);
    const { perSeat, mixedPaths, beginPaths } = analyse(calls, model, view);
    expect(mixedPaths).toEqual([]);
    expect(beginPaths).toBeGreaterThanOrEqual(2_000);
    expect([...perSeat.values()].filter((d) => d.fills.length === 0)).toEqual([]);
  });
});

// 브라우저 확인(docs/review/browser-check/BSL-030.md)이 찾은 결함의 재현 시험(docs/architecture.md §8.6의 3):
// 좁은 화면에서 캔버스가 CSS로 줄어 보이면 누른 위치(CSS 화소)와 그리는 좌표(캔버스 화소)가 달라 다른 좌석이 골라졌다
describe('누른 위치를 캔버스 좌표로', () => {
  test('K5_FR010_캔버스가CSS로줄어보여도_누른점을캔버스좌표로바꾼다', async () => {
    const { canvasPoint } = (await import('../public/v0-seatmap/seatmap-model.js')) as unknown as {
      canvasPoint: (clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) => { x: number; y: number };
    };
    expect(typeof canvasPoint).toBe('function');
    // 960×560 캔버스가 왼쪽 위 (16, 100)에 480×280으로 보인다(절반)
    expect(canvasPoint(16 + 240, 100 + 140, { left: 16, top: 100, width: 480, height: 280 }, 960, 560)).toEqual({ x: 480, y: 280 });
    // 줄지 않았으면 그대로
    expect(canvasPoint(26, 110, { left: 16, top: 100, width: 960, height: 560 }, 960, 560)).toEqual({ x: 10, y: 10 });
  });
});

// 새 맥락 코드 리뷰가 찾은 결함의 재현 시험: 맞춤 배율이 확대 범위 밖이면 휠 방향이 뒤집혔다
describe('휠 방향', () => {
  test('K5_맞춤배율이확대범위밖이어도_축소는더작게확대는더크게만한다', async () => {
    const m = await import('../public/v0-seatmap/seatmap-model.js');
    const tiny = { scale: 0.036, offsetX: 0, offsetY: 0 };
    expect(m.zoomAt(tiny, 1 / 1.2, 100, 100).scale).toBeLessThanOrEqual(0.036);
    expect(m.zoomAt(tiny, 1.2, 100, 100).scale).toBeGreaterThan(0.036);
    const huge = { scale: 65, offsetX: 0, offsetY: 0 };
    expect(m.zoomAt(huge, 1.2, 100, 100).scale).toBeGreaterThanOrEqual(65);
    expect(m.zoomAt(huge, 1 / 1.2, 100, 100).scale).toBeLessThan(65);
  });
});
