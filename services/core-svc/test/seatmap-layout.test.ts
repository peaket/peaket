// 배치본 저장 규칙의 순수 함수(ADR-0260 결정 3~7, docs/features/seat-hold.md §2·§10, S-T38, BUILD_ORDER HOT-240)
import { describe, expect, test } from 'vitest';
import type { CheckedLayout } from '../src/modules/catalog/domain/seatmap-import.js';
import {
  assignIndexes,
  assignSeatIds,
  fanFile,
  fanFileKey,
  geometryChanges,
  geometryLocked,
  labelOf,
  type LayoutDoc,
  layoutVenueId,
  priceTierIssues,
  publishable,
  sectionIdIssues,
  sameTiers,
  SECTION_SEATS_MAX,
  tierIssues,
  versionOfEtag,
} from '../src/modules/catalog/domain/seatmap-layout.js';
import { decodeLayout } from '../../../packages/seatmap/src/layout.js';

const sq = (x: number, y: number, w = 100): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
];
const seats = (sec: string, n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ seatId: `${sec}-1-${i + 1}`, row: '1', number: i + 1, x: 10 + i, y: 10, ...extra }));

function layout(o: Partial<CheckedLayout> = {}): CheckedLayout {
  return {
    canvas: { width: 1000, height: 800 },
    stage: [{ kind: 'RECT', points: sq(400, 0), name: '무대' }],
    sections: [
      { sectionId: 'A', name: 'A구역', shape: { kind: 'POLYGON', points: sq(0, 0) }, tierId: 'R', seats: seats('A', 3) },
      { sectionId: 'B', name: 'B구역', shape: { kind: 'POLYGON', points: sq(200, 0) }, tierId: 'S', seats: seats('B', 2, { tierId: 'VIP' }) },
    ],
    ...o,
  };
}
const TIERS = [
  { tierId: 'VIP', name: 'VIP석', price: 180_000 },
  { tierId: 'R', name: 'R석', price: 150_000 },
  { tierId: 'S', name: 'S석', price: 99_000 },
];
const doc = (l: CheckedLayout = layout()): LayoutDoc => ({ canvas: l.canvas, stage: l.stage ?? [], sections: assignIndexes(l).sections, priceTiers: TIERS });

describe('색인 매기기(ADR-0260 결정 3)', () => {
  test('S-T38 ② 색인을 비우면 서버가 구역 차례대로 0부터 빈틈 없이 매기고 구역 안 차례가 index다 [ASVS v5.0.0-2.2.2]', () => {
    const r = assignIndexes(layout());
    expect(r.issues).toEqual([]);
    expect(r.sections.map((s) => s.seatIndexRange)).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 4 },
    ]);
    expect(r.sections.flatMap((s) => s.seats.map((x) => x.index))).toEqual([0, 1, 2, 3, 4]);
  });

  test('S-T38 ① 구역 차례와 어긋난 범위·앞 구역 끝 + 2에서 시작하는 범위·구역 안 차례와 다른 index는 INDEX_MISMATCH다 [ASVS v5.0.0-2.2.2]', () => {
    const l = layout();
    // 구역 차례와 어긋남: B를 앞에 둔 범위(0~1)를 A에 적는다
    const swapped = assignIndexes({ ...l, sections: [{ ...l.sections[0]!, seatIndexRange: { from: 3, to: 5 } }, l.sections[1]!] });
    expect(swapped.issues).toEqual([{ line: 0, field: 'sections[0].seatIndexRange', code: 'INDEX_MISMATCH' }]);
    // 빈틈: 앞 구역 끝(2) + 2 = 4에서 시작
    const gap = assignIndexes({ ...l, sections: [l.sections[0]!, { ...l.sections[1]!, seatIndexRange: { from: 4, to: 5 } }] });
    expect(gap.issues).toEqual([{ line: 0, field: 'sections[1].seatIndexRange', code: 'INDEX_MISMATCH' }]);
    // 시작만·끝만 보낸 빈틈도 그 칸으로 잡는다
    for (const r of [{ from: 4 }, { to: 5 }]) expect(assignIndexes({ ...l, sections: [l.sections[0]!, { ...l.sections[1]!, seatIndexRange: r }] }).issues.map((i) => i.code)).toEqual(['INDEX_MISMATCH']);
    // 한 칸 겹침(앞 구역 끝과 같은 값에서 시작)도 받지 않는다(경계의 다른 쪽)
    const overlap = assignIndexes({ ...l, sections: [l.sections[0]!, { ...l.sections[1]!, seatIndexRange: { from: 2, to: 3 } }] });
    expect(overlap.issues.map((i) => i.code)).toEqual(['INDEX_MISMATCH']);
    // 구역 안 차례와 다른 index(두 좌석을 바꿔 적음)
    const s0 = l.sections[0]!;
    const wrong = assignIndexes({ ...l, sections: [{ ...s0, seats: s0.seats!.map((x, i) => ({ ...x, index: [1, 0, 2][i] })) }, l.sections[1]!] });
    expect(wrong.issues).toEqual([
      { line: 0, field: 'sections[0].seats[0].index', code: 'INDEX_MISMATCH' },
      { line: 0, field: 'sections[0].seats[1].index', code: 'INDEX_MISMATCH' },
    ]);
    // 맞게 보낸 값은 그대로 받는다(from만 보내도 그 칸만 견준다)
    const right = assignIndexes({ ...l, sections: [{ ...s0, seatIndexRange: { from: 0, to: 2 }, seats: s0.seats!.map((x, i) => ({ ...x, index: i })) }, { ...l.sections[1]!, seatIndexRange: { from: 3 } }] });
    expect(right.issues).toEqual([]);
  });

  test('S-T38 ⑩ 좌석이 없는 구역은 범위가 없고 다음 구역이 그 앞 구역 끝 + 1부터 잇는다, 빈 구역에 범위를 보내면 INDEX_MISMATCH다', () => {
    const l = layout();
    const empty = { sectionId: 'E', name: '빈 구역', shape: { kind: 'POLYGON' as const, points: sq(500, 0) }, seats: [] };
    const r = assignIndexes({ ...l, sections: [l.sections[0]!, empty, l.sections[1]!] });
    expect(r.sections.map((s) => s.seatIndexRange ?? null)).toEqual([{ from: 0, to: 2 }, null, { from: 3, to: 4 }]);
    expect(assignIndexes({ ...l, sections: [{ ...empty, seatIndexRange: { from: 0, to: 0 } }] }).issues.map((i) => i.code)).toEqual(['INDEX_MISMATCH']);
    expect(publishable(doc({ ...l, sections: [l.sections[0]!, empty] }))).toBe(false);
    expect(fanFile(doc({ ...l, sections: [l.sections[0]!, empty] }), 3)).toBeUndefined();
    expect(publishable(doc())).toBe(true);
  });

  test('구역 하나는 65,536석까지이고 65,537석이면 SECTION_TOO_LARGE다(델타 seatOffset u16)', () => {
    const big = (n: number) => layout({ sections: [{ sectionId: 'A', name: 'A', shape: { kind: 'POLYGON', points: sq(0, 0) }, tierId: 'R', seats: Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, row: String(Math.floor(i / 1000)), number: (i % 1000) + 1, x: 1, y: 1 })) }] });
    expect(assignIndexes(big(SECTION_SEATS_MAX)).issues).toEqual([]);
    expect(assignIndexes(big(SECTION_SEATS_MAX + 1)).issues.map((i) => i.code)).toEqual(['SECTION_TOO_LARGE']);
  });
});

describe('등급과 가격 등급(ADR-0260 결정 4)', () => {
  test('S-T38 ① 등급이 없는 좌석은 TIER_MISSING, 가격 등급에 없는 등급은 TIER_UNKNOWN이고 좌석이 쓰지 않는 가격 등급은 받는다 [ASVS v5.0.0-2.2.3]', () => {
    const l = layout();
    const noTier = assignIndexes({ ...l, sections: [{ ...l.sections[0]!, tierId: undefined }] }).sections;
    expect(tierIssues(noTier, TIERS).map((i) => i.code)).toEqual(['TIER_MISSING', 'TIER_MISSING', 'TIER_MISSING']);
    expect(tierIssues(doc().sections, TIERS.filter((t) => t.tierId !== 'VIP'))).toEqual([
      { line: 0, field: 'sections[1].seats[0].tierId', code: 'TIER_UNKNOWN' },
      { line: 0, field: 'sections[1].seats[1].tierId', code: 'TIER_UNKNOWN' },
    ]);
    expect(tierIssues(doc().sections, [...TIERS, { tierId: 'A', name: 'A석', price: 1 }])).toEqual([]);
  });

  test('가격 등급의 등급 ID 겹침은 TIER_DUPLICATE, 제어 문자·공백뿐인 글자는 TEXT_INVALID다', () => {
    expect(priceTierIssues([...TIERS, { tierId: 'R', name: '또 R', price: 1 }])).toEqual([{ line: 0, field: 'priceTiers[3].tierId', code: 'TIER_DUPLICATE' }]);
    expect(priceTierIssues([{ tierId: 'R‮', name: ' ', price: 1 }]).map((i) => i.field)).toEqual(['priceTiers[0].tierId', 'priceTiers[0].name']);
    expect(priceTierIssues(TIERS)).toEqual([]);
  });
});

describe('팬 좌석맵 파일(ADR-0260 결정 6)', () => {
  test('S-T38 ② 팬 파일은 decodeLayout을 지나고 열 위치가 서버가 매긴 index, tiers가 가격 등급의 보이는 순서다 [ASVS v5.0.0-5.3.1]', () => {
    const d = doc();
    const f = fanFile(d, 12)!;
    const decoded = decodeLayout(JSON.parse(JSON.stringify(f)));
    expect(decoded.N).toBe(5);
    expect(f.tiers).toEqual(['VIP', 'R', 'S']);
    for (const s of d.sections) {
      const col = f.sections.find((x) => x.sectionId === s.sectionId)!;
      s.seats.forEach((seat) => {
        const at = seat.index - col.seatIndexRange.from;
        expect(col.seats.seatId[at]).toBe(seat.seatId);
      });
    }
    // 좌석 등급이 구역 등급보다 앞선다(B 구역 좌석은 VIP), 색인은 tiers의 자리다
    expect(f.sections[0]!.seats.tier).toEqual([1, 1, 1]);
    expect(f.sections[1]!.seats.tier).toEqual([0, 0]);
    expect(f.layoutVersion).toBe(12);
    expect(f.canvas).toEqual({ minX: 0, minY: 0, width: 1000, height: 800 });
    expect(f.seatCount).toBe(5);
    expect(f.sections[0]!.seats.number).toEqual(['1', '2', '3']);
  });

  test('S-T38 ⑧ 팬 파일에는 판매 상태·가격·계정 값·편집 값(fillRule·gateZone·level)이 없고 휠체어석 1·판매 제외 2 플래그만 있다 [ASVS v5.0.0-14.2.2]', () => {
    const l = layout();
    const s0 = l.sections[0]!;
    const withAttrs = layout({
      sections: [
        { ...s0, level: '1층', gateZone: 'G1', fillRule: { method: 'COUNT', targetCount: 3 }, seats: s0.seats!.map((x, i) => ({ ...x, wheelchair: i === 0, unavailable: i > 0, gateZone: 'G2' })) },
        l.sections[1]!,
      ],
    });
    const f = fanFile(doc(withAttrs), 1)!;
    expect(f.sections[0]!.seats.flags).toEqual([1, 2, 2]);
    const text = JSON.stringify(f);
    for (const banned of ['gateZone', 'fillRule', 'level', 'price', 'status', 'sold', 'held', 'account', 'G1', 'G2', '1층', '150000', 'R석']) expect(text).not.toContain(banned);
    expect(Object.keys(f).sort()).toEqual(['canvas', 'format', 'layoutVersion', 'seatCount', 'sections', 'stage', 'tiers']);
    expect(Object.keys(f.sections[0]!).sort()).toEqual(['label', 'name', 'seatIndexRange', 'seats', 'sectionId', 'shape']);
    expect(Object.keys(f.sections[0]!.seats).sort()).toEqual(['flags', 'number', 'row', 'seatId', 'tier', 'x', 'y']);
  });

  test('라벨이 없는 구역은 도형 꼭짓점 평균(반올림)이고 한 칸만 있으면 없는 칸만 채운다', () => {
    const shape = { kind: 'POLYGON' as const, points: [[0, 0], [11, 0], [11, 10]] as [number, number][] };
    expect(labelOf({ shape })).toEqual({ x: 7, y: 3 });
    expect(labelOf({ shape, label: { x: 1 } })).toEqual({ x: 1, y: 3 });
    expect(labelOf({ shape, label: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 });
  });

  test('파일 키는 회차 UUID와 1 이상 정수 판만 받고 9 → 10에서도 정수 글로 쓴다 [ASVS v5.0.0-5.3.2]', () => {
    const e = '0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d25';
    expect(fanFileKey(e, 9)).toBe(`v1/events/${e}/seatmap-layouts/9.json`);
    expect(fanFileKey(e, 10)).toBe(`v1/events/${e}/seatmap-layouts/10.json`);
    for (const [id, v] of [['../x', 1], [e, 0], [e, 1.5], [`${e}/..`, 1], [e.toUpperCase(), 1]] as const) expect(() => fanFileKey(id, v)).toThrow();
  });
});

describe('좌석·구역 ID(ADR-0260 결정 2, seat-hold §5 좌석 ID 글)', () => {
  const U1 = '0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d25';
  const U2 = '0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d26';
  const gen = () => {
    let n = 0;
    return () => `0190a8c2-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  };

  test('S-T38 ② 보낸 좌석 ID가 이 배치본에 이미 있는 소문자 UUID면 그대로, 아니면 서버가 새 UUIDv7을 매긴다 [ASVS v5.0.0-2.2.2]', () => {
    const l = layout({
      sections: [
        { sectionId: 'A', name: 'A', shape: { kind: 'POLYGON', points: sq(0, 0) }, tierId: 'R', seats: [
          { seatId: U1, row: '1', number: 1, x: 1, y: 1 },
          { seatId: U1.toUpperCase(), row: '1', number: 2, x: 2, y: 1 },
          { seatId: U2, row: '1', number: 3, x: 3, y: 1 },
          { seatId: 'A-1-4', row: '1', number: 4, x: 4, y: 1 },
          { seatId: '1-가-5', row: '가', number: 5, x: 5, y: 1 },
        ] },
      ],
    });
    // U2는 소문자 UUID지만 이 배치본에 없다(남의 배치본·지운 좌석의 ID를 들고 오지 못한다)
    const out = assignSeatIds(assignIndexes(l).sections, new Set([U1, U2.slice(0, -1) + '9']), gen());
    expect(out.flatMap((s) => s.seats.map((x) => x.seatId))).toEqual([U1, '0190a8c2-0000-7000-8000-000000000001', '0190a8c2-0000-7000-8000-000000000002', '0190a8c2-0000-7000-8000-000000000003', '0190a8c2-0000-7000-8000-000000000004']);
    // 색인과 다른 칸은 그대로다
    expect(out[0]!.seats.map((x) => x.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test('S-T38 ① 구역 ID는 키 조각 꼴(영문·숫자·_·-, 1~64자)이어야 하고 아니면 SECTION_ID_INVALID다 [ASVS v5.0.0-2.2.2]', () => {
    const ids = (sectionId: string) => sectionIdIssues(assignIndexes(layout({ sections: [{ sectionId, name: 'A', shape: { kind: 'POLYGON', points: sq(0, 0) }, seats: [] }] })).sections);
    for (const ok of ['A', 's1', 'floor_1-B', 'x'.repeat(64)]) expect(ids(ok), ok).toEqual([]);
    for (const bad of ['가구역', 'A B', 'A/1', 'x'.repeat(65), 'A.1']) expect(ids(bad), bad).toEqual([{ line: 0, field: 'sections[0].sectionId', code: 'SECTION_ID_INVALID' }]);
  });
});

describe('판·ETag·배치본 ID', () => {
  test('If-Match는 강한 ETag "N"만 받고 0·9·10을 수로 읽는다(앞자리 0·약한 ETag·글자는 판이 아니다)', () => {
    expect(versionOfEtag('"0"')).toBe(0);
    expect(versionOfEtag('"9"')).toBe(9);
    expect(versionOfEtag(' "10" ')).toBe(10);
    for (const bad of ['10', 'W/"10"', '"010"', '"-1"', '""', '"1e3"', '"1.0"', '*']) expect(versionOfEtag(bad)).toBeUndefined();
  });

  test('배치본 ID는 공연 ID에서 정해지는 UUIDv5이고 공연마다 다르다(대소문자 같은 값)', () => {
    const p = '0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d25';
    const v = layoutVenueId(p);
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(layoutVenueId(p.toUpperCase())).toBe(v);
    expect(layoutVenueId('0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d26')).not.toBe(v);
    expect(v).not.toBe(p);
  });
});

describe('오픈 뒤 잠금(ADR-0260 결정 7)', () => {
  const now = new Date('2026-12-01T11:00:00.000Z');
  const round = (openAt: string, cancelled = false) => ({ eventId: 'e', openAt: new Date(openAt), cancelled });

  test('S-T38 ⑤ 승인 이력이 있고 취소되지 않은 회차의 open_at이 지금과 같거나 앞이면 잠기고, 1ms 뒤·취소·승인 이력 없음이면 잠기지 않는다', () => {
    const approved = new Date('2026-11-01T00:00:00Z');
    expect(geometryLocked({ saleApprovedAt: approved, rounds: [round('2026-12-01T11:00:00.000Z')], now })).toBe(true);
    expect(geometryLocked({ saleApprovedAt: approved, rounds: [round('2026-12-01T10:59:59.999Z')], now })).toBe(true);
    expect(geometryLocked({ saleApprovedAt: approved, rounds: [round('2026-12-01T11:00:00.001Z')], now })).toBe(false);
    expect(geometryLocked({ saleApprovedAt: approved, rounds: [round('2026-11-01T11:00:00.000Z', true), round('2026-12-02T11:00:00Z')], now })).toBe(false);
    expect(geometryLocked({ saleApprovedAt: null, rounds: [round('2026-11-01T11:00:00Z')], now })).toBe(false);
  });

  test('S-T38 ⑤ 잠긴 뒤 좌석의 판매 제외·휠체어석·게이트와 구역의 게이트만 바꾸면 바뀐 갈래가 없고, 좌표·좌석 추가·색인·등급·구역 차례는 갈래가 남는다 [ASVS v5.0.0-16.3.3]', () => {
    const base = doc();
    const edit = (f: (d: LayoutDoc) => void) => {
      const d = structuredClone(base);
      f(d);
      return geometryChanges(base, d);
    };
    expect(
      edit((d) => {
        d.sections[0]!.gateZone = 'G9';
        d.sections[0]!.seats[0]!.unavailable = true;
        d.sections[0]!.seats[1]!.wheelchair = true;
        d.sections[1]!.seats[0]!.gateZone = 'G3';
      }),
    ).toEqual([]);
    expect(edit((d) => void (d.sections[0]!.seats[0]!.x += 1))).toEqual(['SEAT_GEOMETRY']);
    expect(edit((d) => void (d.sections[0]!.seats[0]!.tierId = 'S'))).toEqual(['SEAT_GEOMETRY']);
    expect(edit((d) => void d.sections[1]!.seats.push({ seatId: 'B-1-3', index: 5, row: '1', number: 3, x: 1, y: 1 }))).toEqual(['SEAT_SET']);
    expect(edit((d) => void d.sections[1]!.seats.pop())).toEqual(['SEAT_SET']);
    expect(edit((d) => void (d.sections[0]!.seats[0]!.index = 9))).toEqual(['SEAT_SET']);
    // 구역 등급은 그 구역 좌석의 실제 등급으로 견준다(A 구역 좌석은 등급 표기가 없어 실제 등급이 바뀐다)
    expect(edit((d) => void (d.sections[0]!.tierId = 'S'))).toEqual(['SEAT_GEOMETRY']);
    expect(edit((d) => void (d.sections[0]!.label = { x: 5 }))).toEqual(['SECTION_GEOMETRY']);
    expect(edit((d) => void d.sections.reverse())).toEqual(['SECTION_SET']);
    expect(edit((d) => void (d.canvas.width = 999))).toEqual(['CANVAS']);
    expect(edit((d) => void (d.stage = []))).toEqual(['STAGE']);
  });

  test('S-T38 ⑤ 잠금 비교는 실제 등급(좌석 tierId ?? 구역 tierId)으로 견주어 표기만 옮긴 저장은 바뀐 갈래가 없다', () => {
    const base = doc();
    const moved = structuredClone(base);
    // 구역 A의 등급 표기를 좌석으로 옮긴다(실제 등급은 모두 R 그대로)
    delete moved.sections[0]!.tierId;
    for (const s of moved.sections[0]!.seats) s.tierId = 'R';
    expect(geometryChanges(base, moved)).toEqual([]);
    // 구역 B는 좌석 등급(VIP)이 있어 구역 표기를 바꿔도 실제 등급이 그대로다
    const b = structuredClone(base);
    b.sections[1]!.tierId = 'R';
    expect(geometryChanges(base, b)).toEqual([]);
    const real = structuredClone(base);
    real.sections[1]!.seats[0]!.tierId = 'S';
    expect(geometryChanges(base, real)).toEqual(['SEAT_GEOMETRY']);
  });

  test('가격 등급은 차례·이름·가격까지 같아야 같다', () => {
    expect(sameTiers(TIERS, structuredClone(TIERS))).toBe(true);
    expect(sameTiers(TIERS, [TIERS[1]!, TIERS[0]!, TIERS[2]!])).toBe(false);
    expect(sameTiers(TIERS, TIERS.map((t, i) => (i === 2 ? { ...t, price: t.price + 1 } : t)))).toBe(false);
    expect(sameTiers(TIERS, TIERS.slice(0, 2))).toBe(false);
  });
});
