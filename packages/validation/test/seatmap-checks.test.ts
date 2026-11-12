// 좌석맵 업무 경고 검사기 시험(ADR-0264 결정 15, S-T40 ③~⑦).
import { describe, expect, test } from 'vitest';
import { checkSeatmap, outsideWarnings, overlapWarnings, pointInside, seatSpacingOf, wheelchairWarnings, WARNING_SEAT_IDS_MAX, type CheckSeat, type CheckSection } from '../src/seatmap-checks/index.js';

const square = (x = 0, y = 0, w = 1000, h = 1000) => ({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const });

function section(seats: readonly CheckSeat[], o: Partial<CheckSection> = {}): CheckSection {
  return { sectionId: 's1', shape: square(), seats, ...o };
}
let seq = 0;
function seat(o: Partial<CheckSeat> = {}) {
  return { seatId: `x${++seq}`, row: '1', number: seq, x: 100, y: 100, ...o };
}
function rowOf(n: number, wheelchairAt: readonly number[] = [], o: Partial<CheckSeat> = {}) {
  return Array.from({ length: n }, (_, i) => seat({ number: i + 1, x: 100 + i * 50, y: 100, ...(wheelchairAt.includes(i + 1) ? { wheelchair: true } : {}), ...o }));
}
const codes = (w: ReturnType<typeof checkSeatmap>) => w.map((x) => x.code);

describe('S-T40 ③ W1 휠체어석 수', () => {
  test('S-T40 ③ 2,400석에 휠체어석 12석은 W1(기준 20석)이고 0석도 W1이다', () => {
    const many = Array.from({ length: 24 }, (_, r) => rowOf(100, [], { row: String(r + 1) })).flat();
    const twelve = many.map((s, i) => (i < 12 ? { ...s, wheelchair: true as const } : s));
    const w1 = wheelchairWarnings([section(twelve)]).find((w) => w.code === 'W1')!;
    expect(w1.seatCount).toBe(12);
    expect(w1.seatIds).toHaveLength(12);
    const zero = wheelchairWarnings([section(many)]).find((w) => w.code === 'W1')!;
    expect(zero.seatCount).toBe(0);
  });

  test('S-T40 ③ 1,234석은 기준 13석이라 13석은 경고가 없고 12석은 W1이다', () => {
    const many = Array.from({ length: 13 }, (_, r) => rowOf(95, [], { row: String(r + 1) })).flat().slice(0, 1234);
    const thirteen = many.map((s, i) => (i < 13 ? { ...s, wheelchair: true as const } : s));
    expect(wheelchairWarnings([section(thirteen)]).some((w) => w.code === 'W1')).toBe(false);
    const twelve = many.map((s, i) => (i < 12 ? { ...s, wheelchair: true as const } : s));
    expect(wheelchairWarnings([section(twelve)]).find((w) => w.code === 'W1')?.seatCount).toBe(12);
  });
});

describe('S-T40 ④ W2 이어진 휠체어석 묶음', () => {
  test('S-T40 ④ 양옆 일반 좌석이 2석씩인 묶음만 W2이고 1석인 묶음·열 끝·번갈아 있는 열은 아니다', () => {
    const two = section(rowOf(6, [3, 4]));
    expect(wheelchairWarnings([two]).find((w) => w.code === 'W2')?.seatIds).toEqual([two.seats![2]!.seatId, two.seats![3]!.seatId]);
    const one = section(rowOf(4, [3]));
    expect(wheelchairWarnings([one]).some((w) => w.code === 'W2')).toBe(false);
    const edge = section(rowOf(6, [1, 2]));
    expect(wheelchairWarnings([edge]).some((w) => w.code === 'W2')).toBe(false);
    const alternating = section(rowOf(6, [2, 4, 6]));
    expect(wheelchairWarnings([alternating]).some((w) => w.code === 'W2')).toBe(false);
  });
});

describe('S-T40 ⑤ W3 판매 제외', () => {
  test('S-T40 ⑤ 휠체어석이 모두 판매 제외면 W3이고 일반 좌석은 상관없다', () => {
    const s = section(rowOf(4, [2, 3]).map((x) => (x.wheelchair ? { ...x, unavailable: true } : x)));
    expect(wheelchairWarnings([s]).some((w) => w.code === 'W3')).toBe(true);
    const some = section(rowOf(4, [2, 3]).map((x) => (x.wheelchair && x.number === 2 ? { ...x, unavailable: true } : x)));
    expect(wheelchairWarnings([some]).some((w) => w.code === 'W3')).toBe(false);
  });
});

describe('S-T40 ⑥ 좌석 겹침', () => {
  test('S-T40 ⑥ 간격 50cm 구역에서 중심 사이 24cm는 두 좌석 모두, 25cm는 경고가 아니다', () => {
    const a = seat({ seatId: 'a', x: 100, y: 100 });
    const b = seat({ seatId: 'b', x: 124, y: 100 });
    const hit = overlapWarnings([section([a, b], { fillRule: { seatSpacingCm: 50 } })]);
    expect(hit).toEqual([{ code: 'SEAT_OVERLAP', seatIds: ['a', 'b'], seatCount: 2 }]);
    const c = seat({ seatId: 'c', x: 125, y: 100 });
    expect(overlapWarnings([section([a, c], { fillRule: { seatSpacingCm: 50 } })])).toEqual([]);
  });

  test('S-T40 ⑥ 이웃 구역 좌석과 겹쳐도 두 좌석이 모두 든다', () => {
    const a = section([seat({ seatId: 'a', x: 100, y: 100 })]);
    const b = section([seat({ seatId: 'b', x: 110, y: 100 })], { sectionId: 's2', shape: square(50, 0) });
    expect(overlapWarnings([a, b])[0]).toEqual({ code: 'SEAT_OVERLAP', seatIds: ['a', 'b'], seatCount: 2 });
  });

  test('S-T40 ⑥ 좌석 간격이 없으면 50cm를 쓰고, 경고 ID는 100개까지이며 seatCount는 전체 수다', () => {
    expect(seatSpacingOf(section([]))).toBe(50);
    expect(seatSpacingOf(section([], { fillRule: { seatSpacingCm: 100_000 } }))).toBe(1_000);
    const seats = Array.from({ length: 101 }, (_, i) => seat({ seatId: `p${i}`, x: 100, y: 100 }));
    const w = overlapWarnings([section(seats)])[0]!;
    expect(w.seatIds).toHaveLength(WARNING_SEAT_IDS_MAX);
    expect(w.seatCount).toBe(101);
  });

  test('S-T40 ⑥ 같은 좌표 1,001석은 모두 겹침으로 세고 ID는 100개까지다', () => {
    const seats = Array.from({ length: 1_001 }, (_, i) => seat({ seatId: `same${i}`, x: 100, y: 100 }));
    const w = overlapWarnings([section(seats)])[0]!;
    expect(w.seatCount).toBe(1_001);
    expect(w.seatIds).toHaveLength(WARNING_SEAT_IDS_MAX);
  });

  test('S-T40 ⑥ 촘촘한 2,001석도 비교 상한 안에서 겹침으로 센다', () => {
    const seats = Array.from({ length: 2_001 }, (_, i) => seat({ seatId: `dense${i}`, x: 100 + i * 0.001, y: 100 }));
    const w = overlapWarnings([section(seats)])[0]!;
    expect(w.seatCount).toBe(2_001);
    expect(w.seatIds).toHaveLength(WARNING_SEAT_IDS_MAX);
  });
});

describe('S-T40 ⑦ 도형 밖 좌석', () => {
  test('S-T40 ⑦ 밖 좌석만 SEAT_OUTSIDE_SHAPE이고 변 위·안 좌석은 아니다', () => {
    const s = section([
      seat({ seatId: 'inside', x: 500, y: 500 }),
      seat({ seatId: 'edge', x: 1000, y: 500 }),
      seat({ seatId: 'outside', x: 1001, y: 500 }),
    ]);
    expect(pointInside(s.shape.points, 1000, 500)).toBe(true);
    expect(pointInside(s.shape.points, 1001, 500)).toBe(false);
    expect(outsideWarnings([s])).toEqual([{ code: 'SEAT_OUTSIDE_SHAPE', seatIds: ['outside'], seatCount: 1 }]);
  });
});

describe('전체 차례', () => {
  test('FE-T38 ③ 도형 밖 좌석과 겹친 좌석은 경고로 나오고 저장을 막지 않는다', () => {
    const s = section([
      seat({ seatId: 'a', x: 100, y: 100 }),
      seat({ seatId: 'b', x: 120, y: 100 }),
      seat({ seatId: 'c', x: 2000, y: 2000 }),
    ]);
    const w = checkSeatmap({ sections: [s] });
    expect(w.map((x) => x.code)).toContain('SEAT_OVERLAP');
    expect(w.map((x) => x.code)).toContain('SEAT_OUTSIDE_SHAPE');
    expect(w.find((x) => x.code === 'SEAT_OVERLAP')?.seatIds).toEqual(['a', 'b']);
  });

  test('W1·W2·W3·겹침·도형 밖 순서로 돌려주고 경고가 없으면 빈 배열이다', () => {
    const s = section([
      seat({ seatId: 'a', x: 100, y: 100, wheelchair: true, unavailable: true }),
      seat({ seatId: 'b', x: 110, y: 100, wheelchair: true, unavailable: true }),
      seat({ seatId: 'c', x: 500, y: 500 }),
    ]);
    expect(codes(checkSeatmap({ sections: [s] }))).toEqual(['W3', 'SEAT_OVERLAP']);
    expect(checkSeatmap({ sections: [section([])] })).toEqual([]);
  });
});
