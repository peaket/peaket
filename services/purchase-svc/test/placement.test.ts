// 큰 회차의 좌석 Redis 배치 규칙(domain/placement.ts, ADR-0176 결정 3, docs/data.md §3 '큰 회차 배치 규칙', seat-hold.md §8, BUILD_ORDER PRF-135).
// 순수 함수라 시계·Redis 없이 본다. slotOf의 기준값은 Redis 클러스터 명세의 예(123456789 → 0x31C3)와 잘 알려진 CLUSTER KEYSLOT 값이고,
// 시험 쪽 CRC16(XMODEM) 계산(아래 oracleSlot)을 따로 두어 태그를 고를 때 구현에 기대지 않는다. 실제 CLUSTER KEYSLOT과의 대조는 test-int에 있다.
import { describe, expect, test } from 'vitest';
import {
  checkPlacement,
  HASH_SLOTS,
  LARGE_EVENT_SEATS,
  MEDIUM_EVENT_SEATS,
  MEDIUM_EVENTS_PER_PRIMARY,
  PLACEMENT_TAG_MAX_K,
  type PlacementEvent,
  placementTag,
  type SlotRange,
  slotOf,
} from '../src/modules/inventory/index.js';

/** 시험 쪽 CRC16(XMODEM: 다항식 0x1021, 초기값 0) */
function crc16(buf: Uint8Array): number {
  let c = 0;
  for (const b of buf) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c;
}
/** 시험 쪽 슬롯 계산(첫 '{'와 그 뒤 첫 '}' 사이가 한 글자 이상이면 그것만) */
function oracleSlot(key: string): number {
  const s = key.indexOf('{');
  let k = key;
  if (s >= 0) {
    const e = key.indexOf('}', s + 1);
    if (e > s + 1) k = key.slice(s + 1, e);
  }
  return crc16(Buffer.from(k, 'utf8')) % 16384;
}

/** 주 노드 셋(Valkey 클러스터 기본 나눔) */
const RANGES: SlotRange[] = [
  { from: 0, to: 5460, node: 'n1' },
  { from: 5461, to: 10922, node: 'n2' },
  { from: 10923, to: 16383, node: 'n3' },
];
const rangeOf = (node: string) => RANGES.find((r) => r.node === node)!;

/** 그 주 노드에 놓이는 태그(시험 쪽 계산으로 'event:{id}:{k}'의 가장 작은 k) */
function tagOn(eventId: string, node: string): string {
  const r = rangeOf(node);
  for (let k = 0; ; k++) {
    const slot = oracleSlot(`{event:${eventId}:${k}}`);
    if (slot >= r.from && slot <= r.to) return `event:${eventId}:${k}`;
  }
}

const H = 3_600_000;
/** 회차 하나(판매 구간 [from, to), 시 단위) */
const ev = (eventId: string, seats: number, node: string, fromH = 0, toH = 10): PlacementEvent => ({ eventId, tag: tagOn(eventId, node), seats, saleFrom: fromH * H, saleTo: toH * H });
const LARGE = 50_000;
const MEDIUM = 15_000;
const SMALL = 3_000;

describe('slotOf(키의 해시 슬롯)', () => {
  test('NFR021_ slotOf는 CRC16(XMODEM) mod 16384다: 명세의 예 123456789 → 0x31C3과 잘 알려진 CLUSTER KEYSLOT 값(foo 12182, bar 5061, hello 866, somekey 11058), 빈 글은 0', () => {
    expect(HASH_SLOTS).toBe(16384);
    expect(slotOf('123456789')).toBe(0x31c3);
    expect(slotOf('123456789')).toBe(12739);
    expect(slotOf('foo')).toBe(12182);
    expect(slotOf('bar')).toBe(5061);
    expect(slotOf('hello')).toBe(866);
    expect(slotOf('somekey')).toBe(11058);
    expect(slotOf('')).toBe(0);
  });

  test('NFR021_ 해시 태그 규칙의 경계: 첫 {와 그 뒤 첫 } 사이가 한 글자 이상일 때만 그것을 해시하고, 빈 태그 {}·닫는 괄호 없음은 키 전체다', () => {
    expect(slotOf('{user1000}.following')).toBe(slotOf('user1000'));
    expect(slotOf('{user1000}.followers')).toBe(slotOf('{user1000}.following'));
    // 빈 태그: 키 전체(뒤의 {bar}를 보지 않는다)
    expect(slotOf('foo{}{bar}')).toBe(8363);
    expect(slotOf('foo{}{bar}')).not.toBe(slotOf('bar'));
    expect(slotOf('{}')).toBe(15257);
    // 첫 {만: '{bar'를 해시한다
    expect(slotOf('foo{{bar}}zap')).toBe(slotOf('{bar'));
    expect(slotOf('foo{{bar}}zap')).toBe(4015);
    // 닫는 괄호가 없으면 키 전체, 닫는 괄호가 먼저 나오면 그 뒤의 첫 {부터
    expect(slotOf('a{b')).toBe(13340);
    expect(slotOf('}{x}')).toBe(slotOf('x'));
    // 회차 키: 태그 event:E 하나의 슬롯에 모인다
    expect(slotOf('{event:ev-1}:bitmap')).toBe(slotOf('event:ev-1'));
    expect(slotOf('{event:ev-1}:quota:0190f3a1-7c2e-7a00-8000-0000000000a1')).toBe(slotOf('{event:ev-1}:bitmap'));
    // UTF-8 바이트를 해시한다
    expect(slotOf('{한}')).toBe(1867);
    expect(slotOf('한')).toBe(1867);
  });

  test('NFR021_ 여러 키에서 시험 쪽 계산과 같고 늘 0 ~ 16383의 정수다', () => {
    const keys = ['x', 'event:a', 'event:a:0', 'event:a:17', '{event:a:17}', 's:{event:ev-9}:hold:12', 'z'.repeat(200), '{{}}', '{a}{b}', 'a}b{c}'];
    for (let i = 0; i < 200; i++) keys.push(`k-${i}-${(i * 7919).toString(36)}`);
    for (const k of keys) {
      const s = slotOf(k);
      expect({ k, s }).toEqual({ k, s: oracleSlot(k) });
      expect(Number.isInteger(s) && s >= 0 && s < HASH_SLOTS).toBe(true);
    }
  });
});

describe('placementTag(회차 키의 해시 태그 고르기)', () => {
  test('NFR021_ 대형(3만 석 이상)이 아니면 태그는 event:{회차 ID} 그대로이고 목표 범위를 보지 않는다', () => {
    expect(LARGE_EVENT_SEATS).toBe(30_000);
    for (const seats of [1, MEDIUM, LARGE_EVENT_SEATS - 1]) {
      expect(placementTag('ev-1', seats, { from: 0, to: 0 })).toBe('event:ev-1');
      // 대형이 아니면 범위가 틀려도 보지 않는다
      expect(placementTag('ev-1', seats, { from: 9, to: 3 })).toBe('event:ev-1');
    }
  });

  test('NFR021_ 대형이면 태그는 event:{회차 ID}:{k}이고, k는 slotOf({태그})가 목표 범위에 드는 가장 작은 0 이상의 정수다(같은 입력이면 같은 값)', () => {
    for (const node of ['n1', 'n2', 'n3']) {
      const r = rangeOf(node);
      for (const eventId of ['ev-big', 'ev-2026-1104', 'A_b-9']) {
        const tag = placementTag(eventId, LARGE_EVENT_SEATS, r);
        const m = /^event:(.+):(0|[1-9][0-9]*)$/.exec(tag);
        expect({ tag, ok: m !== null && m[1] === eventId }).toEqual({ tag, ok: true });
        const k = Number(m![2]);
        const slot = oracleSlot(`{${tag}}`);
        expect({ tag, inRange: slot >= r.from && slot <= r.to }).toEqual({ tag, inRange: true });
        for (let j = 0; j < k; j++) {
          const sj = oracleSlot(`{event:${eventId}:${j}}`);
          expect({ tag, j, inRange: sj >= r.from && sj <= r.to }).toEqual({ tag, j, inRange: false });
        }
        expect(tag).toBe(tagOn(eventId, node));
        expect(placementTag(eventId, LARGE, r)).toBe(tag);
      }
    }
    // 전체 범위면 k = 0, 슬롯 하나짜리 좁은 범위도 찾는다
    expect(placementTag('ev-big', LARGE, { from: 0, to: 16383 })).toBe('event:ev-big:0');
    const one = placementTag('ev-big', LARGE, { from: 5000, to: 5000 });
    expect(oracleSlot(`{${one}}`)).toBe(5000);
    expect(PLACEMENT_TAG_MAX_K).toBe(1 << 20);
  });

  test('NFR021_ 회차 ID가 키 조각 모양이 아니거나 좌석 수가 1 이상의 정수가 아니거나, 대형인데 목표 범위가 0 ≤ from ≤ to ≤ 16383의 정수가 아니면 RangeError다', () => {
    const r = rangeOf('n1');
    const bad: [string, number, { from: number; to: number }][] = [
      ['ev{1}', LARGE, r],
      ['ev:1', LARGE, r],
      ['', LARGE, r],
      ['x'.repeat(65), LARGE, r],
      ['ev-1', 0, r],
      ['ev-1', -5, r],
      ['ev-1', 1.5, r],
      ['ev-1', Number.NaN, r],
      ['ev-1', LARGE, { from: 10, to: 9 }],
      ['ev-1', LARGE, { from: -1, to: 9 }],
      ['ev-1', LARGE, { from: 0, to: 16384 }],
      ['ev-1', LARGE, { from: 0.5, to: 9 }],
    ];
    for (const [eventId, seats, range] of bad) {
      expect(() => placementTag(eventId, seats, range), JSON.stringify([eventId, seats, range])).toThrow(RangeError);
    }
  });
});

describe('checkPlacement(판매 구간이 겹치는 회차의 주 노드 배치)', () => {
  const check = (target: PlacementEvent, others: PlacementEvent[], slotRanges: readonly SlotRange[] = RANGES) => checkPlacement({ slotRanges, target, others });

  test('NFR021_ 대형 회차는 판매 구간이 겹치는 동안 주 노드에 혼자 둔다: 같은 노드의 대형·중형은 LARGE_ALONE이고, 다른 노드면 된다', () => {
    expect(check(ev('L1', LARGE, 'n1'), [ev('L2', LARGE, 'n2'), ev('M1', MEDIUM, 'n3')])).toEqual({ ok: true, conflicts: [] });
    expect(check(ev('L1', LARGE, 'n1'), [ev('M1', MEDIUM, 'n1'), ev('L2', LARGE, 'n2'), ev('L3', LARGE, 'n1')])).toEqual({
      ok: false,
      conflicts: [{ node: 'n1', events: ['L1', 'M1', 'L3'], rule: 'LARGE_ALONE' }],
    });
  });

  test('NFR021_ 소형(1만 석 미만)은 세지 않는다: 대형과 같은 노드에 있어도, 대상이 소형이어도 위반이 아니다', () => {
    expect(MEDIUM_EVENT_SEATS).toBe(10_000);
    expect(check(ev('L1', LARGE, 'n1'), [ev('S1', SMALL, 'n1'), ev('S2', MEDIUM_EVENT_SEATS - 1, 'n1')])).toEqual({ ok: true, conflicts: [] });
    expect(check(ev('S1', SMALL, 'n1'), [ev('L1', LARGE, 'n1'), ev('M1', MEDIUM, 'n1'), ev('M2', MEDIUM, 'n1'), ev('M3', MEDIUM, 'n1')])).toEqual({ ok: true, conflicts: [] });
  });

  test('NFR021_ 중형 대상은 같은 노드에 판매 구간이 겹치는 중형이 대상 포함 2개까지이고, 넘으면 MEDIUM_PER_PRIMARY 하나다(소형은 세지 않는다)', () => {
    expect(MEDIUM_EVENTS_PER_PRIMARY).toBe(2);
    expect(check(ev('M1', MEDIUM, 'n2'), [ev('M2', MEDIUM, 'n2'), ev('S1', SMALL, 'n2'), ev('M3', MEDIUM, 'n3')])).toEqual({ ok: true, conflicts: [] });
    expect(check(ev('M1', MEDIUM, 'n2'), [ev('M2', MEDIUM, 'n2'), ev('S1', SMALL, 'n2'), ev('M3', MEDIUM, 'n2')])).toEqual({
      ok: false,
      conflicts: [{ node: 'n2', events: ['M1', 'M2', 'M3'], rule: 'MEDIUM_PER_PRIMARY' }],
    });
  });

  test('NFR021_ 중형 대상이 같은 노드의 대형과 겹치면 그 대형마다 LARGE_ALONE이고, 중형 수 위반이 함께면 LARGE_ALONE 다음에 MEDIUM_PER_PRIMARY다', () => {
    expect(check(ev('M1', MEDIUM, 'n3'), [ev('L1', LARGE, 'n3'), ev('M2', MEDIUM, 'n3'), ev('L2', LARGE, 'n3'), ev('M3', MEDIUM, 'n3')])).toEqual({
      ok: false,
      conflicts: [
        { node: 'n3', events: ['M1', 'L1'], rule: 'LARGE_ALONE' },
        { node: 'n3', events: ['M1', 'L2'], rule: 'LARGE_ALONE' },
        { node: 'n3', events: ['M1', 'M2', 'M3'], rule: 'MEDIUM_PER_PRIMARY' },
      ],
    });
  });

  test('NFR021_ 크기 경계: 1만 석부터 중형, 3만 석부터 대형이다', () => {
    // 29,999석은 중형이라 같은 노드의 중형 하나와는 된다
    expect(check(ev('M1', LARGE_EVENT_SEATS - 1, 'n1'), [ev('M2', MEDIUM_EVENT_SEATS, 'n1')])).toEqual({ ok: true, conflicts: [] });
    expect(check(ev('L1', LARGE_EVENT_SEATS, 'n1'), [ev('M2', MEDIUM_EVENT_SEATS, 'n1')]).conflicts.map((c) => c.rule)).toEqual(['LARGE_ALONE']);
    expect(check(ev('L1', LARGE_EVENT_SEATS, 'n1'), [ev('S1', MEDIUM_EVENT_SEATS - 1, 'n1')]).ok).toBe(true);
  });

  test('NFR021_ 판매 구간은 [saleFrom, saleTo) 반열린 구간으로 겹침을 본다: 끝이 맞닿으면 겹치지 않고 1ms라도 겹치면 겹친다', () => {
    const at = (id: string, seats: number, from: number, to: number): PlacementEvent => ({ eventId: id, tag: tagOn(id, 'n1'), seats, saleFrom: from, saleTo: to });
    expect(check(at('L1', LARGE, 0, 10 * H), [at('M1', MEDIUM, 10 * H, 20 * H), at('M2', MEDIUM, -5 * H, 0)])).toEqual({ ok: true, conflicts: [] });
    expect(check(at('L1', LARGE, 0, 10 * H), [at('M1', MEDIUM, 10 * H - 1, 20 * H)]).conflicts).toEqual([{ node: 'n1', events: ['L1', 'M1'], rule: 'LARGE_ALONE' }]);
    expect(check(at('L1', LARGE, 0, 10 * H), [at('M1', MEDIUM, 2 * H, 3 * H)]).ok).toBe(false);
  });

  test('NFR021_ 대상이 끼지 않는 다른 회차끼리의 위반은 내지 않고, 대상과 회차 ID가 같은 것은 뺀다', () => {
    expect(check(ev('L1', LARGE, 'n1'), [ev('L2', LARGE, 'n2'), ev('L3', LARGE, 'n2'), ev('M1', MEDIUM, 'n3'), ev('M2', MEDIUM, 'n3'), ev('M3', MEDIUM, 'n3')])).toEqual({ ok: true, conflicts: [] });
    expect(check(ev('L1', LARGE, 'n1'), [ev('L1', LARGE, 'n1')])).toEqual({ ok: true, conflicts: [] });
  });

  test('NFR021_ 주 노드 하나가 슬롯 범위를 여럿 가지면 어느 범위의 회차든 같은 노드로 본다. 작은 회차 태그(event:E)도 그 슬롯으로 노드를 정한다', () => {
    const split: SlotRange[] = [
      { from: 0, to: 4000, node: 'n1' },
      { from: 4001, to: 9000, node: 'n2' },
      { from: 9001, to: 16383, node: 'n1' },
    ];
    const inN1a = { eventId: 'L1', tag: 'x', seats: LARGE, saleFrom: 0, saleTo: H };
    // 슬롯이 0 ~ 4000·9001 ~ 16383(n1의 두 범위)에 드는 태그를 시험 쪽 계산으로 고른다
    const tagIn = (id: string, lo: number, hi: number) => {
      for (let k = 0; ; k++) {
        const s = oracleSlot(`{event:${id}:${k}}`);
        if (s >= lo && s <= hi) return `event:${id}:${k}`;
      }
    };
    const a = { ...inN1a, tag: tagIn('L1', 0, 4000) };
    const b = { eventId: 'M1', tag: tagIn('M1', 9001, 16383), seats: MEDIUM, saleFrom: 0, saleTo: H };
    expect(checkPlacement({ slotRanges: split, target: a, others: [b] }).conflicts).toEqual([{ node: 'n1', events: ['L1', 'M1'], rule: 'LARGE_ALONE' }]);
    // 작은 회차의 태그 event:E: 슬롯이 n2 범위인 회차 ID를 골라 대형과 같은 노드에 둔다
    let id = '';
    for (let i = 0; ; i++) {
      const s = oracleSlot(`{event:m-${i}}`);
      if (s >= 4001 && s <= 9000) {
        id = `m-${i}`;
        break;
      }
    }
    const big = { eventId: 'L9', tag: tagIn('L9', 4001, 9000), seats: LARGE, saleFrom: 0, saleTo: H };
    const med = { eventId: id, tag: `event:${id}`, seats: MEDIUM, saleFrom: 0, saleTo: H };
    expect(checkPlacement({ slotRanges: split, target: big, others: [med] }).conflicts).toEqual([{ node: 'n2', events: ['L9', id], rule: 'LARGE_ALONE' }]);
  });

  test('NFR021_ 슬롯 범위가 0 ~ 16383을 빠짐없이 한 번씩 덮지 않거나(빈틈·겹침) 끝이 정수가 아니거나 from > to, 회차의 좌석 수가 1 이상의 정수가 아니거나 saleFrom ≥ saleTo면 RangeError다', () => {
    const t = ev('L1', LARGE, 'n1');
    const badRanges: SlotRange[][] = [
      [],
      [{ from: 0, to: 16382, node: 'n1' }],
      [
        { from: 0, to: 100, node: 'n1' },
        { from: 102, to: 16383, node: 'n2' },
      ],
      [
        { from: 0, to: 100, node: 'n1' },
        { from: 100, to: 16383, node: 'n2' },
      ],
      [{ from: 0, to: 16384, node: 'n1' }],
      [{ from: 1, to: 16383, node: 'n1' }],
      [
        { from: 0, to: 0.5, node: 'n1' },
        { from: 1, to: 16383, node: 'n2' },
      ],
      [
        { from: 9000, to: 100, node: 'n1' },
        { from: 0, to: 16383, node: 'n2' },
      ],
    ];
    for (const slotRanges of badRanges) expect(() => checkPlacement({ slotRanges, target: t, others: [] }), JSON.stringify(slotRanges)).toThrow(RangeError);
    const badEvents: PlacementEvent[] = [
      { ...t, seats: 0 },
      { ...t, seats: 1.5 },
      { ...t, saleFrom: 10, saleTo: 10 },
      { ...t, saleFrom: 11, saleTo: 10 },
    ];
    for (const e of badEvents) {
      expect(() => check(e, []), JSON.stringify(e)).toThrow(RangeError);
      expect(() => check(t, [e]), JSON.stringify(e)).toThrow(RangeError);
    }
    // 범위 차례는 상관없다(빠짐없이 한 번씩이면 된다)
    expect(check(t, [], [...RANGES].reverse()).ok).toBe(true);
  });
});
