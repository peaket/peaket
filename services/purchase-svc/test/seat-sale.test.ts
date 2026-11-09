// 판매 확정(Hard Sale) 저장소의 값과 입력 검사(docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현', BUILD_ORDER PRF-140 ①).
// 도메인 검사 함수(sortedSeatIds·assertSeatSaleOrder·assertReserveInput·assertSeatSaleRelease)는 DB 없이 시험한다. 실제 DB 동작은 test-int/purchase-migration.int.test.ts다.
// 입력이 틀리면 저장소를 부르기 전에 RangeError로 거절한다. 좌석 수가 한도보다 많은 것은 DB가 가리는 결과(QUOTA_EXCEEDED)라 여기서 거절하지 않는다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  assertReserveInput,
  assertSeatSaleOrder,
  assertSeatSaleRelease,
  MAX_SALE_SEATS,
  MAX_SEATS,
  MemoryPurchaseSessions,
  type ReserveInput,
  SALE_UUID_PATTERN,
  SEAT_SALE_STATUSES,
  SEAT_SALES,
  type SeatSaleOrder,
  type SeatSaleRelease,
  type SeatSales,
  sortedSeatIds,
} from '../src/modules/inventory/index.js';

/** 소문자 UUID 글(모양만 맞다. n마다 다른 값) */
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** 첫 글자만 다른 소문자 UUID(문자 코드 순 시험용) */
const lead = (c: string): string => `${c}0000000-0000-4000-8000-000000000001`;
/** 대문자 글자가 든 UUID(숫자만 있는 UUID는 대문자로 바꿔도 같아서 쓸 수 없다) */
const UPPER_UUID = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
const EVENT = uuid(0xe1);
const ORDER = uuid(0x0d);
const ACCOUNT = uuid(0xac);
const seats = (n: number): string[] => Array.from({ length: n }, (_, i) => uuid(0x100 + i));

/** 함수가 던진 것을 받는다(던지지 않으면 undefined) */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}
/** RangeError로 거절됐는지 본다. field가 있으면 메시지에 그 필드 이름이 드러나야 한다 */
function expectRange(fn: () => unknown, field?: string): void {
  const e = caught(fn);
  expect(e, '입력은 저장소를 부르기 전에 RangeError로 거절돼야 한다').toBeInstanceOf(RangeError);
  if (field) expect((e as RangeError).message, `메시지에 틀린 필드 이름(${field})이 드러나야 한다`).toContain(field);
}

const order = (o: Partial<SeatSaleOrder> = {}): SeatSaleOrder => ({ eventId: EVENT, orderId: ORDER, seatIds: seats(2), ...o });
const reserveIn = (o: Partial<ReserveInput> = {}): ReserveInput => ({ ...order(), accountId: ACCOUNT, limit: 4, ...o });
const releaseIn = (o: Partial<SeatSaleRelease> = {}): SeatSaleRelease => ({ ...order(), accountId: ACCOUNT, ...o });

/** UUID 자리에 오면 안 되는 값들(이름, 값). 모양 규칙(SALE_UUID_PATTERN)의 경계다 */
const BAD_UUIDS: [string, unknown][] = [
  ['빈 글', ''],
  ['UUID가 아닌 글', 'not-a-uuid'],
  ['대문자 UUID', UPPER_UUID],
  ['앞 글자만 대문자인 UUID', `A${uuid(1).slice(1)}`],
  ['하이픈 없는 32자', uuid(1).replaceAll('-', '')],
  ['중괄호로 싼 UUID', `{${uuid(1)}}`],
  ['앞에 공백이 낀 UUID', ` ${uuid(1)}`],
  ['뒤에 공백이 낀 UUID', `${uuid(1)} `],
  ['뒤에 줄바꿈이 붙은 UUID', `${uuid(1)}\n`],
  ['한 글자 모자란 UUID', uuid(1).slice(0, -1)],
  ['한 글자 넘치는 UUID', `${uuid(1)}0`],
  ['16진수가 아닌 글자(g)가 든 UUID', `g${uuid(1).slice(1)}`],
  ['urn 접두가 붙은 UUID', `urn:uuid:${uuid(1)}`],
  ['숫자', 123],
  ['null', null],
  ['undefined', undefined],
  ['객체', {}],
  ['문자열 객체(typeof가 object)', new String(uuid(1))],
];

describe('상수', () => {
  test('MAX_SALE_SEATS는 홀드 요청 상한 MAX_SEATS와 같고 10이다', () => {
    expect(MAX_SALE_SEATS).toBe(MAX_SEATS);
    expect(MAX_SALE_SEATS).toBe(10);
  });

  test('SEAT_SALE_STATUSES는 표의 CHECK 제약과 같은 PENDING·SOLD·RETURNED 셋이다(차례도 같다)', () => {
    expect([...SEAT_SALE_STATUSES]).toEqual(['PENDING', 'SOLD', 'RETURNED']);
  });

  test('SALE_UUID_PATTERN은 소문자 UUID 36자만 받는다', () => {
    expect(SALE_UUID_PATTERN.test(uuid(1))).toBe(true);
    // UUIDv7처럼 판·변형 칸이 다른 값도 모양은 같다
    expect(SALE_UUID_PATTERN.test('0190f3a1-7c2e-7a00-8000-0000000000aa')).toBe(true);
    for (const [name, v] of BAD_UUIDS.filter(([, x]) => typeof x === 'string')) {
      expect(SALE_UUID_PATTERN.test(v as string), name).toBe(false);
    }
  });
});

describe('sortedSeatIds', () => {
  test('좌석 하나는 같은 값을 든 새 배열로 돌려준다', () => {
    const input = [uuid(5)];
    const out = sortedSeatIds(input);
    expect(out).toEqual([uuid(5)]);
    expect(out).not.toBe(input);
  });

  test('좌석 10개(상한)도 받고, 거꾸로 온 순서를 오름차순으로 돌려준다', () => {
    const asc = seats(MAX_SALE_SEATS);
    const out = sortedSeatIds([...asc].reverse());
    expect(out).toHaveLength(10);
    expect(out).toEqual(asc);
  });

  test('문자 코드 순으로 정렬한다: 숫자가 영문자보다 앞이고 영문자는 a부터 f 순이다', () => {
    const out = sortedSeatIds([lead('f'), lead('9'), lead('a'), lead('0'), lead('b'), lead('1'), lead('e')]);
    expect(out).toEqual([lead('0'), lead('1'), lead('9'), lead('a'), lead('b'), lead('e'), lead('f')]);
  });

  test('앞부분이 같으면 뒤의 첫 다른 글자로 정한다', () => {
    const a = '01234567-89ab-4cde-8f01-23456789abcd';
    const b = '01234567-89ab-4cde-8f01-23456789abce';
    const c = '01234567-89ab-4cde-8f02-000000000000';
    expect(sortedSeatIds([c, b, a])).toEqual([a, b, c]);
  });

  test('기본 정렬(UTF-16 코드 단위 순, `<` 비교)과 결과가 같다: 섞인 10개', () => {
    // 첫 글자가 숫자와 영문자에 고루 퍼지고 뒤 글자도 다른 값들을 일부러 뒤섞는다
    const ids = ['f3', 'a9', '07', 'c1', '9e', 'b0', '2d', 'e5', '81', 'd4'].map((p, i) => `${p}${i}00000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    expect(sortedSeatIds(ids)).toEqual([...ids].sort());
  });

  test('입력 배열을 바꾸지 않는다(얼린 배열도 받는다)', () => {
    const input = Object.freeze([lead('c'), lead('a'), lead('b')]);
    const before = [...input];
    const out = sortedSeatIds(input);
    expect(out).toEqual([lead('a'), lead('b'), lead('c')]);
    expect([...input]).toEqual(before);
    expect(out).not.toBe(input);
  });

  test('이미 정렬된 입력도 새 배열로 같은 순서를 돌려준다', () => {
    const input = seats(3);
    const out = sortedSeatIds(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test('좌석이 하나도 없으면(0개) RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => sortedSeatIds([]));
  });

  test('11개(상한 + 1)는 RangeError이고 10개는 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => sortedSeatIds(seats(MAX_SALE_SEATS + 1)));
    expect(sortedSeatIds(seats(MAX_SALE_SEATS))).toHaveLength(MAX_SALE_SEATS);
  });

  test.each(BAD_UUIDS)('좌석 ID가 %s이면 RangeError다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => sortedSeatIds([bad as string]));
  });

  test.each(['첫째', '가운데', '마지막'])('좌석 10개 가운데 %s 하나만 틀려도 RangeError다 [ASVS v5.0.0-2.2.1]', (where) => {
    const ids = seats(MAX_SALE_SEATS);
    ids[where === '첫째' ? 0 : where === '가운데' ? 5 : MAX_SALE_SEATS - 1] = UPPER_UUID;
    expectRange(() => sortedSeatIds(ids));
  });

  test('같은 좌석 ID가 두 번 들어 있으면 RangeError다(붙어 있어도 떨어져 있어도) [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => sortedSeatIds([uuid(1), uuid(1)]));
    expectRange(() => sortedSeatIds([uuid(1), uuid(2), uuid(3), uuid(1)]));
    const ten = seats(MAX_SALE_SEATS);
    ten[MAX_SALE_SEATS - 1] = ten[0]!;
    expectRange(() => sortedSeatIds(ten));
  });

  test('대소문자만 다른 같은 ID는 중복 검사에 이르기 전에 모양에서 거절한다 [ASVS v5.0.0-2.2.1]', () => {
    const id = uuid(0xabcdef);
    expect(id).not.toBe(id.toUpperCase());
    expectRange(() => sortedSeatIds([id, id.toUpperCase()]));
    // 대문자만 따로 있어도 거절(소문자로 바꿔 받아 주지 않는다)
    expectRange(() => sortedSeatIds([id.toUpperCase()]));
  });
});

describe('assertSeatSaleOrder', () => {
  test('올바른 입력(좌석 2개)은 던지지 않고 아무것도 돌려주지 않는다', () => {
    expect(assertSeatSaleOrder(order())).toBeUndefined();
  });

  test('좌석 1개와 10개(경계)는 통과한다', () => {
    expect(() => assertSeatSaleOrder(order({ seatIds: seats(1) }))).not.toThrow();
    expect(() => assertSeatSaleOrder(order({ seatIds: seats(MAX_SALE_SEATS) }))).not.toThrow();
  });

  test('입력 객체와 좌석 배열을 바꾸지 않는다', () => {
    const o = Object.freeze({ eventId: EVENT, orderId: ORDER, seatIds: Object.freeze(seats(3)) });
    expect(() => assertSeatSaleOrder(o)).not.toThrow();
  });

  test.each(BAD_UUIDS)('eventId가 %s이면 RangeError이고 메시지에 eventId가 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertSeatSaleOrder(order({ eventId: bad as string })), 'eventId');
  });

  test.each(BAD_UUIDS)('orderId가 %s이면 RangeError이고 메시지에 orderId가 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertSeatSaleOrder(order({ orderId: bad as string })), 'orderId');
  });

  test('seatIds를 망가뜨리면(0개·11개·틀린 ID·중복) RangeError이고 메시지에 seatIds가 든다 [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => assertSeatSaleOrder(order({ seatIds: [] })), 'seatIds');
    expectRange(() => assertSeatSaleOrder(order({ seatIds: seats(MAX_SALE_SEATS + 1) })), 'seatIds');
    expectRange(() => assertSeatSaleOrder(order({ seatIds: [uuid(1), 'A01'] })), 'seatIds');
    expectRange(() => assertSeatSaleOrder(order({ seatIds: [uuid(1), UPPER_UUID] })), 'seatIds');
    expectRange(() => assertSeatSaleOrder(order({ seatIds: [uuid(1), uuid(1)] })), 'seatIds');
  });

  test('필드가 아예 없어도 RangeError다(eventId·orderId·seatIds 각각) [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => assertSeatSaleOrder({ orderId: ORDER, seatIds: seats(1) } as unknown as SeatSaleOrder), 'eventId');
    expectRange(() => assertSeatSaleOrder({ eventId: EVENT, seatIds: seats(1) } as unknown as SeatSaleOrder), 'orderId');
    expectRange(() => assertSeatSaleOrder({ eventId: EVENT, orderId: ORDER } as unknown as SeatSaleOrder), 'seatIds');
  });
});

describe('assertReserveInput', () => {
  test('올바른 입력은 던지지 않는다(pendingUntilMs 없음)', () => {
    expect(assertReserveInput(reserveIn())).toBeUndefined();
  });

  test('좌석 수가 한도보다 많아도 RangeError가 아니다(그건 DB 결과 QUOTA_EXCEEDED다) [ASVS v5.0.0-2.2.1]', () => {
    expect(() => assertReserveInput(reserveIn({ seatIds: seats(3), limit: 2 }))).not.toThrow();
    expect(() => assertReserveInput(reserveIn({ seatIds: seats(MAX_SALE_SEATS), limit: 1 }))).not.toThrow();
    // 같은 수(경계)도 물론 통과한다
    expect(() => assertReserveInput(reserveIn({ seatIds: seats(2), limit: 2 }))).not.toThrow();
  });

  test('limit은 1 이상의 안전한 정수다: 1과 가장 큰 안전한 정수는 통과한다', () => {
    expect(() => assertReserveInput(reserveIn({ limit: 1 }))).not.toThrow();
    expect(() => assertReserveInput(reserveIn({ limit: Number.MAX_SAFE_INTEGER }))).not.toThrow();
  });

  test.each<[string, unknown]>([
    ['0', 0],
    ['-0', -0],
    ['-1', -1],
    ['소수 1.5', 1.5],
    ['소수 0.9', 0.9],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['안전한 정수를 넘는 2^53', 2 ** 53],
    ['글 "3"', '3'],
    ['null', null],
    ['undefined', undefined],
    ['bigint 3n', 3n],
  ])('limit이 %s이면 RangeError이고 메시지에 limit이 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertReserveInput(reserveIn({ limit: bad as number })), 'limit');
  });

  test('pendingUntilMs는 없거나 양의 안전한 정수다: 없음·undefined·1·큰 시각·가장 큰 안전한 정수는 통과한다', () => {
    expect(() => assertReserveInput(reserveIn())).not.toThrow();
    expect(() => assertReserveInput({ ...reserveIn(), pendingUntilMs: undefined })).not.toThrow();
    expect(() => assertReserveInput(reserveIn({ pendingUntilMs: 1 }))).not.toThrow();
    expect(() => assertReserveInput(reserveIn({ pendingUntilMs: Date.parse('2026-11-04T03:00:00.000Z') }))).not.toThrow();
    expect(() => assertReserveInput(reserveIn({ pendingUntilMs: Number.MAX_SAFE_INTEGER }))).not.toThrow();
  });

  test.each<[string, unknown]>([
    ['0', 0],
    ['-1', -1],
    ['소수 1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['안전한 정수를 넘는 2^53', 2 ** 53],
    ['날짜 글', '2026-11-04T03:00:00.000Z'],
    ['숫자 글', '1793783485102'],
    ['Date 객체', new Date(1793783485102)],
  ])('pendingUntilMs가 %s이면 RangeError이고 메시지에 pendingUntilMs가 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertReserveInput(reserveIn({ pendingUntilMs: bad as number })), 'pendingUntilMs');
  });

  test.each(BAD_UUIDS)('accountId가 %s이면 RangeError이고 메시지에 accountId가 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertReserveInput(reserveIn({ accountId: bad as string })), 'accountId');
  });

  test('eventId·orderId·seatIds를 하나씩 망가뜨려도 각자의 이름으로 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => assertReserveInput(reserveIn({ eventId: 'x' })), 'eventId');
    expectRange(() => assertReserveInput(reserveIn({ orderId: UPPER_UUID })), 'orderId');
    expectRange(() => assertReserveInput(reserveIn({ seatIds: [] })), 'seatIds');
    expectRange(() => assertReserveInput(reserveIn({ seatIds: seats(MAX_SALE_SEATS + 1) })), 'seatIds');
    expectRange(() => assertReserveInput(reserveIn({ seatIds: [uuid(2), uuid(2)] })), 'seatIds');
  });

  test('필드가 아예 없어도 RangeError다(accountId·limit) [ASVS v5.0.0-2.2.1]', () => {
    const { accountId: _a, ...noAccount } = reserveIn();
    const { limit: _l, ...noLimit } = reserveIn();
    expectRange(() => assertReserveInput(noAccount as unknown as ReserveInput), 'accountId');
    expectRange(() => assertReserveInput(noLimit as unknown as ReserveInput), 'limit');
  });

  test('입력 객체를 바꾸지 않는다', () => {
    const input = Object.freeze({ ...reserveIn({ pendingUntilMs: 1_793_783_485_102 }), seatIds: Object.freeze(seats(2)) });
    expect(() => assertReserveInput(input)).not.toThrow();
  });
});

describe('assertSeatSaleRelease', () => {
  test('올바른 입력은 던지지 않는다', () => {
    expect(assertSeatSaleRelease(releaseIn())).toBeUndefined();
  });

  test('한도(limit)는 받지 않는 입력이다: limit이 없어도 통과한다', () => {
    const r = releaseIn();
    expect('limit' in r).toBe(false);
    expect(() => assertSeatSaleRelease(r)).not.toThrow();
  });

  test('좌석 1개와 10개(경계)는 통과하고 0개와 11개는 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expect(() => assertSeatSaleRelease(releaseIn({ seatIds: seats(1) }))).not.toThrow();
    expect(() => assertSeatSaleRelease(releaseIn({ seatIds: seats(MAX_SALE_SEATS) }))).not.toThrow();
    expectRange(() => assertSeatSaleRelease(releaseIn({ seatIds: [] })), 'seatIds');
    expectRange(() => assertSeatSaleRelease(releaseIn({ seatIds: seats(MAX_SALE_SEATS + 1) })), 'seatIds');
  });

  test.each(BAD_UUIDS)('accountId가 %s이면 RangeError이고 메시지에 accountId가 든다 [ASVS v5.0.0-2.2.1]', (_name, bad) => {
    expectRange(() => assertSeatSaleRelease(releaseIn({ accountId: bad as string })), 'accountId');
  });

  test('accountId가 아예 없어도 RangeError다(seat_sale에는 계정 칸이 없어 한도 행을 못 찾는다) [ASVS v5.0.0-2.2.1]', () => {
    const { accountId: _a, ...noAccount } = releaseIn();
    expectRange(() => assertSeatSaleRelease(noAccount as unknown as SeatSaleRelease), 'accountId');
  });

  test('eventId·orderId·seatIds를 하나씩 망가뜨려도 각자의 이름으로 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expectRange(() => assertSeatSaleRelease(releaseIn({ eventId: '' })), 'eventId');
    expectRange(() => assertSeatSaleRelease(releaseIn({ orderId: `{${uuid(1)}}` })), 'orderId');
    expectRange(() => assertSeatSaleRelease(releaseIn({ seatIds: [uuid(1), uuid(1)] })), 'seatIds');
    expectRange(() => assertSeatSaleRelease(releaseIn({ seatIds: [uuid(1), uuid(2).replaceAll('-', '')] })), 'seatIds');
  });
});

describe('조립', () => {
  test('AppModule.register에 seatSales를 주면 SEAT_SALES 토큰으로 그 객체가 나오고, 안 주면 토큰이 없다', async () => {
    const fake: SeatSales = {
      reserve: async () => ({ status: 'RESERVED' }),
      markSold: async () => 0,
      releasePending: async () => 0,
      returnSold: async () => 0,
    };
    const quiet = new Writable({ write: (_c, _e, cb) => cb() });
    const boot = async (seatSales?: SeatSales) => {
      const sessions = new MemoryPurchaseSessions();
      return createService({
        name: 'purchase-svc',
        module: AppModule.register({ memory: true, sessions, ...(seatSales ? { seatSales } : {}) }),
        purchaseSessions: sessions,
        env: { PEAKET_ENV: 'ci' },
        clock: fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') }),
        logDestination: quiet,
      });
    };
    const withSales = await boot(fake);
    const without = await boot();
    try {
      expect(withSales.app.get(SEAT_SALES)).toBe(fake);
      expect(() => without.app.get(SEAT_SALES)).toThrow();
    } finally {
      await Promise.all([withSales.close(), without.close()]);
    }
  });
});
