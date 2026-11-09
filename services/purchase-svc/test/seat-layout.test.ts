// 운영 좌석맵 판(BUILD_ORDER PRF-137, docs/features/seat-hold.md §2 '운영 좌석맵 판'): 판 파일 해석(parseEventSeatMapFile), 파일 출처(FileSeatMapSource),
// 처음 부를 때만 읽는 LayoutSeatMap(SeatMap·SeatMapIndex·SeatMapSections), 메모리 대역의 sections.
// 시각은 가짜 시계, 파일 출처는 호출 수를 세는 메모리 가짜, 폴더는 임시 폴더다(무작위 대기 없음).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type EventSeatConfig,
  FileSeatMapSource,
  LayoutSeatMap,
  MemorySeatMap,
  parseEventSeatMapFile,
  parseTierPrices,
  type SeatMapFileErrorCode,
  SeatMapFileError,
  type SeatMapSource,
  type SeatRef,
} from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const EVENT = 'ev-1';
const SALE_END = '2026-12-01T09:00:00.000Z';
const SALE_END_MS = Date.parse(SALE_END);

// ── 판 파일 만들기(openapi SeatMapLayout의 좌석 층까지. 모르는 칸 canvas·name·shape·row·number·x·y는 실제 파일에도 있다) ──────────────────────────────

const seat = (seatId: unknown, index: unknown, over: Record<string, unknown> = {}) => ({ seatId, row: 'A', number: 1, x: 10, y: 20, index, ...over });
const section = (sectionId: unknown, from: unknown, to: unknown, seats: unknown[], over: Record<string, unknown> = {}) => ({
  sectionId,
  name: `구역 ${String(sectionId)}`,
  shape: { type: 'polygon', points: [] },
  tierId: 'R',
  seatIndexRange: { from, to },
  seats,
  ...over,
});
const file = (sections: unknown, over: Record<string, unknown> = {}, layoutOver: Record<string, unknown> = {}) => ({
  perAccountLimit: 2,
  saleEndsAt: SALE_END,
  layout: { layoutVersion: 7, canvas: { width: 1000, height: 800 }, sections, ...layoutOver },
  ...over,
});

/** 구역 A(구역 색인 0, 등급 R, 색인 0~2: A01 · A02(좌석 등급 VIP) · A03 판매 제외) */
const secA = () => section('SEC-A', 0, 2, [seat('A01', 0), seat('A02', 1, { tierId: 'VIP' }), seat('A03', 2, { unavailable: true })]);
/** 구역 B(구역 색인 1, 등급 S, 색인 10~11) */
const secB = () => section('SEC-B', 10, 11, [seat('B01', 10), seat('B02', 11)], { tierId: 'S' });
const validFile = () => file([secA(), secB()]);

const A01: SeatRef = { seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' };
const A02: SeatRef = { seatId: 'A02', index: 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 1, tierId: 'VIP' };
const A03: SeatRef = { seatId: 'A03', index: 2, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 2, tierId: 'R' };
const B01: SeatRef = { seatId: 'B01', index: 10, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: 0, tierId: 'S' };
const B02: SeatRef = { seatId: 'B02', index: 11, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: 1, tierId: 'S' };

const CONFIG_V7: EventSeatConfig = { eventId: EVENT, layoutVersion: '7', seatCount: 12, perAccountLimit: 2, saleEndsAtMs: SALE_END_MS };

/** 해석해서 SeatMapFileError의 코드를 돌려준다(통과하면 'ok'. 다른 오류는 그대로 던진다) */
function codeOf(raw: unknown, eventId = EVENT): SeatMapFileErrorCode | 'ok' {
  try {
    parseEventSeatMapFile(eventId, raw);
  } catch (e) {
    if (e instanceof SeatMapFileError) return e.code;
    throw e;
  }
  return 'ok';
}

/** 오류를 잡아 돌려준다(없으면 던진다) */
function errorOf(raw: unknown): SeatMapFileError {
  try {
    parseEventSeatMapFile(EVENT, raw);
  } catch (e) {
    if (e instanceof SeatMapFileError) return e;
    throw e;
  }
  throw new Error('SeatMapFileError가 나야 하는데 통과했다');
}

// ── (a) parseEventSeatMapFile ───────────────────────────────────────────────────────────────────────────────────

describe('parseEventSeatMapFile: 정상 판', () => {
  test('ST30_구역 둘의 판을 해석한다: 구역 색인 = 배열 차례, 구역 안 거리 = 색인 − from, 등급 = 좌석 tierId ?? 구역 tierId, 판매 제외석은 byId에 없고 byIndex에만 있다 [ASVS v5.0.0-2.1.2]', () => {
    const p = parseEventSeatMapFile(EVENT, validFile());
    expect(p.sections).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 2 },
      { sectionIndex: 1, sectionId: 'SEC-B', from: 10, to: 11 },
    ]);
    expect([...p.byId.keys()].sort()).toEqual(['A01', 'A02', 'B01', 'B02']);
    expect(p.byId.get('A01')).toEqual(A01);
    expect(p.byId.get('A02')).toEqual(A02);
    expect(p.byId.get('B01')).toEqual(B01);
    expect(p.byId.get('B02')).toEqual(B02);
    expect(p.byId.has('A03')).toBe(false);
    expect([...p.byIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 10, 11]);
    expect(p.byIndex.get(2)).toEqual(A03);
    expect(p.byIndex.get(10)).toEqual(B01);
    // 색인 3 ~ 9는 판에 좌석이 없는 자리다
    expect(p.byIndex.has(5)).toBe(false);
  });

  test('ST30_판매 제외 표시(unavailable)는 돌려주는 SeatRef에 싣지 않는다. unavailable이 true일 때만 판매 제외다(false·없음은 고를 수 있다)', () => {
    const p = parseEventSeatMapFile(EVENT, file([section('SEC-A', 0, 3, [seat('A01', 0, { unavailable: true }), seat('A02', 1, { unavailable: false }), seat('A03', 2), seat('A04', 3, { unavailable: true })])]));
    expect([...p.byId.keys()].sort()).toEqual(['A02', 'A03']);
    expect([...p.byIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (const r of [...p.byId.values(), ...p.byIndex.values()]) expect(r).not.toHaveProperty('unavailable');
    expect(p.byIndex.get(0)).toEqual({ seatId: 'A01', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' });
  });

  test('FR010_설정: 판 번호는 글로 config.layoutVersion에, perAccountLimit, saleEndsAt은 saleEndsAtMs, seatCount = 가장 큰 to + 1이다', () => {
    expect(parseEventSeatMapFile(EVENT, validFile()).config).toEqual(CONFIG_V7);
    // 구역이 색인 순서대로 놓여 있지 않아도 seatCount는 가장 큰 to + 1이다(마지막 구역의 to가 아니다)
    const p = parseEventSeatMapFile('ev-9', file([section('SEC-Z', 100, 101, [seat('Z01', 100)]), section('SEC-A', 0, 1, [seat('A01', 0)])], { perAccountLimit: 4, saleEndsAt: '2026-12-01T18:00:00+09:00' }));
    expect(p.config).toEqual({ eventId: 'ev-9', layoutVersion: '7', seatCount: 102, perAccountLimit: 4, saleEndsAtMs: Date.parse('2026-12-01T18:00:00+09:00') });
    // 구역 색인은 배열 차례, sections는 구역 색인 오름차순이다
    expect(p.sections).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-Z', from: 100, to: 101 },
      { sectionIndex: 1, sectionId: 'SEC-A', from: 0, to: 1 },
    ]);
    expect(p.byId.get('Z01')).toMatchObject({ sectionIndex: 0, seatOffset: 0, index: 100 });
    expect(p.byId.get('A01')).toMatchObject({ sectionIndex: 1, seatOffset: 0, index: 0 });
  });

  test('FR010_판 번호와 1인 한도의 경계: layoutVersion 0과 2^32 − 1, perAccountLimit 1과 4는 받는다', () => {
    expect(parseEventSeatMapFile(EVENT, file([secB()], {}, { layoutVersion: 0 })).config.layoutVersion).toBe('0');
    expect(parseEventSeatMapFile(EVENT, file([secB()], {}, { layoutVersion: 2 ** 32 - 1 })).config.layoutVersion).toBe('4294967295');
    expect(parseEventSeatMapFile(EVENT, file([secB()], { perAccountLimit: 1 })).config.perAccountLimit).toBe(1);
    expect(parseEventSeatMapFile(EVENT, file([secB()], { perAccountLimit: 4 })).config.perAccountLimit).toBe(4);
  });

  test('ST30_seatIndexRange가 없는 구역(무대·통로 같은 도형 구역)은 건너뛰되 구역 색인은 sections 배열 차례 그대로다', () => {
    const stage = section('STAGE', undefined, undefined, [], { seatIndexRange: undefined });
    const p = parseEventSeatMapFile(EVENT, file([secA(), stage, secB()]));
    expect(p.sections).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 2 },
      { sectionIndex: 2, sectionId: 'SEC-B', from: 10, to: 11 },
    ]);
    expect(p.byId.get('B01')).toEqual({ ...B01, sectionIndex: 2 });
    expect(p.config.seatCount).toBe(12);
  });

  test('FR010_구역끼리 맞닿은 범위(0~4 다음 5~9)는 겹침이 아니다. 좌석이 없는 구역 범위도 받는다', () => {
    const p = parseEventSeatMapFile(EVENT, file([section('SEC-A', 0, 4, []), section('SEC-B', 5, 9, [seat('B01', 5)])]));
    expect(p.config.seatCount).toBe(10);
    expect(p.byId.get('B01')).toMatchObject({ index: 5, seatOffset: 0, sectionIndex: 1 });
  });
});

describe('parseEventSeatMapFile: 크기 한도(재검토 2026-11-04)', () => {
  test('[ASVS v5.0.0-2.1.1]_구역이 65,535개를 넘으면(구역 표 sectionCount가 u16이라 전체 스냅샷을 만들 수 없다) 받지 않는다. 65,535개는 받는다', () => {
    const sections = (n: number) => Array.from({ length: n }, (_, i) => section(`S${i}`, i, i, [seat(`Z${i}`, i)]));
    expect(codeOf(file(sections(65_535)))).toBe('ok');
    expect(codeOf(file(sections(65_536)))).toBe('BAD_SECTION_RANGE');
  });

  test('[ASVS v5.0.0-2.1.1]_회차 좌석 수(가장 큰 to + 1)가 1,000,000 [가정]을 넘거나 비트 오프셋 한도를 넘는 범위는 받지 않는다. 한도 정확히는 받는다', () => {
    const big = (to: number) => file([section('SEC-A', 0, to, [seat('A01', 0)])]);
    expect(codeOf(big(999_999))).toBe('ok');
    for (const to of [1_000_000, 2 ** 32, Number.MAX_SAFE_INTEGER]) expect(codeOf(big(to)), String(to)).toBe('BAD_SECTION_RANGE');
  });
});

describe('parseEventSeatMapFile: 오류 코드(하나라도 어기면 그 파일 전체를 받지 않는다)', () => {
  test('NOT_OBJECT: 파일 값이 객체가 아니다(null·undefined·글·수·배열)', () => {
    for (const raw of [null, undefined, 'text', 5, true, [], [validFile()]]) expect(codeOf(raw), JSON.stringify(raw) ?? 'undefined').toBe('NOT_OBJECT');
  });

  test('FR010_layout이 없거나 객체가 아니면 받지 않는다(NOT_OBJECT 또는 NO_SECTIONS)', () => {
    for (const raw of [{ perAccountLimit: 2, saleEndsAt: SALE_END }, { perAccountLimit: 2, saleEndsAt: SALE_END, layout: null }, { perAccountLimit: 2, saleEndsAt: SALE_END, layout: 'x' }]) {
      expect(['NOT_OBJECT', 'NO_SECTIONS']).toContain(codeOf(raw));
    }
  });

  test('BAD_LIMIT: 1인 한도는 1~4의 정수여야 한다(0·5·1.5·글·NaN·없음)', () => {
    for (const v of [0, 5, 1.5, -1, '2', Number.NaN, null, undefined, 4.0000001]) expect(codeOf(file([secA()], { perAccountLimit: v })), String(v)).toBe('BAD_LIMIT');
  });

  test('BAD_SALE_END: saleEndsAt이 날짜로 읽히는 글이 아니다(날짜가 아닌 글·빈 글·없음·수·존재하지 않는 날)', () => {
    for (const v of ['not-a-date', '', undefined, null, 1_700_000_000_000, '2026-13-45T00:00:00Z']) expect(codeOf(file([secA()], { saleEndsAt: v })), String(v)).toBe('BAD_SALE_END');
  });

  test('BAD_LAYOUT_VERSION: 판 번호는 0 이상 2^32 − 1 이하의 정수여야 한다(음수·1.5·2^32·글·없음·NaN)', () => {
    for (const v of [-1, 1.5, 2 ** 32, '7', undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) expect(codeOf(file([secA()], {}, { layoutVersion: v })), String(v)).toBe('BAD_LAYOUT_VERSION');
  });

  test('NO_SECTIONS: sections가 비었거나 배열이 아니거나 없다', () => {
    for (const v of [[], undefined, null, 'x', {}]) expect(codeOf(file(v)), JSON.stringify(v) ?? 'undefined').toBe('NO_SECTIONS');
  });

  test('NO_SECTIONS: 비트맵 범위를 가진 구역이 하나도 없으면(모두 seatIndexRange 없음) 회차 좌석 수를 정할 수 없어 받지 않는다', () => {
    expect(codeOf(file([section('STAGE', 0, 0, [], { seatIndexRange: undefined })]))).toBe('NO_SECTIONS');
  });

  test('BAD_SECTION_RANGE: from > to, 음수, 정수가 아님, 한쪽이 없음, 객체가 아님', () => {
    const ranges: unknown[] = [{ from: 5, to: 4 }, { from: -1, to: 3 }, { from: 0, to: -1 }, { from: 0.5, to: 3 }, { from: 0, to: 3.5 }, { from: '0', to: 3 }, { from: 0, to: '3' }, { from: 0 }, { to: 3 }, { from: Number.NaN, to: 3 }, 'x', 5];
    for (const seatIndexRange of ranges) expect(codeOf(file([section('SEC-A', 0, 0, [], { seatIndexRange })])), JSON.stringify(seatIndexRange)).toBe('BAD_SECTION_RANGE');
  });

  test('SECTION_RANGE_OVERLAP: 구역 범위가 서로 겹친다(일부 겹침·포함·같은 범위)', () => {
    for (const [a, b] of [
      [
        [0, 5],
        [5, 8],
      ],
      [
        [0, 10],
        [3, 4],
      ],
      [
        [4, 8],
        [0, 4],
      ],
      [
        [2, 2],
        [2, 2],
      ],
    ] as const) {
      expect(codeOf(file([section('SEC-A', a[0], a[1], []), section('SEC-B', b[0], b[1], [])])), JSON.stringify([a, b])).toBe('SECTION_RANGE_OVERLAP');
    }
  });

  test('BAD_SEAT: 좌석 ID가 좌석 ID 모양(영문·숫자·_·-, 1~64자)이 아니다 [ASVS v5.0.0-1.2.4]', () => {
    for (const seatId of ['', 'a b', 'x'.repeat(65), 'a/b', 'a}b', 'é', 7, undefined, null]) {
      expect(codeOf(file([section('SEC-A', 0, 1, [seat(seatId, 0)])])), JSON.stringify(seatId) ?? 'undefined').toBe('BAD_SEAT');
    }
    // 경계: 64자는 받는다
    expect(codeOf(file([section('SEC-A', 0, 1, [seat('x'.repeat(64), 0)])]))).toBe('ok');
  });

  test('FR010_좌석 색인이 정수가 아니거나 없으면 받지 않는다(BAD_SEAT 또는 SEAT_OUT_OF_RANGE)', () => {
    for (const index of [1.5, '1', undefined, null, Number.NaN]) expect(['BAD_SEAT', 'SEAT_OUT_OF_RANGE'], String(index)).toContain(codeOf(file([section('SEC-A', 0, 3, [seat('A01', index)])])));
  });

  test('SEAT_OUT_OF_RANGE: 좌석 색인이 자기 구역 범위 밖이다(범위 앞·뒤, 다른 구역 범위 안이어도 마찬가지)', () => {
    expect(codeOf(file([section('SEC-A', 2, 5, [seat('A01', 1)])]))).toBe('SEAT_OUT_OF_RANGE');
    expect(codeOf(file([section('SEC-A', 2, 5, [seat('A01', 6)])]))).toBe('SEAT_OUT_OF_RANGE');
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 0)]), section('SEC-B', 10, 12, [seat('B01', 2)])]))).toBe('SEAT_OUT_OF_RANGE');
    expect(codeOf(file([section('SEC-A', 2, 5, [seat('A01', 2), seat('A02', 5)])]))).toBe('ok');
  });

  test('SEAT_ID_DUPLICATE: 좌석 ID가 겹친다(같은 구역·다른 구역·판매 제외석과도)', () => {
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 0), seat('A01', 1)])]))).toBe('SEAT_ID_DUPLICATE');
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 0)]), section('SEC-B', 10, 12, [seat('A01', 10)])]))).toBe('SEAT_ID_DUPLICATE');
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 0, { unavailable: true }), seat('A01', 1)])]))).toBe('SEAT_ID_DUPLICATE');
  });

  test('SEAT_INDEX_DUPLICATE: 좌석 색인이 겹친다(판매 제외석과도)', () => {
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 1), seat('A02', 1)])]))).toBe('SEAT_INDEX_DUPLICATE');
    expect(codeOf(file([section('SEC-A', 0, 3, [seat('A01', 1, { unavailable: true }), seat('A02', 1)])]))).toBe('SEAT_INDEX_DUPLICATE');
  });

  test('NO_TIER: 좌석에도 구역에도 등급(tierId)이 없다. 좌석에만 있거나 구역에만 있으면 받는다', () => {
    expect(codeOf(file([section('SEC-A', 0, 1, [seat('A01', 0)], { tierId: undefined })]))).toBe('NO_TIER');
    expect(codeOf(file([section('SEC-A', 0, 1, [seat('A01', 0, { tierId: 'R' }), seat('A02', 1)], { tierId: undefined })]))).toBe('NO_TIER');
    expect(codeOf(file([section('SEC-A', 0, 1, [seat('A01', 0, { tierId: 'R' }), seat('A02', 1, { tierId: 'S' })], { tierId: undefined })]))).toBe('ok');
    expect(codeOf(file([section('SEC-A', 0, 1, [seat('A01', 0), seat('A02', 1)], { tierId: 'S' })]))).toBe('ok');
  });

  test('BAD_SECTION_ID: 구역 ID가 없거나 빈 글이거나 글이 아니다', () => {
    for (const sectionId of [undefined, '', 7, null]) expect(codeOf(file([section(sectionId, 0, 1, [seat('A01', 0)])])), JSON.stringify(sectionId) ?? 'undefined').toBe('BAD_SECTION_ID');
  });

  test('오류 글과 객체에 좌석 ID가 들어가지 않는다: 좌석 ID가 틀렸든 겹쳤든 범위 밖이든 이유 코드만 알린다 [ASVS v5.0.0-16.2.5]', () => {
    const cases: Array<[SeatMapFileErrorCode, unknown, string]> = [
      ['BAD_SEAT', file([section('SEC-A', 0, 1, [seat('SECRET SEAT/ID-1', 0)])]), 'SECRET SEAT/ID-1'],
      ['SEAT_ID_DUPLICATE', file([section('SEC-A', 0, 3, [seat('DUPSEAT-77', 0), seat('DUPSEAT-77', 1)])]), 'DUPSEAT-77'],
      ['SEAT_OUT_OF_RANGE', file([section('SEC-A', 0, 3, [seat('OORSEAT-88', 9)])]), 'OORSEAT-88'],
      ['SEAT_INDEX_DUPLICATE', file([section('SEC-A', 0, 3, [seat('IDXSEAT-A1', 1), seat('IDXSEAT-B2', 1)])]), 'IDXSEAT-B2'],
      ['NO_TIER', file([section('SEC-A', 0, 1, [seat('TIERSEAT-99', 0)], { tierId: undefined })]), 'TIERSEAT-99'],
    ];
    for (const [code, raw, id] of cases) {
      const err = errorOf(raw);
      expect(err.code).toBe(code);
      expect(err).toBeInstanceOf(Error);
      const dump = [err.message, String(err), JSON.stringify(err, Object.getOwnPropertyNames(err))].join('\n');
      expect(dump, code).not.toContain(id);
      expect(dump, code).toContain(code);
    }
  });
});

// ── (b) LayoutSeatMap ───────────────────────────────────────────────────────────────────────────────────────────

/** 호출 수를 세고 지연·실패를 낼 수 있는 메모리 판 출처. 부를 때마다 복사본을 준다(읽을 때마다 새 객체) */
class FakeSource implements Omit<SeatMapSource, 'stamp'> {
  /** load를 부른 회차 ID들(부른 차례) */
  readonly loads: string[] = [];
  /** 회차 → 파일 값(없으면 파일 없음) */
  readonly files = new Map<string, unknown>();
  /** 회차 → 읽기 실패로 던질 오류 */
  readonly failures = new Map<string, unknown>();
  /** 있으면 load는 이 약속이 풀릴 때까지 기다린 뒤 그때의 파일을 읽는다 */
  gate: Promise<void> | undefined;
  /** 있으면 stamp(회차)가 이 표를 돌려준다(없으면 stamp를 구현하지 않은 출처다). 값 undefined = 파일 없음 */
  stamps: Map<string, string | undefined> | undefined;
  /** stamp를 부른 회차 ID들 */
  readonly stampCalls: string[] = [];

  /** stamps를 켜면 LayoutSeatMap이 부르는 stamp 메서드가 된다(켜기 전에는 구현하지 않은 출처처럼 undefined) */
  get stamp(): ((eventId: string) => Promise<string | undefined>) | undefined {
    const stamps = this.stamps;
    if (!stamps) return undefined;
    return async (eventId) => {
      this.stampCalls.push(eventId);
      return stamps.get(eventId);
    };
  }

  async load(eventId: string): Promise<unknown | undefined> {
    this.loads.push(eventId);
    if (this.gate) await this.gate;
    if (this.failures.has(eventId)) throw this.failures.get(eventId);
    const v = this.files.get(eventId);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown);
  }

  count(eventId: string): number {
    return this.loads.filter((e) => e === eventId).length;
  }
}

/** 열고 닫는 문(지연 시험용) */
function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/** 대기 중인 약속이 한 바퀴 돌게 한다 */
const flush = () => new Promise<void>((r) => setImmediate(r));

interface Warn {
  obj: Record<string, unknown>;
  msg: string;
}

function setup(o: { missingTtlMs?: number } = {}) {
  const clock = fakeClock({ now: NOW });
  const source = new FakeSource();
  const warns: Warn[] = [];
  source.files.set(EVENT, validFile());
  const map = new LayoutSeatMap({ source, clock, logger: { warn: (obj, msg) => warns.push({ obj: obj as Record<string, unknown>, msg }) }, ...(o.missingTtlMs !== undefined ? { missingTtlMs: o.missingTtlMs } : {}) });
  return { clock, source, warns, map };
}

describe('LayoutSeatMap: 처음 부를 때만 읽는다', () => {
  test('NFR003_처음 부를 때 한 번 읽고, 이후 config·resolve·byIndex·sections는 파일을 읽지 않는다', async () => {
    const { source, map } = setup();
    expect(source.loads).toEqual([]);
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(source.loads).toEqual([EVENT]);
    await map.resolve(EVENT, ['A01']);
    await map.byIndex(EVENT, [0]);
    await map.sections(EVENT);
    await map.config(EVENT);
    expect(source.loads).toEqual([EVENT]);
  });

  test('NFR003_첫 호출이 resolve·byIndex·sections여도 그것이 읽는다(config를 먼저 부르지 않아도 된다)', async () => {
    for (const first of [(m: LayoutSeatMap) => m.resolve(EVENT, ['A01']), (m: LayoutSeatMap) => m.byIndex(EVENT, [0]), (m: LayoutSeatMap) => m.sections(EVENT)]) {
      const { source, map } = setup();
      await first(map);
      expect(source.loads).toEqual([EVENT]);
      expect(await map.config(EVENT)).toEqual(CONFIG_V7);
      expect(source.loads).toEqual([EVENT]);
    }
  });

  test('NFR003_같은 회차의 동시 첫 요청은 파일을 한 번만 읽는다(single-flight). 읽는 동안 몰린 요청 모두 같은 판을 본다', async () => {
    const { source, map } = setup();
    const gate = deferred();
    source.gate = gate.promise;
    const all = Promise.all([map.config(EVENT), map.resolve(EVENT, ['A01', 'B02']), map.byIndex(EVENT, [10]), map.sections(EVENT), map.config(EVENT), map.resolve(EVENT, ['A02'])]);
    await flush();
    expect(source.loads).toEqual([EVENT]);
    gate.release();
    const [c1, r1, i1, s1, c2, r2] = await all;
    expect(source.loads).toEqual([EVENT]);
    expect(c1).toEqual(CONFIG_V7);
    expect(c2).toEqual(CONFIG_V7);
    expect(r1).toEqual([A01, B02]);
    expect(r2).toEqual([A02]);
    expect(i1).toEqual([B01]);
    expect(s1).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 2 },
      { sectionIndex: 1, sectionId: 'SEC-B', from: 10, to: 11 },
    ]);
  });

  test('NFR003_회차마다 따로 읽는다: 다른 회차는 그 회차의 첫 요청이 한 번씩 읽는다', async () => {
    const { source, map } = setup();
    source.files.set('ev-2', file([section('SEC-C', 0, 1, [seat('C01', 0), seat('C02', 1)])], { perAccountLimit: 3 }, { layoutVersion: 3 }));
    await Promise.all([map.config(EVENT), map.config('ev-2'), map.config(EVENT), map.config('ev-2')]);
    expect([...source.loads].sort()).toEqual([EVENT, 'ev-2']);
    expect(await map.config('ev-2')).toEqual({ eventId: 'ev-2', layoutVersion: '3', seatCount: 2, perAccountLimit: 3, saleEndsAtMs: SALE_END_MS });
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(source.loads).toHaveLength(2);
  });
});

describe('LayoutSeatMap: 없음·틀림·읽기 실패는 missingTtlMs 동안 기억한다', () => {
  test('ST26_③_파일이 없으면 config는 undefined, resolve는 모두 undefined, byIndex도, sections는 undefined이고 1초(기본) 동안 파일을 다시 부르지 않는다. 지나면 다시 부른다', async () => {
    const { source, clock, map } = setup();
    source.files.delete(EVENT);
    expect(await map.config(EVENT)).toBeUndefined();
    expect(await map.resolve(EVENT, ['A01', 'B01'])).toEqual([undefined, undefined]);
    expect(await map.byIndex(EVENT, [0, 1])).toEqual([undefined, undefined]);
    expect(await map.sections(EVENT)).toBeUndefined();
    expect(source.loads).toEqual([EVENT]);
    clock.advance(999);
    expect(await map.config(EVENT)).toBeUndefined();
    expect(await map.sections(EVENT)).toBeUndefined();
    expect(source.loads).toEqual([EVENT]);
    clock.advance(2); // 1001ms
    expect(await map.config(EVENT)).toBeUndefined();
    expect(source.loads).toEqual([EVENT, EVENT]);
    // 그 사이 파일이 생기면 다음 읽기에서 보인다
    source.files.set(EVENT, validFile());
    clock.advance(1_001);
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(source.loads).toHaveLength(3);
    // 이제 읽은 판은 시간이 지나도 다시 읽지 않는다
    clock.advance(10 * 60_000);
    await map.config(EVENT);
    expect(source.loads).toHaveLength(3);
  });

  test('ST26_③_기억 시간은 missingTtlMs 옵션으로 바꾼다', async () => {
    const { source, clock, map } = setup({ missingTtlMs: 5_000 });
    source.files.delete(EVENT);
    await map.config(EVENT);
    clock.advance(4_999);
    await map.config(EVENT);
    expect(source.loads).toHaveLength(1);
    clock.advance(2);
    await map.config(EVENT);
    expect(source.loads).toHaveLength(2);
  });

  test('틀린 판 파일은 없는 것으로 보고(config·sections undefined, resolve·byIndex 모두 undefined) logger.warn 한 줄만 남긴다: 회차 ID와 이유 코드만, 좌석 ID·파일 내용은 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const { source, warns, map } = setup();
    source.files.set(EVENT, file([section('SEC-A', 0, 1, [seat('SEATSECRET-1', 0), seat('SEATSECRET-1', 1)])], { perAccountLimit: 9 }));
    expect(await map.config(EVENT)).toBeUndefined();
    expect(await map.resolve(EVENT, ['SEATSECRET-1'])).toEqual([undefined]);
    expect(await map.byIndex(EVENT, [0])).toEqual([undefined]);
    expect(await map.sections(EVENT)).toBeUndefined();
    expect(warns).toHaveLength(1);
    const text = JSON.stringify(warns);
    expect(text).toContain(EVENT);
    expect(text).toContain('BAD_LIMIT'); // perAccountLimit 9가 먼저 걸리든 좌석 겹침이 먼저 걸리든 코드 하나가 실린다
    expect(text).not.toContain('SEATSECRET-1');
    expect(text).not.toContain('SEC-A');
    // 기억하는 동안은 다시 읽지도, 다시 적지도 않는다
    await map.config(EVENT);
    await map.resolve(EVENT, ['A01']);
    expect(source.loads).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });

  test('틀린 판 파일의 이유 코드는 판 해석의 코드 그대로 한 줄에 싣는다 [ASVS v5.0.0-16.2.5]', async () => {
    const { source, warns, map } = setup();
    source.files.set(EVENT, file([section('SEC-A', 0, 1, [seat('A01', 0), seat('A01', 1)])]));
    await map.config(EVENT);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).toContain('SEAT_ID_DUPLICATE');
    expect(JSON.stringify(warns)).not.toContain('"A01"');
  });

  test('ST26_③_읽기 실패(입출력 오류·JSON 아님)도 던지지 않고 없는 것으로 본다: 1초 동안 기억하고 warn 한 줄(회차 ID만, 오류 글·경로는 싣지 않는다)', async () => {
    const { source, clock, warns, map } = setup();
    source.failures.set(EVENT, new Error('EIO /secret/dir/ev-1.json 내용SECRET'));
    expect(await map.config(EVENT)).toBeUndefined();
    expect(await map.resolve(EVENT, ['A01'])).toEqual([undefined]);
    expect(await map.sections(EVENT)).toBeUndefined();
    expect(source.loads).toEqual([EVENT]);
    expect(warns).toHaveLength(1);
    const text = JSON.stringify(warns);
    expect(text).toContain(EVENT);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/secret');
    clock.advance(1_001);
    source.failures.delete(EVENT);
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(source.loads).toHaveLength(2);
  });

  test('ST26_③_회차 ID가 달라도 서로 영향을 주지 않는다: 없는 회차를 기억하는 동안에도 있는 회차는 읽는다', async () => {
    const { source, map } = setup();
    expect(await map.config('ev-none')).toBeUndefined();
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(source.loads).toEqual(['ev-none', EVENT]);
  });
});

describe('LayoutSeatMap: 없음 기억은 무한히 늘지 않는다(재검토 2026-11-04)', () => {
  test('NFR003_서로 다른 없는 회차를 많이 물어도 기억은 1,024개를 넘지 않는다: 가장 오래된 기억부터 잊어 그 회차는 다시 출처를 부른다', async () => {
    const { source, map } = setup();
    for (let i = 0; i < 1100; i++) await map.config(`none-${i}`);
    expect(source.count('none-0')).toBe(1); // 처음 한 번
    await map.config('none-0'); // TTL 안이지만 이미 잊었다
    expect(source.count('none-0')).toBe(2);
    const last = source.count('none-1099');
    await map.config('none-1099'); // 최근 것은 기억하고 있다
    expect(source.count('none-1099')).toBe(last);
  });
});

describe('LayoutSeatMap: resolve·byIndex·sections', () => {
  test('ST30_resolve: 입력과 같은 길이·차례이고, 판에 없는 좌석·판매 제외석·다른 회차의 좌석은 그 자리가 undefined이며 판매 제외 표시를 싣지 않는다', async () => {
    const { source, map } = setup();
    source.files.set('ev-2', file([section('SEC-C', 0, 1, [seat('C01', 0)])]));
    await map.config('ev-2');
    const out = await map.resolve(EVENT, ['B01', 'A01', 'NOPE', 'A03', 'C01', 'A02']);
    expect(out).toHaveLength(6);
    expect(out).toEqual([B01, A01, undefined, undefined, undefined, A02]);
    for (const r of out) if (r) expect(r).not.toHaveProperty('unavailable');
    // 그 회차 안에서는 C01이 있는 좌석이다
    expect(await map.resolve('ev-2', ['C01', 'A01'])).toEqual([{ seatId: 'C01', index: 0, sectionId: 'SEC-C', sectionIndex: 0, seatOffset: 0, tierId: 'R' }, undefined]);
  });

  test('ST30_resolve: 같은 ID가 두 번 오면 두 자리 모두 같은 좌석이고, 빈 입력은 빈 결과다', async () => {
    const { map } = setup();
    expect(await map.resolve(EVENT, ['A01', 'A01', 'B02'])).toEqual([A01, A01, B02]);
    expect(await map.resolve(EVENT, [])).toEqual([]);
    expect(await map.byIndex(EVENT, [])).toEqual([]);
  });

  test('ST30_resolve: 모르는 회차는 모두 undefined다', async () => {
    const { map } = setup();
    expect(await map.resolve('ev-unknown', ['A01', 'B01'])).toEqual([undefined, undefined]);
  });

  test('ST35_byIndex: 입력과 같은 길이·차례이고 판매 제외석도 좌석을 준다(잡힌 뒤 제외된 좌석도 풀어야 한다). 판에 없는 색인·범위 밖은 undefined이고 판매 제외 표시를 싣지 않는다', async () => {
    const { map } = setup();
    const out = await map.byIndex(EVENT, [11, 2, 5, 0, 99, -1, 2]);
    expect(out).toEqual([B02, A03, undefined, A01, undefined, undefined, A03]);
    for (const r of out) if (r) expect(r).not.toHaveProperty('unavailable');
    expect(await map.byIndex('ev-unknown', [0])).toEqual([undefined]);
  });

  test('ST26_③_sections: seatIndexRange가 있는 구역만, 구역 색인 오름차순이다. 스냅샷 API의 구역 수 검사가 이것을 본다', async () => {
    const { source, map } = setup();
    source.files.set(EVENT, file([secA(), section('STAGE', 0, 0, [], { seatIndexRange: undefined }), secB()]));
    expect(await map.sections(EVENT)).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 2 },
      { sectionIndex: 2, sectionId: 'SEC-B', from: 10, to: 11 },
    ]);
  });
});

describe('LayoutSeatMap.refresh: 읽은 회차를 다시 읽어 바꾼다', () => {
  /** 판 번호 8: A02가 판매 제외로 바뀌고 A04가 늘었다 */
  const fileV8 = () =>
    file([section('SEC-A', 0, 3, [seat('A01', 0), seat('A02', 1, { unavailable: true }), seat('A03', 2), seat('A04', 3)]), secB()], { perAccountLimit: 3 }, { layoutVersion: 8 });

  test('ST26_③_판 번호를 올린 파일을 다시 읽으면 새 판이 보인다(config·resolve·byIndex·sections 모두)', async () => {
    const { source, map } = setup();
    expect((await map.config(EVENT))?.layoutVersion).toBe('7');
    source.files.set(EVENT, fileV8());
    await map.refresh();
    expect(source.count(EVENT)).toBe(2);
    expect(await map.config(EVENT)).toEqual({ eventId: EVENT, layoutVersion: '8', seatCount: 12, perAccountLimit: 3, saleEndsAtMs: SALE_END_MS });
    expect(await map.resolve(EVENT, ['A02', 'A03', 'A04'])).toEqual([undefined, { ...A03, tierId: 'R' }, { seatId: 'A04', index: 3, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 3, tierId: 'R' }]);
    expect((await map.byIndex(EVENT, [1]))[0]).toMatchObject({ seatId: 'A02' }); // 판매 제외석도 색인으로는 찾는다
    expect(await map.sections(EVENT)).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 3 },
      { sectionIndex: 1, sectionId: 'SEC-B', from: 10, to: 11 },
    ]);
  });

  test('ST26_③_읽은 회차를 모두 다시 읽는다(읽지 않은 회차는 읽지 않는다)', async () => {
    const { source, map } = setup();
    source.files.set('ev-2', file([section('SEC-C', 0, 1, [seat('C01', 0)])]));
    source.files.set('ev-3', file([section('SEC-D', 0, 1, [seat('D01', 0)])]));
    await map.config(EVENT);
    await map.config('ev-2');
    source.loads.length = 0;
    await map.refresh();
    expect([...source.loads].sort()).toEqual([EVENT, 'ev-2']);
  });

  test('다시 읽기가 실패하면(읽기 오류) 이전 판을 그대로 두고 던지지 않으며 warn 한 줄(회차 ID만)을 남긴다 [ASVS v5.0.0-16.2.5]', async () => {
    const { source, warns, map } = setup();
    const before = await map.config(EVENT);
    source.failures.set(EVENT, new Error('EIO /secret/dir/ev-1.json 내용SECRET'));
    await expect(map.refresh()).resolves.toBeUndefined();
    expect(await map.config(EVENT)).toEqual(before);
    expect(await map.resolve(EVENT, ['A01'])).toEqual([A01]);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).toContain(EVENT);
    expect(JSON.stringify(warns)).not.toContain('SECRET');
    // 고쳐지면 다음 다시 읽기가 받는다
    source.failures.delete(EVENT);
    source.files.set(EVENT, fileV8());
    await map.refresh();
    expect((await map.config(EVENT))?.layoutVersion).toBe('8');
  });

  test('다시 읽은 파일이 틀렸으면(검사 실패) 이전 판을 그대로 두고 던지지 않으며 warn 한 줄(회차 ID와 이유 코드)을 남긴다 [ASVS v5.0.0-16.2.5]', async () => {
    const { source, warns, map } = setup();
    const before = await map.config(EVENT);
    source.files.set(EVENT, file([section('SEC-A', 0, 1, [seat('SEATSECRET-2', 0), seat('SEATSECRET-2', 1)])], {}, { layoutVersion: 9 }));
    await expect(map.refresh()).resolves.toBeUndefined();
    expect(await map.config(EVENT)).toEqual(before);
    expect(await map.resolve(EVENT, ['A01', 'SEATSECRET-2'])).toEqual([A01, undefined]);
    expect(warns).toHaveLength(1);
    const text = JSON.stringify(warns);
    expect(text).toContain(EVENT);
    expect(text).toContain('SEAT_ID_DUPLICATE');
    expect(text).not.toContain('SEATSECRET-2');
  });

  test('NFR003_판 번호와 설정이 같으면 좌석 표를 새로 만들지 않는다(같은 SeatRef 객체를 그대로 준다). 판 번호가 오르면 새 표다', async () => {
    const { source, map } = setup();
    const [a1] = await map.resolve(EVENT, ['A01']);
    const [i2] = await map.byIndex(EVENT, [2]);
    expect(a1).toEqual(A01);
    // 같은 객체를 두 번 받는다(요청마다 복사하지 않는다)
    expect((await map.resolve(EVENT, ['A01']))[0]).toBe(a1);
    // 같은 내용의 파일을 다시 읽어도 표는 그대로다
    await map.refresh();
    expect(source.count(EVENT)).toBe(2);
    expect((await map.resolve(EVENT, ['A01']))[0]).toBe(a1);
    expect((await map.byIndex(EVENT, [2]))[0]).toBe(i2);
    // 판 번호를 올린 파일은 새 표다
    source.files.set(EVENT, file([secA(), secB()], {}, { layoutVersion: 8 }));
    await map.refresh();
    const [a2] = await map.resolve(EVENT, ['A01']);
    expect(a2).toEqual(A01);
    expect(a2).not.toBe(a1);
    expect((await map.config(EVENT))?.layoutVersion).toBe('8');
  });

  test('NFR003_다시 읽는 도중에도 요청은 이전 판을 본다(기다리지 않는다). 다 읽으면 새 판이다', async () => {
    const { source, map } = setup();
    await map.config(EVENT);
    const gate = deferred();
    source.gate = gate.promise;
    source.files.set(EVENT, fileV8());
    const pending = map.refresh();
    await flush();
    expect(source.count(EVENT)).toBe(2); // 다시 읽기가 시작됐고 문에 걸려 있다
    // 기다리지 않고 이전 판(판 번호 7)을 본다
    expect(await map.config(EVENT)).toEqual(CONFIG_V7);
    expect(await map.resolve(EVENT, ['A02'])).toEqual([A02]);
    expect(await map.sections(EVENT)).toHaveLength(2);
    expect(source.count(EVENT)).toBe(2);
    gate.release();
    await pending;
    expect((await map.config(EVENT))?.layoutVersion).toBe('8');
    expect(await map.resolve(EVENT, ['A02'])).toEqual([undefined]);
  });
});

// ── (c) FileSeatMapSource ───────────────────────────────────────────────────────────────────────────────────────

describe('LayoutSeatMap.refresh: 파일 표시(stamp)가 같으면 다시 읽지 않는다', () => {
  const fileV8 = () => file([section('SEC-A', 0, 3, [seat('A01', 0), seat('A02', 1), seat('A03', 2), seat('A04', 3)]), secB()], {}, { layoutVersion: 8 });

  test('NFR003_ST26_③_표시가 처음과 같으면 refresh가 파일을 읽지 않고 옛 판이 남는다. 표시가 바뀌면 읽어 새 판(판 번호 8)이 보인다', async () => {
    const { source, map } = setup();
    source.stamps = new Map([[EVENT, 'm1:100']]);
    await map.config(EVENT);
    expect(source.stampCalls).toEqual([EVENT]);
    source.loads.length = 0;
    source.files.set(EVENT, fileV8()); // 내용은 바뀌었지만 표시는 같다(바뀐 것으로 보이지 않는다)
    await map.refresh();
    expect(source.loads).toEqual([]);
    expect((await map.config(EVENT))?.layoutVersion).toBe('7');
    source.stamps.set(EVENT, 'm2:150');
    await map.refresh();
    expect(source.loads).toEqual([EVENT]);
    expect((await map.config(EVENT))?.layoutVersion).toBe('8');
    // 새 표시를 기억한다: 같은 표시로 다시 refresh하면 읽지 않는다
    source.loads.length = 0;
    await map.refresh();
    expect(source.loads).toEqual([]);
  });

  test('ST26_③_표시가 없어졌는데(undefined) 읽어도 파일이 없으면 이전 판을 그대로 두고 warn 한 줄(FILE_GONE, 회차 ID만)을 남긴다. 파일이 돌아오면 다시 받는다', async () => {
    const { source, warns, map } = setup();
    source.stamps = new Map([[EVENT, 'm1:100']]);
    const before = await map.config(EVENT);
    source.files.delete(EVENT);
    source.stamps.set(EVENT, undefined);
    await map.refresh();
    expect(await map.config(EVENT)).toEqual(before);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toEqual({ eventId: EVENT, code: 'FILE_GONE' });
    source.files.set(EVENT, fileV8());
    source.stamps.set(EVENT, 'm3:200');
    await map.refresh();
    expect((await map.config(EVENT))?.layoutVersion).toBe('8');
  });

  test('NFR003_표시를 읽다 실패하면(던짐) 이전 판을 그대로 두고 던지지 않으며 warn 한 줄이다', async () => {
    const { source, warns, map } = setup();
    source.stamps = new Map([[EVENT, 'm1:100']]);
    const before = await map.config(EVENT);
    Object.defineProperty(source, 'stamp', {
      configurable: true,
      get: () => async () => {
        throw new Error('EACCES /secret/내용SECRET');
      },
    });
    await expect(map.refresh()).resolves.toBeUndefined();
    expect(await map.config(EVENT)).toEqual(before);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain('SECRET');
  });
});

describe('FileSeatMapSource: 폴더의 {eventId}.json을 읽는다', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'peaket-seatmap-'));
    dir = join(root, 'maps');
    await mkdir(dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('ST26_③_파일을 읽어 JSON을 풀어 준다. 파일이 없으면 undefined다', async () => {
    const src = new FileSeatMapSource(dir);
    await writeFile(join(dir, 'ev-1.json'), JSON.stringify(validFile()), 'utf8');
    expect(await src.load('ev-1')).toEqual(validFile());
    expect(await src.load('ev-none')).toBeUndefined();
    // 64자 회차 ID도 읽는다(KEY_PART 경계)
    const long = 'x'.repeat(64);
    await writeFile(join(dir, `${long}.json`), '{"a":1}', 'utf8');
    expect(await src.load(long)).toEqual({ a: 1 });
  });

  test('NFR003_stamp는 파일이 바뀌면(크기가 달라지면) 달라지고, 같으면 같고, 파일이 없으면 undefined다. KEY_PART가 아닌 회차 ID는 undefined다', async () => {
    const src = new FileSeatMapSource(dir);
    expect(await src.stamp('ev-1')).toBeUndefined();
    await writeFile(join(dir, 'ev-1.json'), JSON.stringify(validFile()), 'utf8');
    const first = await src.stamp('ev-1');
    expect(first).toEqual(expect.any(String));
    expect(await src.stamp('ev-1')).toBe(first);
    await writeFile(join(dir, 'ev-1.json'), `${JSON.stringify(validFile())} `, 'utf8');
    expect(await src.stamp('ev-1')).not.toBe(first);
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65)]) expect(await src.stamp(bad), JSON.stringify(bad)).toBeUndefined();
  });

  test('ST26_③_JSON이 아니면 undefined가 아니라 던진다(없는 파일과 읽지 못한 파일을 가른다)', async () => {
    const src = new FileSeatMapSource(dir);
    await writeFile(join(dir, 'bad.json'), '{ not json', 'utf8');
    await writeFile(join(dir, 'empty.json'), '', 'utf8');
    await expect(src.load('bad')).rejects.toThrow();
    await expect(src.load('empty')).rejects.toThrow();
  });

  test('회차 ID가 KEY_PART 모양이 아니면(../x, a/b, 빈 글, 65자 …) 파일에 닿지 않고 undefined다. 폴더 밖의 파일을 읽지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const src = new FileSeatMapSource(dir);
    const secret = JSON.stringify({ secret: true });
    await writeFile(join(root, 'x.json'), secret, 'utf8'); // 폴더 밖
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'a', 'b.json'), secret, 'utf8'); // 하위 폴더
    await writeFile(join(dir, '.json'), secret, 'utf8'); // 빈 회차 ID
    await writeFile(join(dir, `${'x'.repeat(65)}.json`), secret, 'utf8'); // 65자
    await writeFile(join(dir, 'a.b.json'), secret, 'utf8');
    await writeFile(join(dir, 'ev 1.json'), secret, 'utf8');
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a.b', 'ev 1', '..', '.', 'é', '/etc/passwd', 'C:\\x']) {
      expect(await src.load(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  // ── list(BUILD_ORDER PRF-164, 다시 만들기 반복의 회차 목록 SeatMapEventCatalog가 쓴다) ──
  test('ST26_list는 폴더의 {회차 ID}.json에서 .json을 뗀 회차 ID들을 이름 오름차순(문자 코드 순)으로 준다. 파일 내용은 읽지 않는다(JSON이 아니어도 목록에 든다) [S-T26]', async () => {
    const src = new FileSeatMapSource(dir);
    const ids = ['b', 'a_1', 'a1', 'a-1', '0190f3a1-7c2e-7a00-8000-0000000000e1', 'x'.repeat(64)];
    for (const id of ids) await writeFile(join(dir, `${id}.json`), JSON.stringify(validFile()), 'utf8');
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    // 문자 코드 순: '-'(45) < '1'(49) < '_'(95) < 'b'(98). localeCompare 차례가 아니다
    expect(await src.list()).toEqual(['0190f3a1-7c2e-7a00-8000-0000000000e1', 'a-1', 'a1', 'a_1', 'b', 'broken', 'x'.repeat(64)]);
  });

  test('ST26_list는 KEY_PART 모양이 아닌 이름·다른 확장자(대문자 .JSON 포함)·하위 폴더(이름이 .json이어도)·하위 폴더 안 파일·폴더 밖 파일을 뺀다 [ASVS v5.0.0-1.2.4]', async () => {
    const src = new FileSeatMapSource(dir);
    const body = JSON.stringify(validFile());
    await writeFile(join(dir, 'ev-1.json'), body, 'utf8');
    await writeFile(join(root, 'outside.json'), body, 'utf8'); // 폴더 밖
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'nested.json'), body, 'utf8'); // 하위 폴더 안
    await mkdir(join(dir, 'folder.json')); // 이름이 .json인 하위 폴더
    for (const name of ['.json', `${'x'.repeat(65)}.json`, 'a.b.json', 'ev 1.json', 'é.json', 'ev-2.JSON', 'ev-3.Json', 'ev-4.json.bak', 'ev-5.txt', 'ev-6', 'README']) {
      await writeFile(join(dir, name), body, 'utf8');
    }
    expect(await src.list()).toEqual(['ev-1']);
  });

  test('ST26_list는 빈 폴더면 []이고, 폴더가 없으면(ENOENT) 던진다 [ASVS v5.0.0-16.5.2]', async () => {
    expect(await new FileSeatMapSource(dir).list()).toEqual([]);
    await expect(new FileSeatMapSource(join(root, 'missing')).list()).rejects.toThrow();
  });
});

// ── (d) MemorySeatMap.sections ─────────────────────────────────────────────────────────────────────────────────

describe('MemorySeatMap.sections', () => {
  const def = (seatId: string, index: number, sectionIndex: number, sectionId: string, over: { saleExcluded?: boolean } = {}) => ({
    seatId,
    index,
    sectionId,
    sectionIndex,
    seatOffset: 0,
    tierId: 'R',
    ...over,
  });
  const cfg = (eventId: string): EventSeatConfig => ({ eventId, layoutVersion: 'v1', seatCount: 40, perAccountLimit: 4, saleEndsAtMs: NOW + 3600_000 });

  test('ST26_③_put한 좌석을 구역 색인별로 묶어 가장 작은 색인 ~ 가장 큰 색인을 범위로 준다(판매 제외석 포함). 구역 색인 오름차순이다', async () => {
    const m = new MemorySeatMap();
    m.put(cfg('ev-1'), [
      // 일부러 구역·색인 순서를 섞어 넣는다
      def('C02', 25, 2, 'SEC-C', { saleExcluded: true }),
      def('A02', 9, 0, 'SEC-A'),
      def('C01', 20, 2, 'SEC-C'),
      def('A01', 3, 0, 'SEC-A'),
      def('A03', 5, 0, 'SEC-A'),
      def('B01', 12, 1, 'SEC-B', { saleExcluded: true }),
    ]);
    expect(await m.sections('ev-1')).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 3, to: 9 },
      { sectionIndex: 1, sectionId: 'SEC-B', from: 12, to: 12 },
      { sectionIndex: 2, sectionId: 'SEC-C', from: 20, to: 25 },
    ]);
  });

  test('ST26_③_넣지 않은 회차는 undefined이고, 같은 회차를 다시 넣으면 바뀐 판을 준다. 회차끼리 섞이지 않는다', async () => {
    const m = new MemorySeatMap();
    expect(await m.sections('ev-1')).toBeUndefined();
    m.put(cfg('ev-1'), [def('A01', 0, 0, 'SEC-A'), def('A02', 4, 0, 'SEC-A')]);
    m.put(cfg('ev-2'), [def('Z01', 30, 3, 'SEC-Z')]);
    expect(await m.sections('ev-1')).toEqual([{ sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 4 }]);
    expect(await m.sections('ev-2')).toEqual([{ sectionIndex: 3, sectionId: 'SEC-Z', from: 30, to: 30 }]);
    m.put(cfg('ev-1'), [def('A01', 0, 0, 'SEC-A'), def('B01', 10, 1, 'SEC-B')]);
    expect(await m.sections('ev-1')).toEqual([
      { sectionIndex: 0, sectionId: 'SEC-A', from: 0, to: 0 },
      { sectionIndex: 1, sectionId: 'SEC-B', from: 10, to: 10 },
    ]);
    expect(await m.sections('ev-none')).toBeUndefined();
  });
});

// ── (e) 판 파일의 등급 가격 tierPrices(docs/features/payment.md §2 '주문 생성의 첫 구현' 금액, BUILD_ORDER PRF-161) ────────────────────────────────
// 규칙은 seat-layout.ts parseTierPrices 주석이다: 없으면 undefined, 있으면 배열이 아닌 객체·값은 0 이상 int4 이하 정수·등급 ID 1~64자, 판에 없는 등급도 받는다,
// 결과는 얼린 새 객체(자기 속성만, 프로토타입 없음). 틀리면 BAD_TIER_PRICES. LayoutSeatMap의 판 표시에 가격이 들어가 가격만 바뀐 파일도 새 판으로 본다.

/** parseTierPrices를 불러 SeatMapFileError의 코드를 돌려준다(통과하면 'ok'. 다른 오류는 그대로 던진다) */
function priceCodeOf(raw: unknown): SeatMapFileErrorCode | 'ok' {
  try {
    parseTierPrices(raw);
  } catch (e) {
    if (e instanceof SeatMapFileError) return e.code;
    throw e;
  }
  return 'ok';
}

const INT4_MAX = 2_147_483_647;

describe('parseTierPrices: 판 파일의 선택 칸 tierPrices', () => {
  test('FR011_칸이 없으면(undefined) undefined다(기존 판 파일도 그대로 읽힌다)', () => {
    expect(parseTierPrices(undefined)).toBeUndefined();
  });

  test('FR011_등급 ID → 원을 그대로 읽는다. 0원과 int4 상한(2,147,483,647)은 받고, 빈 객체도 받는다', () => {
    expect(parseTierPrices({ R: 110_000, S: 0, VIP: INT4_MAX })).toEqual({ R: 110_000, S: 0, VIP: INT4_MAX });
    expect(parseTierPrices({})).toEqual({});
  });

  test('FR011_판에 없는 등급의 가격이 있어도 받는다(쓰지 않을 뿐이다)', () => {
    expect(parseTierPrices({ R: 1, NOT_IN_LAYOUT: 2 })).toEqual({ R: 1, NOT_IN_LAYOUT: 2 });
  });

  test('FR011_결과는 얼린 새 객체이고 프로토타입이 없다: 받은 값을 고쳐도 결과가 바뀌지 않는다 [ASVS v5.0.0-1.3.3]', () => {
    const raw: Record<string, number> = { R: 1_000 };
    const p = parseTierPrices(raw)!;
    expect(p).not.toBe(raw);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.getPrototypeOf(p)).toBeNull();
    raw.R = 9;
    raw.S = 5;
    expect({ ...p }).toEqual({ R: 1_000 });
  });

  test('FR011_자기 속성만 읽는다: 프로토타입에서 물려받은 칸은 가격이 아니다', () => {
    const raw = Object.assign(Object.create({ INHERITED: 7 }) as Record<string, number>, { R: 1 });
    expect({ ...parseTierPrices(raw)! }).toEqual({ R: 1 });
  });

  test('FR011_BAD_TIER_PRICES: 객체가 아니다(null·배열·글·수·참거짓)', () => {
    for (const raw of [null, [], [1, 2], 'R=1', 1000, true]) expect({ raw, code: priceCodeOf(raw) }).toEqual({ raw, code: 'BAD_TIER_PRICES' });
  });

  test('FR011_BAD_TIER_PRICES: 값이 0 이상 int4 이하 정수가 아니다(음수·소수·글·null·NaN·무한·int4 + 1·안전 정수 밖)', () => {
    for (const v of [-1, 1.5, 0.1, '1000', null, Number.NaN, Number.POSITIVE_INFINITY, INT4_MAX + 1, Number.MAX_SAFE_INTEGER + 2, {}, [1]]) {
      expect({ v, code: priceCodeOf({ R: 1, S: v }) }).toEqual({ v, code: 'BAD_TIER_PRICES' });
    }
  });

  test('FR011_BAD_TIER_PRICES: 등급 ID가 빈 글이거나 64자를 넘는다. 64자는 받는다', () => {
    expect(priceCodeOf({ '': 1 })).toBe('BAD_TIER_PRICES');
    expect(priceCodeOf({ ['T'.repeat(65)]: 1 })).toBe('BAD_TIER_PRICES');
    expect(priceCodeOf({ ['T'.repeat(64)]: 1 })).toBe('ok');
  });

  test('FR011_JSON에서 온 __proto__ 칸도 자기 속성으로 검사한다: 값이 객체면 BAD_TIER_PRICES이고 결과 객체의 프로토타입을 바꾸지 않는다 [ASVS v5.0.0-1.3.3]', () => {
    expect(priceCodeOf(JSON.parse('{"R": 1, "__proto__": {"polluted": 1}}'))).toBe('BAD_TIER_PRICES');
    const ok = parseTierPrices(JSON.parse('{"R": 1}'))!;
    expect(Object.getPrototypeOf(ok)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseEventSeatMapFile: tierPrices를 config.tierPrices에 싣는다', () => {
  test('FR011_tierPrices가 없는 판 파일은 그대로 읽히고 config에 tierPrices 칸이 없다', () => {
    const p = parseEventSeatMapFile(EVENT, validFile());
    expect(p.config).toEqual(CONFIG_V7);
    expect(p.config).not.toHaveProperty('tierPrices');
  });

  test('FR011_tierPrices가 있으면 config.tierPrices로 싣는다(등급 R·VIP·S)', () => {
    const p = parseEventSeatMapFile(EVENT, file([secA(), secB()], { tierPrices: { R: 110_000, VIP: 150_000, S: 88_000 } }));
    expect(p.config).toEqual({ ...CONFIG_V7, tierPrices: { R: 110_000, VIP: 150_000, S: 88_000 } });
  });

  test('FR011_tierPrices가 틀리면 그 파일 전체를 받지 않는다(BAD_TIER_PRICES)', () => {
    for (const tierPrices of [{ R: -1 }, { R: 1.5 }, { R: '1000' }, [100], null, { '': 1 }]) {
      expect({ tierPrices, code: codeOf(file([secA(), secB()], { tierPrices })) }).toEqual({ tierPrices, code: 'BAD_TIER_PRICES' });
    }
  });
});

describe('LayoutSeatMap.saleLayout: 판매 상태 판정의 판매 대상 좌석표(BUILD_ORDER PRF-144, seat-hold §4)', () => {
  test('ST25_ADR0122_ 판매 제외석을 빼고 등급별로 모은다. 등급은 ID 문자 코드 순이고 sellableSeats는 색인 수의 합이다', async () => {
    const { map } = setup();
    expect(await map.saleLayout(EVENT)).toEqual({
      sellableSeats: 4,
      tiers: [
        { tierId: 'R', indexes: [0] },
        { tierId: 'S', indexes: [10, 11] },
        { tierId: 'VIP', indexes: [1] },
      ],
    });
  });

  test('ST25_ADR0122_ 파일에 적힌 차례와 관계없이 색인은 등급 안에서 오름차순이다(구역이 뒤섞여도)', async () => {
    const { source, map } = setup();
    source.files.set('ev-2', file([section('SEC-A', 0, 1, [seat('A01', 0), seat('A02', 1)]), section('SEC-B', 2, 3, [seat('B01', 2, { tierId: 'S' }), seat('B02', 3)])]));
    source.files.set('ev-3', file([section('SEC-A', 0, 1, [seat('A02', 1), seat('A01', 0)])]));
    expect((await map.saleLayout('ev-2'))?.tiers).toEqual([
      { tierId: 'R', indexes: [0, 1, 3] },
      { tierId: 'S', indexes: [2] },
    ]);
    expect((await map.saleLayout('ev-3'))?.tiers).toEqual([{ tierId: 'R', indexes: [0, 1] }]);
  });

  test('ST25_ADR0122_ 판이 없는 회차는 undefined이고 던지지 않는다', async () => {
    const { map } = setup();
    await expect(map.saleLayout('ev-none')).resolves.toBeUndefined();
  });

  test('ST25_ADR0122_ 판마다 한 번만 만든다(같은 판이면 같은 객체, 파일도 다시 읽지 않는다)', async () => {
    const { source, map } = setup();
    const a = await map.saleLayout(EVENT);
    const b = await map.saleLayout(EVENT);
    expect(b).toBe(a);
    expect(source.count(EVENT)).toBe(1);
    await map.refresh();
    expect(await map.saleLayout(EVENT)).toBe(a);
  });

  test('ST25_ADR0122_ 판이 바뀌면 새로 만든다(판매 제외석이 달라지고 좌석이 늘어난 표)', async () => {
    const { source, map } = setup();
    const before = await map.saleLayout(EVENT);
    source.files.set(EVENT, file([section('SEC-A', 0, 3, [seat('A01', 0), seat('A02', 1, { unavailable: true }), seat('A03', 2), seat('A04', 3)]), secB()], {}, { layoutVersion: 8 }));
    await map.refresh();
    const after = await map.saleLayout(EVENT);
    expect(after).not.toBe(before);
    expect(after).toEqual({
      sellableSeats: 5,
      tiers: [
        { tierId: 'R', indexes: [0, 2, 3] },
        { tierId: 'S', indexes: [10, 11] },
      ],
    });
  });
});

describe('parseEventSeatMapFile: 결제 시도의 선택 칸 셋(BUILD_ORDER PRF-191)', () => {
  const ENTRY = '2026-12-20T10:00:00.000Z';

  test('PT26_세 칸이 없으면 config에 칸이 없다(기존 판 파일 그대로)', () => {
    const c = parseEventSeatMapFile(EVENT, validFile()).config;
    for (const k of ['orderName', 'entryOpensAtMs', 'virtualAccountAllowed']) expect(c).not.toHaveProperty(k);
  });

  test('PT26_세 칸을 읽는다: 주문명 글, 입장 시각 밀리초, 가상계좌 불리언(거짓도 값이다)', () => {
    const c = parseEventSeatMapFile(EVENT, file([secA(), secB()], { orderName: '2026 피켓 콘서트', entryOpensAt: ENTRY, virtualAccountAllowed: false })).config;
    expect(c).toEqual({ ...CONFIG_V7, orderName: '2026 피켓 콘서트', entryOpensAtMs: Date.parse(ENTRY), virtualAccountAllowed: false });
  });

  test('PT26_경계: 주문명 100자는 받는다, 입장 시각은 9999년 끝까지 받는다', () => {
    expect(codeOf(file([secA(), secB()], { orderName: 'a'.repeat(100) }))).toBe('ok');
    expect(codeOf(file([secA(), secB()], { orderName: '한'.repeat(100) }))).toBe('ok');
    expect(codeOf(file([secA(), secB()], { entryOpensAt: '9999-12-31T23:59:59.999Z' }))).toBe('ok');
  });

  test.each([
    ['글이 아님', 1],
    ['빈 글', ''],
    ['101자', 'a'.repeat(101)],
    ['줄바꿈', '공연\n티켓'],
    ['양방향 제어', '공연‮티켓'],
    ['폭 없는 공백', '공연​티켓'],
    ['줄 구분자', '공연 티켓'],
    ['한글 채움 문자', '공연ㅤ티켓'],
    ['공백뿐', '   '],
  ])('PT26_주문명 %s는 파일 전체를 받지 않는다(BAD_CHECKOUT_FIELDS) [ASVS v5.0.0-2.2.1]', (_name, orderName) => {
    expect(codeOf(file([secA(), secB()], { orderName }))).toBe('BAD_CHECKOUT_FIELDS');
  });

  test.each([
    ['글이 아님', 1_800_000_000_000],
    ['날짜가 아닌 글', 'tomorrow'],
    ['시간대 없음', '2026-12-20T10:00:00'],
    ['0 이하', '1970-01-01T00:00:00.000Z'],
    ['9999년 넘김', '+010000-01-01T00:00:00.000Z'],
  ])('PT26_입장 시각 %s는 파일 전체를 받지 않는다 [ASVS v5.0.0-2.2.1]', (_name, entryOpensAt) => {
    expect(codeOf(file([secA(), secB()], { entryOpensAt }))).toBe('BAD_CHECKOUT_FIELDS');
  });

  test.each(['true', 1, null])('PT26_가상계좌 값 %s는 불리언이 아니라 받지 않는다 [ASVS v5.0.0-2.2.1]', (virtualAccountAllowed) => {
    expect(codeOf(file([secA(), secB()], { virtualAccountAllowed }))).toBe('BAD_CHECKOUT_FIELDS');
  });
});

describe('LayoutSeatMap: 가격만 바뀐 판 파일도 새 판으로 본다', () => {
  test('PT26_세 선택 칸만 바뀐 파일도 판 서명이 달라 다시 읽으면 새 값이다(BUILD_ORDER PRF-191)', async () => {
    const { source, map } = setup();
    source.files.set(EVENT, file([secA(), secB()], { orderName: '처음 이름' }));
    expect((await map.config(EVENT))?.orderName).toBe('처음 이름');
    source.files.set(EVENT, file([secA(), secB()], { orderName: '바뀐 이름' }));
    await map.refresh();
    expect((await map.config(EVENT))?.orderName).toBe('바뀐 이름');
    source.files.set(EVENT, file([secA(), secB()], { orderName: '바뀐 이름', entryOpensAt: '2026-12-20T10:00:00.000Z' }));
    await map.refresh();
    expect((await map.config(EVENT))?.entryOpensAtMs).toBe(Date.parse('2026-12-20T10:00:00.000Z'));
    source.files.set(EVENT, file([secA(), secB()], { orderName: '바뀐 이름', entryOpensAt: '2026-12-20T10:00:00.000Z', virtualAccountAllowed: false }));
    await map.refresh();
    expect((await map.config(EVENT))?.virtualAccountAllowed).toBe(false);
  });

  test('FR011_NFR003_판 번호·1인 한도·판매 종료가 같고 tierPrices만 바뀐 파일을 다시 읽으면 config.tierPrices가 새 값이다', async () => {
    const { source, map } = setup();
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: 110_000, VIP: 150_000, S: 88_000 } }));
    expect((await map.config(EVENT))?.tierPrices).toEqual({ R: 110_000, VIP: 150_000, S: 88_000 });
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: 120_000, VIP: 150_000, S: 88_000 } }));
    await map.refresh();
    expect((await map.config(EVENT))?.tierPrices).toEqual({ R: 120_000, VIP: 150_000, S: 88_000 });
    expect((await map.config(EVENT))?.layoutVersion).toBe('7');
  });

  test('FR011_가격이 없던 판에 tierPrices를 더하거나 빼도 다시 읽으면 보인다', async () => {
    const { source, map } = setup();
    expect((await map.config(EVENT))?.tierPrices).toBeUndefined();
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: 1_000 } }));
    await map.refresh();
    expect((await map.config(EVENT))?.tierPrices).toEqual({ R: 1_000 });
    source.files.set(EVENT, validFile());
    await map.refresh();
    expect((await map.config(EVENT))?.tierPrices).toBeUndefined();
  });

  test('FR011_NFR003_가격도 같으면 좌석 표를 새로 만들지 않는다(같은 SeatRef 객체)', async () => {
    const { source, map } = setup();
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: 1_000 } }));
    const [a1] = await map.resolve(EVENT, ['A01']);
    await map.refresh();
    expect((await map.resolve(EVENT, ['A01']))[0]).toBe(a1);
  });

  test('FR011_다시 읽은 파일의 tierPrices가 틀리면 이전 판(이전 가격)을 그대로 두고 warn 한 줄(이유 코드 BAD_TIER_PRICES)을 남긴다 [ASVS v5.0.0-16.2.5]', async () => {
    const { source, warns, map } = setup();
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: 1_000 } }));
    expect((await map.config(EVENT))?.tierPrices).toEqual({ R: 1_000 });
    source.files.set(EVENT, file([secA(), secB()], { tierPrices: { R: -5 } }));
    await map.refresh();
    expect((await map.config(EVENT))?.tierPrices).toEqual({ R: 1_000 });
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).toContain('BAD_TIER_PRICES');
  });
});
