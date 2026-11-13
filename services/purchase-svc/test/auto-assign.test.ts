// 자동 좌석 배정의 순수 규칙과 메모리 저장소 계약(BUILD_ORDER HOT-080, docs/features/seat-hold.md §3).
// 후보 만들기·희망 조건 검사·멱등 지문은 domain/auto.ts, 저장소 동작은 MemorySeatStore.holdAuto를 본다.
import 'reflect-metadata';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  AUTO_CANDIDATE_PAGE,
  type AutoCondition,
  type AutoHoldInput,
  autoCandidatesOf,
  autoConditionProblem,
  autoFingerprint,
  HOLD_TTL_MS,
  KEEP_AFTER_SALE_END_MS,
  MemorySeatMap,
  MemorySeatStore,
  type SeatRef,
} from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const DAY = 86_400_000;
const EVENT = 'ev-auto';
const ACCOUNT = 'acct-auto';
const SESSION = 'ps-auto';
const LIMIT = 4;

/** 좌석 하나(구역 안 거리는 0부터) */
function seat(prefix: string, n: number, index: number, sectionIndex: number, seatOffset: number, tierId: string, wheelchair = false): SeatRef {
  return { seatId: `${prefix}${String(n).padStart(2, '0')}`, index, sectionId: `SEC-${prefix}`, sectionIndex, seatOffset, tierId, ...(wheelchair ? { wheelchair: true } : {}) };
}

/** R: A01~A06(구역 0, A03 휠체어), S: B01~B04(구역 1) */
const SEATS: SeatRef[] = [
  seat('A', 1, 0, 0, 0, 'R'),
  seat('A', 2, 1, 0, 1, 'R'),
  seat('A', 3, 2, 0, 2, 'R', true),
  seat('A', 4, 3, 0, 3, 'R'),
  seat('A', 5, 4, 0, 4, 'R'),
  seat('A', 6, 5, 0, 5, 'R'),
  seat('B', 1, 10, 1, 0, 'S'),
  seat('B', 2, 11, 1, 1, 'S'),
  seat('B', 3, 12, 1, 2, 'S'),
  seat('B', 4, 13, 1, 3, 'S'),
];
const TIERS = new Set(['R', 'S']);

const cond = (over: Partial<AutoCondition> = {}): AutoCondition => ({ firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false, ...over });

function ids(g: { seats: readonly SeatRef[] }): string[] {
  return g.seats.map((s) => s.seatId);
}

describe('autoFingerprint [ASVS v5.0.0-2.1.1]', () => {
  test('같은 희망 조건은 보낸 차례와 관계없이 같은 지문이고, 조건이 다르면 다른 지문이다', () => {
    const a = cond();
    expect(autoFingerprint({ ...a })).toBe(autoFingerprint(a));
    expect(autoFingerprint({ ...a, count: 1 })).not.toBe(autoFingerprint(a));
    expect(autoFingerprint({ ...a, wheelchair: true })).not.toBe(autoFingerprint(a));
    expect(autoFingerprint({ ...a, allowSplit: true })).not.toBe(autoFingerprint(a));
    expect(autoFingerprint({ ...a, secondTierId: 'S' })).not.toBe(autoFingerprint(a));
    expect(autoFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('autoConditionProblem [ASVS v5.0.0-2.2.3]', () => {
  const wheel = new Map([['R', 1], ['S', 0]]);
  test('없는 등급 400, 같은 등급·휠체어석 없는 등급 422, 매수 초과 422를 가른다', () => {
    expect(autoConditionProblem(cond({ firstTierId: 'X' }), TIERS, wheel, LIMIT)).toBe('UNKNOWN_TIER');
    expect(autoConditionProblem(cond({ secondTierId: 'X' }), TIERS, wheel, LIMIT)).toBe('UNKNOWN_TIER');
    expect(autoConditionProblem(cond({ secondTierId: 'R' }), TIERS, wheel, LIMIT)).toBe('SAME_TIER');
    expect(autoConditionProblem(cond({ count: 5 }), TIERS, wheel, LIMIT)).toBe('COUNT_OVER_LIMIT');
    expect(autoConditionProblem(cond({ count: 0 }), TIERS, wheel, LIMIT)).toBe('COUNT_OVER_LIMIT');
    expect(autoConditionProblem(cond({ wheelchair: true, secondTierId: 'S' }), TIERS, wheel, LIMIT)).toBe('NO_WHEELCHAIR_SEATS');
    expect(autoConditionProblem(cond({ wheelchair: true }), TIERS, wheel, LIMIT)).toBeUndefined();
    expect(autoConditionProblem(cond(), TIERS, wheel, LIMIT)).toBeUndefined();
  });
});

describe('autoCandidatesOf [S-T19] [ASVS v5.0.0-2.2.1]', () => {
  test('1순위 연석 → 1순위 분리 → 2순위 연석 → 2순위 분리 차례로 후보를 만든다', () => {
    const list = autoCandidatesOf(SEATS, cond({ secondTierId: 'S', allowSplit: true }), TIERS);
    expect(list.tiers).toEqual(['R', 'S']);
    expect(list.wheelchairSeats.get('R')).toBe(1);
    const firstFull = list.groups.filter((g) => g.assignResult === 'FIRST' && !g.split);
    expect(firstFull.map(ids)).toEqual([
      ['A01', 'A02'],
      ['A04', 'A05'],
      ['A05', 'A06'],
    ]);
    const firstSplit = list.groups.find((g) => g.assignResult === 'FIRST_SPLIT');
    expect(firstSplit?.split).toBe(true);
    expect(ids(firstSplit!)).toEqual(['A01', 'A02', 'A04', 'A05', 'A06']);
    const secondFull = list.groups.filter((g) => g.assignResult === 'SECOND' && !g.split);
    expect(secondFull.map(ids)).toEqual([
      ['B01', 'B02'],
      ['B02', 'B03'],
      ['B03', 'B04'],
    ]);
    const secondSplit = list.groups.find((g) => g.assignResult === 'SECOND_SPLIT');
    expect(ids(secondSplit!)).toEqual(['B01', 'B02', 'B03', 'B04']);
  });

  test('휠체어 조건이 참이면 휠체어석만, 거짓이면 휠체어석을 뺀다', () => {
    const wheel = autoCandidatesOf(SEATS, cond({ count: 1, wheelchair: true }), TIERS);
    expect(wheel.groups.map(ids)).toEqual([['A03']]);
    const normal = autoCandidatesOf(SEATS, cond({ count: 1, wheelchair: false }), TIERS);
    expect(normal.groups.map(ids)).not.toContainEqual(['A03']);
    expect(normal.groups.map(ids)).toContainEqual(['A01']);
  });

  test('연석이 없으면 분리 후보를 만들지 않고, 분리 허용 시 같은 등급의 낱개 후보를 만든다', () => {
    const noSplit = autoCandidatesOf(SEATS, cond({ count: 4, allowSplit: false }), TIERS);
    expect(noSplit.groups.filter((g) => g.assignResult === 'FIRST')).toHaveLength(0);
    const split = autoCandidatesOf(SEATS, cond({ count: 4, allowSplit: true }), TIERS);
    const g = split.groups.find((x) => x.assignResult === 'FIRST_SPLIT');
    expect(g?.split).toBe(true);
    expect(ids(g!).length).toBeGreaterThanOrEqual(4);
  });

  test('매수보다 좌석이 적은 등급은 후보를 만들지 않는다', () => {
    const list = autoCandidatesOf(SEATS, cond({ firstTierId: 'S', count: 5, allowSplit: true }), TIERS);
    expect(list.groups).toHaveLength(0);
  });
});

/** 메모리 저장소와 판을 만들고 판매를 연다 */
async function world(seats: readonly SeatRef[] = SEATS) {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const map = new MemorySeatMap();
  map.put({ eventId: EVENT, layoutVersion: 'v1', seatCount: 20, perAccountLimit: LIMIT, saleEndsAtMs: NOW + DAY }, seats as never);
  await store.openSale({ eventId: EVENT, seatCount: 20, keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS });
  return { clock, store, map };
}

async function inputFor(store: MemorySeatStore, map: MemorySeatMap, c: AutoCondition, over: Partial<AutoHoldInput> = {}): Promise<AutoHoldInput> {
  const list = await map.autoCandidates(EVENT, c);
  if (!list) throw new Error('판이 없다');
  return {
    eventId: EVENT,
    accountId: ACCOUNT,
    purchaseSessionId: SESSION,
    holdId: 'hold-auto-1',
    idempotencyKey: 'idem-auto-1',
    fingerprint: autoFingerprint(c),
    count: c.count,
    groups: list.groups.slice(0, AUTO_CANDIDATE_PAGE),
    cursor: 0,
    cursorField: `${c.firstTierId}:${c.count}:${c.wheelchair ? 1 : 0}:${c.allowSplit ? 1 : 0}:${c.secondTierId ?? ''}`,
    limit: LIMIT,
    keepUntilMs: NOW + DAY + KEEP_AFTER_SALE_END_MS,
    ...over,
  };
}

describe('MemorySeatStore.holdAuto [S-T19] [S-T20] [ASVS v5.0.0-2.2.2] [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.4]', () => {
  test('첫 연석 후보를 잡고 비트·홀드·보유 수·만료·Stream·멱등·커서를 쓴다', async () => {
    const { store, map } = await world();
    const c = cond();
    const r = await store.holdAuto(await inputFor(store, map, c));
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.seatIndexes).toEqual([0, 1]);
    expect(r.assignResult).toBe('FIRST');
    expect(r.fencingToken).toBeGreaterThan(0);
    expect(r.nextCursor).toBe(1);
    const ev = store.db.event(EVENT);
    expect([...ev.bits].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(ev.quota.get(ACCOUNT)).toBe(2);
    expect(ev.holds.get(0)).toMatchObject({ holdId: 'hold-auto-1', owner: ACCOUNT, psid: SESSION });
    expect(ev.expiry.get(0)).toBe(NOW + HOLD_TTL_MS);
    expect(ev.stream.map((x) => x.type)).toEqual(['HELD', 'HELD']);
    expect(ev.idem.get(`${ACCOUNT}:idem-auto-1`)).toMatchObject({ seats: [0, 1], assign: 'FIRST' });
    expect(ev.autoCur.get('R:2:0:0:')).toBe(1);
  });

  test('같은 멱등 키·같은 지문이면 처음 좌석·결과를 그대로 재생한다', async () => {
    const { store, map } = await world();
    const c = cond();
    const first = await store.holdAuto(await inputFor(store, map, c));
    expect(first.kind).toBe('OK');
    const second = await store.holdAuto(await inputFor(store, map, c, { holdId: 'hold-auto-2', groups: (await map.autoCandidates(EVENT, c))!.groups.slice(1, 2), cursor: 1 }));
    expect(second.kind).toBe('IDEM_REPLAY');
    if (second.kind !== 'IDEM_REPLAY' || first.kind !== 'OK') return;
    expect(second.seatIndexes).toEqual(first.seatIndexes);
    expect(second.assignResult).toBe('FIRST');
    expect(second.holdId).toBe(first.holdId);
    expect(store.db.event(EVENT).quota.get(ACCOUNT)).toBe(2);
  });

  test('페이지의 후보가 모두 차면 아무것도 쓰지 않고 NEXT와 다음 커서를 준다', async () => {
    const { store, map } = await world();
    const c = cond();
    const list = (await map.autoCandidates(EVENT, c))!;
    const first = await store.holdAuto(await inputFor(store, map, c));
    expect(first.kind).toBe('OK');
    const before = store.db.event(EVENT).quota.get(ACCOUNT);
    const next = await store.holdAuto(await inputFor(store, map, c, { idempotencyKey: 'idem-auto-2', groups: [list.groups[0]!], cursor: 0 }));
    expect(next.kind).toBe('NEXT');
    if (next.kind !== 'NEXT') return;
    expect(next.nextCursor).toBe(1);
    expect(store.db.event(EVENT).quota.get(ACCOUNT)).toBe(before);
    expect(store.db.event(EVENT).bits.size).toBe(2);
  });

  test('분리 후보는 앞에서부터 빈 좌석을 매수만큼 고른다', async () => {
    const { store, map } = await world();
    const c = cond({ allowSplit: true });
    // A01·A03·A05를 먼저 잡아 연석 블록을 모두 막는다(비트만 켠다)
    const ev = store.db.event(EVENT);
    ev.bits.add(0);
    ev.bits.add(2);
    ev.bits.add(4);
    const list = (await map.autoCandidates(EVENT, c))!;
    const split = list.groups.find((g) => g.assignResult === 'FIRST_SPLIT')!;
    const r = await store.holdAuto(await inputFor(store, map, c, { groups: [split] }));
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.assignResult).toBe('FIRST_SPLIT');
    expect(r.seatIndexes).toEqual([1, 3]);
  });

  test('방금 놓은 좌석이 든 후보는 건너뛰고 다음 후보를 잡는다', async () => {
    const { store, map } = await world();
    const c = cond();
    store.db.event(EVENT).rel.set(ACCOUNT, new Map([[0, NOW + 30_000]]));
    const r = await store.holdAuto(await inputFor(store, map, c));
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.seatIndexes).toEqual([3, 4]);
  });

  test('보유 수·판매 정지·세대 키 없음은 각각의 결과로 끝나고 아무것도 쓰지 않는다', async () => {
    const { store, map } = await world();
    const c = cond();
    store.db.event(EVENT).quota.set(ACCOUNT, 3);
    expect((await store.holdAuto(await inputFor(store, map, c))).kind).toBe('QUOTA_EXCEEDED');
    store.db.event(EVENT).quota.delete(ACCOUNT);
    store.db.event(EVENT).ctl.set('paused', '1');
    expect((await store.holdAuto(await inputFor(store, map, c))).kind).toBe('PAUSED');
    store.db.event(EVENT).ctl.delete('paused');
    store.db.event(EVENT).epoch = undefined;
    expect((await store.holdAuto(await inputFor(store, map, c))).kind).toBe('NOT_READY');
    expect(store.db.event(EVENT).bits.size).toBe(0);
  });
});
