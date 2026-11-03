// 좌석 v0 도메인 공개 함수와 규칙 값(docs/features/seat-hold.md §14, §5 POL-012).
// 모듈 공개 파일만 본다. DB 없이 도는 단위 시험이다.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_EXTEND_MS,
  DEFAULT_HOLD_TTL_MS,
  EVENT_ID_PATTERN,
  MAX_SEATS_PER_HOLD,
  SEAT_ID_PATTERN,
  kstIso,
  seatGrid,
  type SeatDefinition,
  type SeatGridOptions,
} from '../src/modules/inventory/index.js';

const KST_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;

describe('규칙 값(§14, POL-012)', () => {
  test('POL012_홀드시간기본값은7분이고_1회연장기본값은3분이다', () => {
    expect({ ttl: DEFAULT_HOLD_TTL_MS, extend: DEFAULT_EXTEND_MS }).toEqual({ ttl: 7 * 60 * 1000, extend: 3 * 60 * 1000 });
  });

  test('FR010_홀드한번에고를수있는좌석은1~10개다', () => {
    expect(MAX_SEATS_PER_HOLD).toBe(10);
  });

  test('FR010_좌석ID와회차ID는영숫자와-_로된1~64자만받는다 [ASVS v5.0.0-2.2.1]', () => {
    for (const p of [SEAT_ID_PATTERN, EVENT_ID_PATTERN]) {
      for (const ok of ['A', 'A-1-1', 'vip_01', 'z'.repeat(64), 'AZaz09-_']) expect(p.test(ok), ok).toBe(true);
      for (const bad of ['', 'z'.repeat(65), 'A 1', 'A/1', 'A.1', "A'1", 'A"1', 'A;1', '{A}', 'A%1', '가1', 'A\n']) expect(p.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('kstIso(유닉스 밀리초 → KST ISO 8601)', () => {
  test('FR010_kstIso는KST오프셋+09:00과밀리초세자리로쓴다', () => {
    const cases: [string, string][] = [
      ['2026-11-01T00:00:00.000Z', '2026-11-01T09:00:00.000+09:00'],
      ['2026-11-01T00:07:00.000Z', '2026-11-01T09:07:00.000+09:00'],
      ['2026-11-01T14:59:59.999Z', '2026-11-01T23:59:59.999+09:00'],
      // 날짜가 KST로 넘어간다
      ['2026-11-01T15:00:00.000Z', '2026-11-02T00:00:00.000+09:00'],
      ['2026-12-31T15:00:00.005Z', '2027-01-01T00:00:00.005+09:00'],
      ['2028-02-28T15:30:00.050Z', '2028-02-29T00:30:00.050+09:00'],
      ['1970-01-01T00:00:00.000Z', '1970-01-01T09:00:00.000+09:00'],
    ];
    for (const [utc, kst] of cases) expect(kstIso(Date.parse(utc)), utc).toBe(kst);
  });

  test('FR010_kstIso가쓴글은같은순간으로다시읽힌다', () => {
    const base = Date.parse('2026-11-01T00:00:00.000Z');
    for (const ms of [base, base + 1, base + 7 * 60 * 1000 + 123, base + 86_399_999, base + 400 * 86_400_000 + 9, 1_000, 999]) {
      const s = kstIso(ms);
      expect(s, String(ms)).toMatch(KST_ISO);
      expect(Date.parse(s), s).toBe(ms);
    }
  });

  test('FR010_kstIso는정수밀리초가아닌시각을받지않고던진다', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, Date.parse('2026-11-01T00:00:00Z') + 0.25]) {
      expect(() => kstIso(bad), String(bad)).toThrow(RangeError);
    }
    expect(() => kstIso('1700000000000' as unknown as number)).toThrow(RangeError);
  });
});

describe('seatGrid(시험·부하 시험용 격자 좌석)', () => {
  const dist = (a: SeatDefinition, b: SeatDefinition) => Math.hypot(a.x - b.x, a.y - b.y);
  /** 가장 가까운 두 좌석의 거리(좌석 수가 적은 격자에서만 쓴다) */
  const minDistance = (seats: SeatDefinition[]) => {
    let m = Number.POSITIVE_INFINITY;
    for (let i = 0; i < seats.length; i += 1) for (let j = i + 1; j < seats.length; j += 1) m = Math.min(m, dist(seats[i]!, seats[j]!));
    return m;
  };

  test('FR009_seatGrid는구역x열x번호만큼만들고_ID는구역-열-번호이며열과번호는1부터다', () => {
    const seats = seatGrid({ sections: ['A', 'B'], rows: 3, perRow: 4 });
    expect(seats).toHaveLength(2 * 3 * 4);
    const expected: string[] = [];
    for (const s of ['A', 'B']) for (let r = 1; r <= 3; r += 1) for (let n = 1; n <= 4; n += 1) expected.push(`${s}-${r}-${n}`);
    expect(seats.map((s) => s.id).sort()).toEqual([...expected].sort());
    for (const s of seats) {
      expect(s.id, JSON.stringify(s)).toBe(`${s.section}-${s.row}-${s.number}`);
      expect(typeof s.row).toBe('string');
      expect(Number.isInteger(s.number)).toBe(true);
      expect(SEAT_ID_PATTERN.test(s.id), s.id).toBe(true);
    }
    expect([...new Set(seats.map((s) => s.row))].sort()).toEqual(['1', '2', '3']);
    expect([...new Set(seats.map((s) => s.number))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test('FR009_seatGrid좌석은좌표가겹치지않는정수이고_가장가까운두좌석의거리가좌석간격이다', () => {
    const cases: [number, SeatGridOptions][] = [
      [10, { sections: ['A', 'B', 'C'], rows: 4, perRow: 5 }],
      [25, { sections: ['A', 'B'], rows: 3, perRow: 6, spacing: 25 }],
    ];
    for (const [spacing, o] of cases) {
      const seats = seatGrid(o);
      expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size, `spacing ${spacing}`).toBe(seats.length);
      for (const s of seats) expect(Number.isInteger(s.x) && Number.isInteger(s.y), JSON.stringify(s)).toBe(true);
      expect(minDistance(seats), `spacing ${spacing}`).toBe(spacing);
    }
  });

  test('FR009_seatGrid구역은가로로늘어서_앞구역좌석이모두뒤구역좌석보다왼쪽이다', () => {
    const sections = ['A', 'B', 'C', 'D'];
    const seats = seatGrid({ sections, rows: 3, perRow: 4 });
    for (let i = 0; i + 1 < sections.length; i += 1) {
      const maxX = Math.max(...seats.filter((s) => s.section === sections[i]).map((s) => s.x));
      const minX = Math.min(...seats.filter((s) => s.section === sections[i + 1]).map((s) => s.x));
      expect(maxX, `${sections[i]} < ${sections[i + 1]}`).toBeLessThan(minX);
    }
  });

  test('FR009_seatGrid등급은구역마다정한값이고_정하지않은구역은R이다', () => {
    const seats = seatGrid({ sections: ['A', 'B', 'C'], rows: 2, perRow: 2, grades: { A: 'VIP', B: 'S' } });
    for (const s of seats) expect(s.grade, s.id).toBe({ A: 'VIP', B: 'S', C: 'R' }[s.section]);
    expect(seatGrid({ sections: ['X'], rows: 1, perRow: 3 }).map((s) => s.grade)).toEqual(['R', 'R', 'R']);
  });

  test('FR009_seatGrid로5만석을만들면_ID와좌표가모두다르다', () => {
    const sections = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const seats = seatGrid({ sections, rows: 50, perRow: 100 });
    expect(seats).toHaveLength(50_000);
    expect(new Set(seats.map((s) => s.id)).size).toBe(50_000);
    expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(50_000);
  });
});
