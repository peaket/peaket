// 회차 판매 상태 판정의 순수 규칙(docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122 '뒤에 정한 것', ADR-0214 결정 2·3, ADR-0219 결정 5·6, BUILD_ORDER PRF-144, S-T25).
// decideSale의 모든 전이와 경계, 등급 매진, 비트맵 셈(tierAvailability), 사건 키·사건 값(saleEventKey·saleChangedPayload), 평균 구매 매수(avgTicketsOf)를 입력과 출력만으로 본다.
// 언제 무엇을 읽고 쓰는지는 test/sale-state-judge.test.ts, 실제 PostgreSQL·Valkey는 test-int/sale-state.int.test.ts다.
import 'reflect-metadata';
import { EventSaleChanged } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { uuid8 } from '../src/modules/inventory/domain/purchase-session.js';
import {
  ALL_HELD_AFTER_MS,
  AVG_CACHE_MS,
  AVG_MIN_ORDERS,
  avgTicketsOf,
  decideSale,
  type EventSaleRow,
  NEW_SALE_MEMO,
  SALE_JUDGE_CONCURRENCY,
  SALE_REPUBLISH_MS,
  SALE_STATUSES,
  SALE_TICK_MS,
  SALE_TIER_SCAN_PAGE,
  SALE_WARN_INTERVAL_MS,
  saleChangedPayload,
  type SaleCounts,
  type SaleDecideInput,
  type SaleDecision,
  saleEventKey,
  type SaleMemo,
  type SaleRowView,
  type SaleStatus,
  type SaleTierCounts,
  tierAvailability,
} from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');
const DAY = 86_400_000;
const END = NOW + DAY;

const tier = (tierId: string, available = 0, paying = 0, held = false): SaleTierCounts => ({ tierId, available, paying, held });
/** 기본은 가용 1, 홀드·결제 중 0, 비지 않음 */
const counts = (o: Partial<SaleCounts> = {}): SaleCounts => ({ available: 1, held: 0, paying: 0, empty: false, tiers: [], ...o });
/** 가용 0이고 홀드가 남은 틱(비지 않음) */
const zero = (o: Partial<SaleCounts> = {}): SaleCounts => counts({ available: 0, held: 1, ...o });
/** 회차 전체가 빈 틱(거짓 매진 막기를 지남) */
const empty = (o: Partial<SaleCounts> = {}): SaleCounts => counts({ available: 0, held: 0, paying: 0, empty: true, ...o });
const row = (status: SaleStatus, o: Partial<SaleRowView> = {}): SaleRowView => ({ status, soldOutTiers: [], reopenCount: 0, ...o });
const memo = (o: Partial<SaleMemo> = {}): SaleMemo => ({ emptyStreak: 0, tierEmptyStreak: new Map<string, number>(), ...o });
const input = (o: Partial<SaleDecideInput> = {}): SaleDecideInput => ({ row: row('ON_SALE'), counts: counts(), memo: memo(), nowMs: NOW, saleEndsAtMs: END, ...o });
const decide = (o: Partial<SaleDecideInput> = {}): SaleDecision => decideSale(input(o));

/** 틱을 이어 돌린다: 앞 판정의 메모·상태·등급·reopenCount를 다음 틱의 입력으로 넘긴다. atMs는 NOW에서 지난 시간이다 */
function run(start: SaleRowView, steps: readonly { atMs: number; c: SaleCounts }[]): SaleDecision[] {
  let r = start;
  let m = memo();
  const out: SaleDecision[] = [];
  for (const { atMs, c } of steps) {
    const d = decideSale(input({ row: r, counts: c, memo: m, nowMs: NOW + atMs }));
    out.push(d);
    m = d.memo;
    r = { ...r, status: d.status, soldOutTiers: d.soldOutTiers, reopenCount: d.reopenCount };
  }
  return out;
}

const LIVE: SaleStatus[] = ['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT'];

describe('규칙 값', () => {
  test('ST25_ADR0122_ 정본의 가정 값과 같다(1초 틱, 5초 일시 매진, 5초 다시 내기, 100건 평균, 1분 캐시, 1,000개 쪽, 동시 4개, 1분 경고)', () => {
    expect({ SALE_TICK_MS, ALL_HELD_AFTER_MS, SALE_REPUBLISH_MS, AVG_MIN_ORDERS, AVG_CACHE_MS, SALE_TIER_SCAN_PAGE, SALE_JUDGE_CONCURRENCY, SALE_WARN_INTERVAL_MS }).toEqual({
      SALE_TICK_MS: 1000,
      ALL_HELD_AFTER_MS: 5000,
      SALE_REPUBLISH_MS: 5000,
      AVG_MIN_ORDERS: 100,
      AVG_CACHE_MS: 60_000,
      SALE_TIER_SCAN_PAGE: 1000,
      SALE_JUDGE_CONCURRENCY: 4,
      SALE_WARN_INTERVAL_MS: 60_000,
    });
    expect([...SALE_STATUSES]).toEqual(['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED']);
    expect(NEW_SALE_MEMO).toMatchObject({ emptyStreak: 0 });
    expect(NEW_SALE_MEMO.availableZeroSinceMs).toBeUndefined();
    expect(NEW_SALE_MEMO.tierEmptyStreak.size).toBe(0);
  });
});

describe('decideSale: 행이 없을 때', () => {
  test('ST25_ADR0122_ 행이 없으면 ON_SALE·빈 등급·reopenCount 0으로 만들고 changed다(NEW_ROW)', () => {
    expect(decide({ row: undefined })).toMatchObject({ status: 'ON_SALE', soldOutTiers: [], reopenCount: 0, changed: true, reason: 'NEW_ROW' });
  });

  test('ST25_ADR0122_ 행이 없을 때는 가용 0이고 비었어도 ON_SALE로 만든다(첫 판의 값은 ON_SALE 하나다). 메모는 그대로 센다', () => {
    const d = decide({ row: undefined, counts: empty(), memo: memo({ emptyStreak: 1 }) });
    expect(d).toMatchObject({ status: 'ON_SALE', reason: 'NEW_ROW', changed: true });
    expect(d.memo.emptyStreak).toBe(2);
    expect(d.memo.availableZeroSinceMs).toBe(NOW);
  });
});

describe('decideSale: 행이 없고 판매 종료가 지났을 때', () => {
  test.each([
    ['종료 시각 그 순간', END],
    ['종료 뒤', END + DAY],
  ])('ST25_ADR0122_ %s에는 행을 만들지 않는다: ENDED이고 changed가 아니다(SALE_ENDED) [ASVS v5.0.0-2.3.1]', (_, nowMs) => {
    expect(decide({ row: undefined, nowMs })).toMatchObject({ status: 'ENDED', soldOutTiers: [], reopenCount: 0, changed: false, reason: 'SALE_ENDED' });
  });
});

describe('decideSale: ENDED가 가장 먼저이고 되돌아가지 않는다', () => {
  test.each(LIVE)('ST25_ADR0122_ %s에서 판매 종료 시각이 되면(지금 = 종료, 경계 포함) ENDED다. 행의 매진 등급·reopenCount는 그대로다 [ASVS v5.0.0-2.3.1]', (status) => {
    expect(decide({ row: row(status, { soldOutTiers: ['R'], reopenCount: 3 }), nowMs: END })).toMatchObject({ status: 'ENDED', soldOutTiers: ['R'], reopenCount: 3, changed: true, reason: 'SALE_ENDED' });
  });

  test.each(LIVE)('ST25_ADR0122_ %s에서 판매 종료 1ms 전은 ENDED가 아니다', (status) => {
    expect(decide({ row: row(status), nowMs: END - 1 }).status).not.toBe('ENDED');
  });

  test('ST25_ADR0122_ 판매 종료는 다른 전이를 앞선다: 매진에 좌석이 돌아와도, 비었음이 두 번 이어져도, 오픈 전이어도 ENDED다 [ASVS v5.0.0-2.3.1]', () => {
    expect(decide({ row: row('SOLD_OUT'), counts: counts({ available: 5 }), nowMs: END }).status).toBe('ENDED');
    expect(decide({ row: row('ALL_HELD'), counts: empty(), memo: memo({ emptyStreak: 1 }), nowMs: END }).status).toBe('ENDED');
    expect(decide({ row: row('UPCOMING', { openAtMs: END + DAY }), nowMs: END }).status).toBe('ENDED');
  });

  test('ST25_ADR0122_ 이미 ENDED면 판매 종료 전 시각이어도, 가용이 있어도 다시 열지 않고 changed가 아니다(UNCHANGED) [ASVS v5.0.0-2.3.1]', () => {
    expect(decide({ row: row('ENDED', { soldOutTiers: ['R'], reopenCount: 2 }), counts: counts({ available: 9 }), nowMs: NOW })).toMatchObject({ status: 'ENDED', soldOutTiers: ['R'], reopenCount: 2, changed: false, reason: 'UNCHANGED' });
    expect(decide({ row: row('ENDED'), nowMs: END + DAY })).toMatchObject({ status: 'ENDED', changed: false, reason: 'UNCHANGED' });
  });
});

describe('decideSale: UPCOMING', () => {
  test('ST25_ADR0122_ open_at이 비었으면 바로 ON_SALE이다(OPENED)', () => {
    expect(decide({ row: row('UPCOMING') })).toMatchObject({ status: 'ON_SALE', changed: true, reason: 'OPENED' });
  });

  test('ST25_ADR0122_ open_at 1ms 전은 그대로이고, 지금 = open_at이면 ON_SALE이다', () => {
    expect(decide({ row: row('UPCOMING', { openAtMs: NOW + 1 }) })).toMatchObject({ status: 'UPCOMING', changed: false, reason: 'UNCHANGED' });
    expect(decide({ row: row('UPCOMING', { openAtMs: NOW }) })).toMatchObject({ status: 'ON_SALE', changed: true, reason: 'OPENED' });
  });

  test('ST25_ADR0122_ 오픈 전이면 비었음이 두 번 이어져도 SOLD_OUT이 되지 않고, 가용 0이 5초 이어져도 ALL_HELD가 되지 않는다 [ASVS v5.0.0-2.3.1]', () => {
    const open = row('UPCOMING', { openAtMs: NOW + DAY / 2 });
    expect(decide({ row: open, counts: empty(), memo: memo({ emptyStreak: 5 }) })).toMatchObject({ status: 'UPCOMING', changed: false });
    expect(decide({ row: open, counts: zero(), memo: memo({ availableZeroSinceMs: NOW - 60_000 }) })).toMatchObject({ status: 'UPCOMING', changed: false });
  });
});

describe('decideSale: ON_SALE → ALL_HELD(가용 0이 5초 이어짐)', () => {
  test('ST25_① ADR0122_ 처음 0이 된 틱은 시각을 적고, 4,999ms 뒤는 그대로이고, 5,000ms 뒤에 ALL_HELD다(경계) [ASVS v5.0.0-2.3.1]', () => {
    const [first, before, at] = run(row('ON_SALE'), [
      { atMs: 0, c: zero() },
      { atMs: 4999, c: zero() },
      { atMs: 5000, c: zero() },
    ]);
    expect(first).toMatchObject({ status: 'ON_SALE', changed: false, reason: 'UNCHANGED' });
    expect(first!.memo.availableZeroSinceMs).toBe(NOW);
    expect(before).toMatchObject({ status: 'ON_SALE', changed: false });
    expect(before!.memo.availableZeroSinceMs).toBe(NOW);
    expect(at).toMatchObject({ status: 'ALL_HELD', changed: true, reason: 'ALL_HELD' });
  });

  test('ST25_② ADR0122_ 0이 끊기면 5초를 처음부터 다시 잰다: 4초에 풀리고 곧 다시 잡히면 처음 0부터 5초가 지나도 ALL_HELD가 아니고, 다시 0이 된 때부터 5초 뒤에 된다', () => {
    const d = run(row('ON_SALE'), [
      { atMs: 0, c: zero() },
      { atMs: 4000, c: counts({ available: 1 }) },
      { atMs: 4100, c: zero() },
      { atMs: 5000, c: zero() },
      { atMs: 9099, c: zero() },
      { atMs: 9100, c: zero() },
    ]);
    expect(d[1]!.memo.availableZeroSinceMs).toBeUndefined();
    expect(d[2]!.memo.availableZeroSinceMs).toBe(NOW + 4100);
    expect(d.map((x) => x.status)).toEqual(['ON_SALE', 'ON_SALE', 'ON_SALE', 'ON_SALE', 'ON_SALE', 'ALL_HELD']);
  });

  test('ST25_ADR0122_ 메모가 없으면 그만큼 늦을 뿐이다: 이번 틱을 처음 0으로 적고 ALL_HELD가 되지 않는다', () => {
    const d = decide({ counts: zero(), memo: memo(), nowMs: NOW + 60_000 });
    expect(d).toMatchObject({ status: 'ON_SALE', changed: false });
    expect(d.memo.availableZeroSinceMs).toBe(NOW + 60_000);
  });

  test('ST25_ADR0122_ 가용이 1 이상이면 시각을 지운다', () => {
    const d = decide({ counts: counts({ available: 1 }), memo: memo({ availableZeroSinceMs: NOW - 4000 }) });
    expect(d.memo.availableZeroSinceMs).toBeUndefined();
    expect(d.status).toBe('ON_SALE');
  });

  test('ST25_ADR0122_ 5초를 채운 틱이 비었음 두 번째이기도 하면 ALL_HELD를 건너뛰고 SOLD_OUT이다(비었음이 먼저다) [ASVS v5.0.0-2.3.1]', () => {
    expect(decide({ counts: empty(), memo: memo({ emptyStreak: 1, firstEmptyAtMs: NOW - SALE_TICK_MS, availableZeroSinceMs: NOW - 5000 }) })).toMatchObject({ status: 'SOLD_OUT', reason: 'SOLD_OUT', changed: true });
  });
});

describe('decideSale: ALL_HELD → ON_SALE', () => {
  test('ST25_ADR0122_ 가용이 1 이상이면 그 틱에 바로 ON_SALE이다(AVAILABLE_AGAIN, 기다리지 않는다)', () => {
    expect(decide({ row: row('ALL_HELD'), counts: counts({ available: 1, held: 9 }) })).toMatchObject({ status: 'ON_SALE', changed: true, reason: 'AVAILABLE_AGAIN' });
  });

  test('ST25_③ ADR0122_ 가용 0에 결제 중이나 홀드가 남았으면 ALL_HELD를 지킨다(몇 초가 지나도)', () => {
    const d = decide({ row: row('ALL_HELD'), counts: zero({ held: 0, paying: 9 }), memo: memo({ availableZeroSinceMs: NOW - 60_000 }) });
    expect(d).toMatchObject({ status: 'ALL_HELD', changed: false, reason: 'UNCHANGED' });
  });
});

describe('decideSale: 비었음이 연속 2틱이면 SOLD_OUT', () => {
  test('ST25_④ ADR0122_ 첫 틱은 streak 1이고 그대로, 둘째 틱에 SOLD_OUT이다 [ASVS v5.0.0-2.3.1]', () => {
    const [first, second] = run(row('ALL_HELD'), [
      { atMs: 0, c: empty() },
      { atMs: 1000, c: empty() },
    ]);
    expect(first).toMatchObject({ status: 'ALL_HELD', changed: false });
    expect(first!.memo.emptyStreak).toBe(1);
    expect(second).toMatchObject({ status: 'SOLD_OUT', changed: true, reason: 'SOLD_OUT' });
    expect(second!.memo.emptyStreak).toBe(2);
  });

  test('ST25_④ ADR0122_ 비지 않은 틱이 끼면 0으로 돌아가 처음부터 다시 센다', () => {
    const d = run(row('ALL_HELD'), [
      { atMs: 0, c: empty() },
      { atMs: 1000, c: zero() },
      { atMs: 2000, c: empty() },
      { atMs: 3000, c: empty() },
    ]);
    expect(d.map((x) => x.memo.emptyStreak)).toEqual([1, 0, 1, 2]);
    expect(d.map((x) => x.status)).toEqual(['ALL_HELD', 'ALL_HELD', 'ALL_HELD', 'SOLD_OUT']);
  });

  test('ST25_⑪ ADR0122_ 가용·홀드·결제 중이 모두 0이어도 empty가 거짓이면(거짓 매진 막기) 몇 틱이 지나도 SOLD_OUT이 아니다 [ASVS v5.0.0-16.5.3]', () => {
    const blocked = counts({ available: 0, held: 0, paying: 0, empty: false });
    const d = run(row('ALL_HELD'), [
      { atMs: 0, c: blocked },
      { atMs: 1000, c: blocked },
      { atMs: 2000, c: blocked },
    ]);
    expect(d.map((x) => x.status)).toEqual(['ALL_HELD', 'ALL_HELD', 'ALL_HELD']);
    expect(d.map((x) => x.memo.emptyStreak)).toEqual([0, 0, 0]);
  });

  test('ST25_ADR0122_ ON_SALE에서도 바로 SOLD_OUT이 된다(ALL_HELD를 거치지 않는다, 5초를 기다리지 않는다)', () => {
    const [first, second] = run(row('ON_SALE'), [
      { atMs: 0, c: empty() },
      { atMs: 1000, c: empty() },
    ]);
    expect(first!.status).toBe('ON_SALE');
    expect(second).toMatchObject({ status: 'SOLD_OUT', changed: true, reason: 'SOLD_OUT' });
  });
});

describe('decideSale: SOLD_OUT', () => {
  test('ST25_⑥ ADR0122_ 가용이 1 이상이면 ON_SALE이고 reopenCount가 1 는다(REOPENED) [ASVS v5.0.0-2.3.1]', () => {
    expect(decide({ row: row('SOLD_OUT', { reopenCount: 2 }), counts: counts({ available: 1 }) })).toMatchObject({ status: 'ON_SALE', reopenCount: 3, changed: true, reason: 'REOPENED' });
  });

  test('ST25_⑤ ADR0122_ 가용 0이면 홀드·결제 중이 있어도 SOLD_OUT 그대로다(ALL_HELD로 가지 않는다, reopenCount도 그대로)', () => {
    expect(decide({ row: row('SOLD_OUT', { reopenCount: 1 }), counts: counts({ available: 0, held: 3, paying: 2 }), memo: memo({ availableZeroSinceMs: NOW - 60_000 }) })).toMatchObject({
      status: 'SOLD_OUT',
      reopenCount: 1,
      changed: false,
      reason: 'UNCHANGED',
    });
  });

  test('ST25_ADR0122_ 비어 있어도 SOLD_OUT 그대로이고 판을 올리지 않는다', () => {
    expect(decide({ row: row('SOLD_OUT'), counts: empty(), memo: memo({ emptyStreak: 7 }) })).toMatchObject({ status: 'SOLD_OUT', changed: false, reason: 'UNCHANGED' });
  });

  test('ST25_⑥ ADR0122_ 풀린 뒤 다시 비면 다시 두 번 이어져야 SOLD_OUT이다(reopenCount는 쌓인다)', () => {
    const d = run(row('SOLD_OUT'), [
      { atMs: 0, c: counts({ available: 1 }) },
      { atMs: 1000, c: empty() },
      { atMs: 2000, c: empty() },
      { atMs: 3000, c: counts({ available: 1 }) },
    ]);
    expect(d.map((x) => [x.status, x.reopenCount])).toEqual([
      ['ON_SALE', 1],
      ['ON_SALE', 1],
      ['SOLD_OUT', 1],
      ['ON_SALE', 2],
    ]);
  });
});

describe('decideSale: 등급 매진(ADR-0214 결정 3)', () => {
  const live = (...tiers: SaleTierCounts[]) => counts({ available: 5, tiers });

  test('ST25_⑨ ADR0122_ 가용·결제 중이 0이고 홀드가 없는 틱이 두 번 이어져야 든다(첫 틱은 changed가 아니다). 상태는 그대로이고 changed다(TIERS_CHANGED)', () => {
    const [first, second] = run(row('ON_SALE'), [
      { atMs: 0, c: live(tier('R', 5), tier('S')) },
      { atMs: 1000, c: live(tier('R', 5), tier('S')) },
    ]);
    expect(first).toMatchObject({ status: 'ON_SALE', soldOutTiers: [], changed: false, reason: 'UNCHANGED' });
    expect([...first!.memo.tierEmptyStreak]).toEqual([['S', 1]]);
    expect(second).toMatchObject({ status: 'ON_SALE', soldOutTiers: ['S'], changed: true, reason: 'TIERS_CHANGED' });
    expect(second!.memo.tierEmptyStreak.get('S')).toBe(2);
  });

  test('ST25_⑨ ADR0122_ 비지 않은 틱이 끼면 처음부터 다시 센다(0은 메모에 넣지 않는다)', () => {
    const d = run(row('ON_SALE'), [
      { atMs: 0, c: live(tier('S')) },
      { atMs: 1000, c: live(tier('S', 1)) },
      { atMs: 2000, c: live(tier('S')) },
    ]);
    expect(d[1]!.memo.tierEmptyStreak.has('S')).toBe(false);
    expect(d[2]!.memo.tierEmptyStreak.get('S')).toBe(1);
    expect(d.every((x) => x.soldOutTiers.length === 0)).toBe(true);
  });

  test.each([
    ['가용', tier('S', 1)],
    ['결제 중', tier('S', 0, 1)],
    ['홀드', tier('S', 0, 0, true)],
  ])('ST25_⑨ ADR0122_ %s이 있으면 비지 않은 등급이다(streak가 끊기고 들지 않는다)', (_, t) => {
    const d = decide({ counts: live(t), memo: memo({ tierEmptyStreak: new Map([['S', 1]]) }) });
    expect(d.soldOutTiers).toEqual([]);
    expect(d.memo.tierEmptyStreak.has('S')).toBe(false);
    expect(d.changed).toBe(false);
  });

  test('ST25_⑨ ADR0122_ 이미 든 등급은 가용이 1 이상이면 그 틱에 바로 빠지고 changed다(두 번 기다리지 않는다)', () => {
    expect(decide({ row: row('ON_SALE', { soldOutTiers: ['R', 'S'] }), counts: live(tier('R'), tier('S', 1)) })).toMatchObject({ status: 'ON_SALE', soldOutTiers: ['R'], changed: true, reason: 'TIERS_CHANGED' });
  });

  test('ST25_⑨ ADR0122_ 이미 든 등급은 다시 보지 않는다: 가용이 0이면 홀드·결제 중이 생겨도 그대로이고 changed가 아니다', () => {
    expect(decide({ row: row('ON_SALE', { soldOutTiers: ['S'] }), counts: live(tier('S', 0, 2, true)) })).toMatchObject({ soldOutTiers: ['S'], changed: false, reason: 'UNCHANGED' });
  });

  test('ST25_⑨ ADR0122_ counts.tiers에 없는 등급은 목록에 그대로 두고, 그 등급의 streak는 메모에서 뺀다', () => {
    const d = decide({ row: row('ON_SALE', { soldOutTiers: ['GONE'] }), counts: live(tier('R', 5)), memo: memo({ tierEmptyStreak: new Map([['OLD', 1]]) }) });
    expect(d.soldOutTiers).toEqual(['GONE']);
    expect(d.changed).toBe(false);
    expect(d.memo.tierEmptyStreak.has('OLD')).toBe(false);
  });

  test('ST25_⑨ ADR0122_ 결과는 등급 ID 문자 코드 순으로 정렬하고 겹치지 않는다(입력 차례와 관계없이)', () => {
    const streak = new Map([
      ['m', 1],
      ['A', 1],
      ['Z', 1],
    ]);
    expect(decide({ counts: live(tier('m'), tier('A'), tier('Z')), memo: memo({ tierEmptyStreak: streak }) }).soldOutTiers).toEqual(['A', 'Z', 'm']);
    expect(decide({ row: row('ON_SALE', { soldOutTiers: ['Z'] }), counts: live(tier('Z'), tier('A')), memo: memo({ tierEmptyStreak: new Map([['A', 1]]) }) }).soldOutTiers).toEqual(['A', 'Z']);
  });

  test('ST25_⑨ ADR0122_ 상태가 함께 바뀌면 까닭은 상태의 것이고 등급도 같이 바뀐다', () => {
    expect(decide({ row: row('ALL_HELD', { soldOutTiers: ['S'] }), counts: counts({ available: 1, tiers: [tier('S', 1)] }) })).toMatchObject({ status: 'ON_SALE', soldOutTiers: [], changed: true, reason: 'AVAILABLE_AGAIN' });
    expect(decide({ row: row('SOLD_OUT', { soldOutTiers: ['R', 'S'] }), counts: counts({ available: 1, tiers: [tier('R'), tier('S', 1)] }) })).toMatchObject({ status: 'ON_SALE', soldOutTiers: ['R'], reason: 'REOPENED' });
  });

  test('ST25_⑨ ADR0122_ 회차가 SOLD_OUT인 동안에도 등급 집합이 바뀌면 changed다(TIERS_CHANGED)', () => {
    expect(decide({ row: row('SOLD_OUT'), counts: counts({ available: 0, tiers: [tier('S')] }), memo: memo({ tierEmptyStreak: new Map([['S', 1]]) }) })).toMatchObject({ status: 'SOLD_OUT', soldOutTiers: ['S'], changed: true, reason: 'TIERS_CHANGED' });
  });

  test('ST25_⑨ ADR0122_ ENDED 뒤에는 등급이 바뀌지 않는다(가용이 생겨도, 비어도). ENDED로 닫는 틱도 행의 목록 그대로다', () => {
    expect(decide({ row: row('ENDED', { soldOutTiers: ['S'] }), counts: live(tier('S', 1), tier('R')), memo: memo({ tierEmptyStreak: new Map([['R', 1]]) }) })).toMatchObject({ soldOutTiers: ['S'], changed: false });
    expect(decide({ row: row('ON_SALE', { soldOutTiers: ['S'] }), counts: live(tier('S', 1), tier('R')), memo: memo({ tierEmptyStreak: new Map([['R', 1]]) }), nowMs: END })).toMatchObject({ status: 'ENDED', soldOutTiers: ['S'] });
  });

  test('ST25_⑨ ADR0122_ 행이 없는 첫 판은 등급을 넣지 않는다', () => {
    expect(decide({ row: undefined, counts: live(tier('S')), memo: memo({ tierEmptyStreak: new Map([['S', 1]]) }) }).soldOutTiers).toEqual([]);
  });
});

describe('decideSale: 리뷰 고침(코드 리뷰 2026-11-09, BUILD_ORDER PRF-144)', () => {
  test('ST25_④ ADR0122_ 리뷰 고침 L7: 빈 틱 두 번이 1초 안에 몰리면 아직 SOLD_OUT이 아니고, 첫 빈 틱에서 1초가 지난 틱에 된다 [ASVS v5.0.0-2.3.1]', () => {
    const d = run(row('ALL_HELD'), [
      { atMs: 0, c: empty() },
      { atMs: 1, c: empty() },
      { atMs: SALE_TICK_MS - 1, c: empty() },
      { atMs: SALE_TICK_MS, c: empty() },
    ]);
    expect(d.map((x) => x.status)).toEqual(['ALL_HELD', 'ALL_HELD', 'ALL_HELD', 'SOLD_OUT']);
    expect(d[1]!.memo.firstEmptyAtMs).toBe(NOW);
  });

  test('ST25_④ ADR0122_ 리뷰 고침 L7: 비지 않은 틱이 끼면 첫 빈 틱 시각을 지운다', () => {
    const d = run(row('ALL_HELD'), [
      { atMs: 0, c: empty() },
      { atMs: SALE_TICK_MS, c: zero() },
      { atMs: SALE_TICK_MS * 2, c: empty() },
    ]);
    expect(d[1]!.memo.firstEmptyAtMs).toBeUndefined();
    expect(d[2]!.memo.firstEmptyAtMs).toBe(NOW + SALE_TICK_MS * 2);
  });

  test('ST25_⑨ ADR0122_ 리뷰 고침 L7: 등급 매진은 틱 수만 본다(시각을 보지 않는다)', () => {
    const c = counts({ available: 5, tiers: [tier('S')] });
    const [, second] = run(row('ON_SALE'), [
      { atMs: 0, c },
      { atMs: 1, c },
    ]);
    expect(second).toMatchObject({ soldOutTiers: ['S'], reason: 'TIERS_CHANGED' });
  });

  test('ST25_⑥ ADR0122_ 리뷰 고침 L6: 풀림이 막힌 틱(reopenBlocked)은 SOLD_OUT 그대로이고 매진 등급도 빼지 않으며 판을 올리지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(decide({ row: row('SOLD_OUT', { soldOutTiers: ['R', 'S'], reopenCount: 1 }), counts: counts({ available: 1, reopenBlocked: true, tiers: [tier('R', 1), tier('S')] }) })).toMatchObject({
      status: 'SOLD_OUT',
      soldOutTiers: ['R', 'S'],
      reopenCount: 1,
      changed: false,
      reason: 'UNCHANGED',
    });
  });
});

describe('decideSale: 입력을 바꾸지 않는다', () => {
  test('ST25_ADR0122_ 메모·행의 값이 그대로이고, 빈 메모(NEW_SALE_MEMO)를 넣어도 공용 값이 바뀌지 않는다', () => {
    const streak = new Map([['S', 1]]);
    const m = memo({ emptyStreak: 1, tierEmptyStreak: streak });
    const r = row('ON_SALE', { soldOutTiers: ['B', 'A'] });
    decide({ row: r, memo: m, counts: empty({ tiers: [tier('S')] }) });
    expect(m.emptyStreak).toBe(1);
    expect([...streak]).toEqual([['S', 1]]);
    expect([...r.soldOutTiers]).toEqual(['B', 'A']);
    const d = decide({ memo: NEW_SALE_MEMO, counts: empty({ tiers: [tier('S')] }) });
    expect(d.memo.tierEmptyStreak.get('S')).toBe(1);
    expect(NEW_SALE_MEMO.tierEmptyStreak.size).toBe(0);
    expect(NEW_SALE_MEMO.emptyStreak).toBe(0);
  });
});

describe('tierAvailability(비트맵의 등급별 가용)', () => {
  const tiers = (indexes: number[], tierId = 'R') => [{ tierId, indexes }];

  test('ST25_ADR0122_ 색인 i의 비트는 i >> 3번째 바이트의 높은 비트부터다(Redis 비트맵 차례): 0x80은 색인 0, 0x01은 색인 7이다', () => {
    expect(tierAvailability(Buffer.from([0x80]), tiers([0]))).toEqual([{ tierId: 'R', available: 0 }]);
    expect(tierAvailability(Buffer.from([0x80]), tiers([1]))).toEqual([{ tierId: 'R', available: 1 }]);
    expect(tierAvailability(Buffer.from([0x01]), tiers([7]))).toEqual([{ tierId: 'R', available: 0 }]);
    expect(tierAvailability(Buffer.from([0x01]), tiers([0]))).toEqual([{ tierId: 'R', available: 1 }]);
    expect(tierAvailability(Buffer.from([0x00, 0x80]), tiers([8]))).toEqual([{ tierId: 'R', available: 0 }]);
    expect(tierAvailability(Buffer.from([0x00, 0x01]), tiers([15, 14]))).toEqual([{ tierId: 'R', available: 1 }]);
  });

  test('ST25_ADR0122_ 0x80 이상의 바이트가 깨지지 않게 그대로 본다(글로 바꾸면 틀어지는 값)', () => {
    expect(tierAvailability(Buffer.from([0xff, 0xfe]), tiers([0, 7, 8, 14, 15]))).toEqual([{ tierId: 'R', available: 1 }]);
  });

  test('ST25_ADR0122_ 비트맵이 짧거나 비었으면 모자란 곳은 0(가용)이다(스냅샷과 같다)', () => {
    expect(tierAvailability(Buffer.alloc(0), tiers([0, 1, 100]))).toEqual([{ tierId: 'R', available: 3 }]);
    expect(tierAvailability(Buffer.from([0xff]), tiers([7, 8, 100]))).toEqual([{ tierId: 'R', available: 2 }]);
  });

  test('ST25_ADR0122_ 판매 대상 색인만 본다: 표에 없는 색인의 비트는 세지 않는다', () => {
    expect(tierAvailability(Buffer.from([0b0001_0000]), tiers([0, 1, 2]))).toEqual([{ tierId: 'R', available: 3 }]);
  });

  test('ST25_ADR0122_ 표와 같은 차례로 등급마다 돌려주고, 색인이 없는 등급은 0이다. 등급이 없으면 빈 배열이다', () => {
    const r = tierAvailability(Buffer.from([0b1100_0000]), [
      { tierId: 'VIP', indexes: [0, 2] },
      { tierId: 'R', indexes: [1, 3, 4] },
      { tierId: 'S', indexes: [] },
    ]);
    expect(r).toEqual([
      { tierId: 'VIP', available: 1 },
      { tierId: 'R', available: 2 },
      { tierId: 'S', available: 0 },
    ]);
    expect(tierAvailability(Buffer.from([0xff]), [])).toEqual([]);
  });
});

describe('saleEventKey(같은 판은 같은 키)', () => {
  const E = '019a6f00-0000-7000-8000-000000000001';

  test('ST25_⑧ ADR0122_ 같은 입력이면 같은 값이고 uuid8("EventSaleChanged:" + 회차 + ":" + 판)이다', () => {
    expect(saleEventKey(E, 7)).toBe(saleEventKey(E, 7));
    expect(saleEventKey(E, 7)).toBe(uuid8(`EventSaleChanged:${E}:7`));
    expect(saleEventKey(E, 7)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('ST25_⑧ ADR0122_ 판이 다르거나 회차가 다르면 다른 값이다', () => {
    expect(saleEventKey(E, 7)).not.toBe(saleEventKey(E, 8));
    expect(saleEventKey(E, 7)).not.toBe(saleEventKey('019a6f00-0000-7000-8000-000000000002', 7));
  });
});

describe('saleChangedPayload(사건 값, asyncapi EventSaleChanged)', () => {
  const E = '019a6f00-0000-7000-8000-000000000001';
  const saleRow = (o: Partial<EventSaleRow> = {}): EventSaleRow => ({
    eventId: E,
    status: 'ALL_HELD',
    previousStatus: 'ON_SALE',
    version: 7,
    sellableSeats: 10,
    available: 0,
    held: 3,
    paying: 2,
    soldOutTiers: ['VIP', 'R'],
    reopenCount: 1,
    changedAtMs: NOW,
    countedAtMs: NOW + 1234,
    ...o,
  });

  test('ST25_ADR0122_ 칸 전부를 싣고 시각은 ISO, eventKey는 그 판의 키, 등급은 정렬한다', () => {
    expect(saleChangedPayload(saleRow(), 2.35)).toEqual({
      eventId: E,
      status: 'ALL_HELD',
      previousStatus: 'ON_SALE',
      available: 0,
      held: 3,
      paying: 2,
      soldOutTiers: ['R', 'VIP'],
      version: 7,
      changedAt: new Date(NOW).toISOString(),
      countedAt: new Date(NOW + 1234).toISOString(),
      eventKey: saleEventKey(E, 7),
      avgTicketsPerOrder: 2.35,
    });
  });

  test('ST25_ADR0122_ type 칸이 없다(queue-svc 처리기는 type 칸이 있으면 좌석 사건으로 건너뛴다)', () => {
    expect(Object.keys(saleChangedPayload(saleRow(), 2))).not.toContain('type');
  });

  test('ST25_ADR0122_ previousStatus·avgTicketsPerOrder가 없으면 칸을 뺀다(undefined 칸을 두지 않는다)', () => {
    const first = saleRow();
    delete first.previousStatus;
    const p = saleChangedPayload(first);
    expect(Object.keys(p)).not.toContain('previousStatus');
    expect(Object.keys(p)).not.toContain('avgTicketsPerOrder');
  });

  test('ST25_ADR0122_ 행의 등급 배열을 바꾸지 않고 새 배열을 준다', () => {
    const r = saleRow();
    const p = saleChangedPayload(r);
    expect([...r.soldOutTiers]).toEqual(['VIP', 'R']);
    expect(p.soldOutTiers).not.toBe(r.soldOutTiers);
  });

  test.each(SALE_STATUSES.map((s) => [s]))('ST25_ADR0122_ 계약의 zod(EventSaleChanged)를 통과한다: %s', (status) => {
    expect(EventSaleChanged.safeParse(saleChangedPayload(saleRow({ status }), 2.5)).success).toBe(true);
    const bare = saleRow({ status, soldOutTiers: [] });
    delete bare.previousStatus;
    expect(EventSaleChanged.safeParse(saleChangedPayload(bare)).success).toBe(true);
  });

  test('ST25_⑧ ADR0122_ 같은 판을 다시 내면 version·eventKey·changedAt·previousStatus는 그대로이고 셈과 countedAt만 새 값이다', () => {
    const a = saleChangedPayload(saleRow());
    const b = saleChangedPayload(saleRow({ available: 2, held: 1, paying: 0, countedAtMs: NOW + 6000 }));
    expect({ version: b.version, eventKey: b.eventKey, changedAt: b.changedAt, previousStatus: b.previousStatus }).toEqual({ version: a.version, eventKey: a.eventKey, changedAt: a.changedAt, previousStatus: a.previousStatus });
    expect({ available: b.available, held: b.held, paying: b.paying, countedAt: b.countedAt }).toEqual({ available: 2, held: 1, paying: 0, countedAt: new Date(NOW + 6000).toISOString() });
  });
});

describe('avgTicketsOf(평균 구매 매수, ADR-0219 결정 6)', () => {
  test('ST25_⑩ ADR0122_ 주문 99건이면 undefined이고 100건부터 값이 있다(경계)', () => {
    expect(avgTicketsOf(198, 99)).toBeUndefined();
    expect(avgTicketsOf(200, 100)).toBe(2);
  });

  test('ST25_⑩ ADR0122_ 주문이 0건이면 undefined다(0으로 나누지 않는다)', () => {
    expect(avgTicketsOf(0, 0)).toBeUndefined();
  });

  test.each([
    [201, 100, 2.01],
    [2346, 1000, 2.35],
    [2344, 1000, 2.34],
    [333, 150, 2.22],
    [100, 100, 1],
  ])('ST25_⑩ ADR0122_ 소수 둘째 자리로 반올림한다: %d석 ÷ %d건 = %d', (seats, orders, expected) => {
    expect(avgTicketsOf(seats, orders)).toBe(expected);
  });
});
