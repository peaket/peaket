// core-svc가 작업 응답을 다시 보는 도메인 규칙의 리뷰 재현 시험(BAT-145 리뷰 2차 S10·S13, ADR-0257 결정 8). 공개 순수 함수만 부른다.
import { describe, expect, test } from 'vitest';
import { type CheckedLayout, countRaw, parseLayoutJson, recheckLayout } from '../src/modules/catalog/domain/seatmap-import.js';

const base = (o: Partial<CheckedLayout> = {}): CheckedLayout => ({
  canvas: { width: 100, height: 100 },
  sections: [{ sectionId: 'A', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [10, 0], [10, 10]] }, seats: [{ seatId: 'A-1-1', row: '1', number: 1, x: 1, y: 1 }] }],
  ...o,
});
const sec = (o: Record<string, unknown>) => ({ sectionId: 'A', name: 'A', shape: { kind: 'POLYGON' as const, points: [[0, 0], [10, 0], [10, 10]] as [number, number][] }, seats: [], ...o });

describe('작업 응답 다시 보기(강화)', () => {
  test('작업 응답 JSON의 __proto__·constructor·prototype 키는 받지 않는다 [ASVS v5.0.0-1.5.2]', () => {
    expect(parseLayoutJson('{"canvas":{"width":1,"height":1},"sections":[]}')).toEqual({ canvas: { width: 1, height: 1 }, sections: [] });
    for (const bad of ['{"__proto__":{"x":1},"sections":[]}', '{"sections":[{"constructor":{"prototype":{}}}]}', '{"a":{"prototype":1}}', 'not json']) expect(parseLayoutJson(bad), bad).toBe('invalid');
  });

  test('글자 칸에 제어 문자가 남았거나 길이를 넘으면 행 오류다(구역·좌석 ID 64, 이름·층 30, 열 8, 등급·게이트 30) [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-16.4.1]', () => {
    expect(recheckLayout(base())).toEqual([]);
    const r = recheckLayout(
      base({
        stage: [{ kind: 'RECT', points: [[0, 0], [1, 0], [1, 1]], name: 'x'.repeat(31) }],
        sections: [
          sec({ sectionId: 'S'.repeat(65), name: 'A\u0007', level: '1\u202e층', tierId: 'R'.repeat(31), seats: [{ seatId: 'a'.repeat(65), row: '123456789', number: 1, x: 1, y: 1, gateZone: 'G\n' }] }),
        ],
      }),
    );
    expect(r.map((e) => [e.field, e.code])).toEqual([
      ['stage[0].name', 'TEXT_INVALID'],
      ['sections[0].sectionId', 'TEXT_INVALID'],
      ['sections[0].name', 'TEXT_INVALID'],
      ['sections[0].level', 'TEXT_INVALID'],
      ['sections[0].tierId', 'TEXT_INVALID'],
      ['sections[0].seats[0].seatId', 'TEXT_INVALID'],
      ['sections[0].seats[0].row', 'TEXT_INVALID'],
      ['sections[0].seats[0].gateZone', 'TEXT_INVALID'],
    ]);
  });

  test('S-T38 ① 구역 도형 이름(shape.name)도 글자 칸 규칙이다(NUL·제어 문자·30자) [ASVS v5.0.0-2.2.1]', () => {
    const named = (name: string) => recheckLayout(base({ sections: [sec({ shape: { kind: 'POLYGON', points: [[0, 0], [10, 0], [10, 10]], name } })] }));
    expect(named('무대 앞')).toEqual([]);
    for (const bad of ['A\u0000', 'B\u0007', 'C\u202e', 'x'.repeat(31)]) expect(named(bad).map((e) => [e.field, e.code]), JSON.stringify(bad)).toEqual([['sections[0].shape.name', 'TEXT_INVALID']]);
  });

  test('라벨 x·y는 하나만 있어도 캔버스 안이어야 하고, seatIndexRange·index는 0~999,999(from ≤ to), 좌석 번호는 1 이상이다 [ASVS v5.0.0-1.4.2]', () => {
    const r = recheckLayout(
      base({
        sections: [
          sec({ label: { x: 101 }, seatIndexRange: { from: 5, to: 4 }, seats: [{ seatId: 'a', row: '1', number: 0, x: 1, y: 1, index: -1 }] }),
          sec({ sectionId: 'B', label: { y: -1 }, seatIndexRange: { from: 0, to: 1_000_000 }, seats: [{ seatId: 'b', row: '1', number: 1, x: 1, y: 1, index: 1_000_000 }] }),
        ],
      }),
    );
    expect(r.map((e) => [e.field, e.code])).toEqual([
      ['sections[0].label', 'OUT_OF_CANVAS'],
      ['sections[0].seatIndexRange', 'RANGE_INVALID'],
      ['sections[0].seats[0].number', 'NUMBER_INVALID'],
      ['sections[0].seats[0].index', 'RANGE_INVALID'],
      ['sections[1].label', 'OUT_OF_CANVAS'],
      ['sections[1].seatIndexRange', 'RANGE_INVALID'],
      ['sections[1].seats[0].index', 'RANGE_INVALID'],
    ]);
  });

  test('겹침은 구역 ID로 가린다: 이름이 같은 두 구역(층이 다름)은 받고, 같은 구역 ID·같은 구역의 같은 열·번호는 오류다 [ASVS v5.0.0-2.2.1]', () => {
    const seat = (id: string, n: number) => ({ seatId: id, row: '1', number: n, x: 1, y: 1 });
    expect(recheckLayout(base({ sections: [sec({ sectionId: 'A1', level: '1층', seats: [seat('a', 1)] }), sec({ sectionId: 'A2', level: '2층', seats: [seat('b', 1)] })] }))).toEqual([]);
    expect(recheckLayout(base({ sections: [sec({ sectionId: 'A1', seats: [seat('a', 1), seat('b', 1)] }), sec({ sectionId: 'A1', seats: [seat('c', 2)] })] })).map((e) => [e.field, e.code])).toEqual([
      ['sections[0].seats[1]', 'DUPLICATE_SEAT'],
      ['sections[1].sectionId', 'SECTION_ID_DUPLICATE'],
    ]);
  });

  test('개수 상한은 스키마 검사 전에 모양을 모르는 값으로 센다(좌석 50,001·구역 501·꼭짓점 1,001·무대 501)', () => {
    const seats = (n: number) => Array.from({ length: n }, () => ({}));
    expect(countRaw({ sections: [{ seats: seats(50_000), shape: { points: [] } }] })).toBeUndefined();
    expect(countRaw({ sections: [{ seats: seats(25_000) }, { seats: seats(25_001), shape: 'broken' }] })).toBe('TOO_MANY_SEATS');
    expect(countRaw({ sections: Array.from({ length: 501 }, () => 'x') })).toBe('TOO_MANY_SECTIONS');
    expect(countRaw({ sections: [{ shape: { points: Array.from({ length: 1001 }, () => 0) } }] })).toBe('TOO_MANY_POINTS');
    expect(countRaw({ sections: [], stage: Array.from({ length: 501 }, () => ({})) })).toBe('TOO_MANY_STAGE');
    expect(countRaw('x')).toBeUndefined();
  });
});
