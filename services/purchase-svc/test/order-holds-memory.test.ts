// 주문 생성의 홀드 확인 시험 대역(inventory MemoryOrderHolds, BUILD_ORDER PRF-161). 운영 RedisOrderHolds·ORDER_HOLD_LUA와 같은 계약인지
// 메모리 좌석 저장소(실제 홀드 쓰기)·메모리 구매 세션 저장소(실제 홀드 기록)로 본다. 실제 Valkey로 도는 것은 test-int/order-holds.int.test.ts다.
// 시각은 주입 가짜 시계다(Redis TIME 대신).
import { fakeClock, uuidv7 } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  HOLD_TTL_MS,
  MemoryOrderHolds,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  type OrderHoldCheck,
  type OrderHoldQuery,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, held, holdInput, idx, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { newJti, openInput } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const NOT_FOUND: OrderHoldCheck = { status: 'NOT_FOUND' };
const STORE_UNAVAILABLE: OrderHoldCheck = { status: 'STORE_UNAVAILABLE' };

let clock = fakeClock({ now: NOW });
let seats: MemorySeatStore;
let sessions: MemoryPurchaseSessionStore;
let seatMap: MemorySeatMap;
let down = false;
let holds: MemoryOrderHolds;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  seats = new MemorySeatStore(clock);
  sessions = new MemoryPurchaseSessionStore(clock);
  seatMap = new MemorySeatMap();
  down = false;
  holds = new MemoryOrderHolds({ seats, sessions, seatMap, clock, unavailable: () => down });
});

/** 회차를 열고, 계정이 연 구매 세션으로 좌석을 실제 홀드 쓰기로 잡아 그 세션의 홀드 목록에 적는다(HoldSeats와 같은 차례: 정렬한 좌석 ID) */
async function heldWorld(o: { seatIds?: string[]; accountId?: string } = {}) {
  const eventId = newEvent();
  const accountId = o.accountId ?? ACCOUNT_A;
  const seatIds = [...(o.seatIds ?? ['B01', 'A01'])].sort();
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
  const keepUntilMs = NOW + 2 * DAY;
  await seats.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });
  const jti = newJti();
  expect((await sessions.open(openInput(clock, jti, { accountId, eventId }))).kind).toBe('CREATED');
  const holdId = uuidv7(clock);
  const h = held(await seats.hold(holdInput(eventId, seatIds, { accountId, purchaseSessionId: jti, holdId, keepUntilMs })));
  expect(await sessions.recordHold(jti, holdId, seatIds)).not.toBeNull();
  return { eventId, accountId, jti, holdId, seatIds, heldAtMs: h.heldAtMs };
}
type World = Awaited<ReturnType<typeof heldWorld>>;

const query = (w: World, over: Partial<OrderHoldQuery> = {}): OrderHoldQuery => ({ eventId: w.eventId, purchaseSessionId: w.jti, accountId: w.accountId, holdId: w.holdId, ...over });
const seatOf = (seatId: string) => {
  const d = SEAT_DEFS.find((x) => x.seatId === seatId)!;
  return { seatId, tierId: d.tierId, sectionId: d.sectionId };
};
const holdHash = (w: World, seatId: string) => seats.db.peek(w.eventId)!.holds.get(idx(seatId))!;

describe('MemoryOrderHolds.check: 맞는 홀드', () => {
  test('ST28_목록에 있고 홀드 Hash의 holdId·owner·psid가 같고 만료 전이면 OK: heldAtMs는 잡은 시각, 좌석은 목록 차례(좌석 ID 오름차순)에 등급·구역을 붙인다', async () => {
    const w = await heldWorld({ seatIds: ['B01', 'A01', 'A02'] });
    expect(await holds.check(query(w))).toEqual({ status: 'OK', heldAtMs: w.heldAtMs, seats: ['A01', 'A02', 'B01'].map(seatOf), limit: 4, kind: 'FAN' });
    expect(w.heldAtMs).toBe(NOW);
  });

  test('BAT051_ limit은 구매 세션 목록 없이 홀드 Hash lim을 읽고, lim이 없으면 undefined다 [ASVS v5.0.0-2.3.2]', async () => {
    const w = await heldWorld({ seatIds: ['A01'] });
    expect(await holds.limit({ ...query(w), seatIds: ['A01'] })).toBe(4);
    delete holdHash(w, 'A01').lim;
    expect(await holds.limit({ ...query(w), seatIds: ['A01'] })).toBeUndefined();
  });

  test('읽기만 한다: 확인 전후로 홀드 Hash·구매 세션의 홀드 목록이 같다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await heldWorld();
    const before = JSON.stringify({ a: holdHash(w, 'A01'), b: holdHash(w, 'B01'), list: [...sessions.holdsOf(w.jti)!] });
    await holds.check(query(w));
    await holds.check(query(w, { accountId: ACCOUNT_B }));
    expect(JSON.stringify({ a: holdHash(w, 'A01'), b: holdHash(w, 'B01'), list: [...sessions.holdsOf(w.jti)!] })).toBe(before);
  });
});

describe('MemoryOrderHolds.check: NOT_FOUND(가리지 않는다)', () => {
  test('ST28_다른 계정·없는 holdId·다른 구매 세션·다른 회차는 NOT_FOUND다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await heldWorld();
    expect(await holds.check(query(w, { accountId: ACCOUNT_B }))).toEqual(NOT_FOUND);
    expect(await holds.check(query(w, { holdId: uuidv7(clock) }))).toEqual(NOT_FOUND);
    const other = newJti();
    await sessions.open(openInput(clock, other, { accountId: w.accountId, eventId: w.eventId }));
    await sessions.recordHold(other, w.holdId, w.seatIds);
    // 다른 세션의 목록에 같은 holdId를 적어도 홀드 Hash의 psid가 달라 NOT_FOUND다
    expect(await holds.check(query(w, { purchaseSessionId: other }))).toEqual(NOT_FOUND);
    const otherEvent = newEvent();
    seatMap.put({ eventId: otherEvent, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
    await seats.openSale({ eventId: otherEvent, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    expect(await holds.check(query(w, { eventId: otherEvent }))).toEqual(NOT_FOUND);
  });

  test.each([
    ['holdId 빈 글', { holdId: '' }],
    ['holdId에 }', { holdId: 'a}b' }],
    ['holdId 65자', { holdId: 'a'.repeat(65) }],
    ['회차 ID에 }', { eventId: 'e}v' }],
    ['구매 세션 ID에 {', { purchaseSessionId: '{x' }],
  ])('%s처럼 키 조각 모양이 아니면 저장소 장애 흉내보다 먼저 NOT_FOUND다 [ASVS v5.0.0-1.2.4]', async (_label, over) => {
    const w = await heldWorld();
    down = true;
    expect(await holds.check(query(w, over))).toEqual(NOT_FOUND);
  });

  test('만료 시각이 지났으면(exp ≤ 지금) NOT_FOUND다. 좌석 하나만 지나도 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A03', 'A04'] });
    clock.advance(HOLD_TTL_MS - 1);
    expect((await holds.check(query(w))).status).toBe('OK');
    clock.advance(1);
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
    const w2 = await heldWorld({ seatIds: ['A05', 'A06'] });
    holdHash(w2, 'A06').exp = clock.now();
    expect(await holds.check(query(w2))).toEqual(NOT_FOUND);
  });

  test('좌석 하나의 홀드 Hash가 없거나(일부 해제) 좌석마다 heldAt이 다르면 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A07', 'A08'] });
    holdHash(w, 'A08').heldAt -= 1;
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
    const w2 = await heldWorld({ seatIds: ['A09', 'A10'] });
    seats.db.peek(w2.eventId)!.holds.delete(idx('A10'));
    expect(await holds.check(query(w2))).toEqual(NOT_FOUND);
  });

  test('L4_홀드 종류(kind)가 FAN이 아니면(PRIORITY 등, 우선 구매 주문은 GAT-135) NOT_FOUND다. 칸이 없어도 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A16', 'A17'] });
    expect(holdHash(w, 'A17').kind).toBe('FAN');
    holdHash(w, 'A17').kind = 'PRIORITY';
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
    const w2 = await heldWorld({ seatIds: ['A18'] });
    delete (holdHash(w2, 'A18') as Partial<{ kind: string }>).kind;
    expect(await holds.check(query(w2))).toEqual(NOT_FOUND);
  });

  test('목록의 좌석이 좌석맵 판에 없으면 NOT_FOUND다', async () => {
    const w = await heldWorld({ seatIds: ['A11'] });
    // 판을 좌석 A11이 없는 판으로 바꿔 넣는다
    seatMap.put({ eventId: w.eventId, layoutVersion: 'v2', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS.filter((d) => d.seatId !== 'A11'));
    expect(await holds.check(query(w))).toEqual(NOT_FOUND);
  });
});

describe('MemoryOrderHolds.check: STORE_UNAVAILABLE와 망가진 값', () => {
  test('좌석맵 판이 없거나, 세대 키가 없거나, 좌석 Redis 장애 흉내(unavailable)면 STORE_UNAVAILABLE이다', async () => {
    const w = await heldWorld();
    down = true;
    expect(await holds.check(query(w))).toEqual(STORE_UNAVAILABLE);
    down = false;
    const noMap = new MemoryOrderHolds({ seats, sessions, seatMap: new MemorySeatMap(), clock });
    expect(await noMap.check(query(w))).toEqual(STORE_UNAVAILABLE);
    seats.db.peek(w.eventId)!.epoch = undefined;
    expect(await holds.check(query(w))).toEqual(STORE_UNAVAILABLE);
  });

  test('홀드 Hash의 heldAt·exp가 0 이상 정수가 아니면 PEAKET_CORRUPT_KEY {그 hold 키} Error다(STORE_UNAVAILABLE·NOT_FOUND로 숨기지 않는다)', async () => {
    for (const bad of [-5, 1.5, Number.NaN]) {
      const w = await heldWorld({ seatIds: ['A12'] });
      holdHash(w, 'A12').heldAt = bad;
      await expect(holds.check(query(w))).rejects.toThrow(`PEAKET_CORRUPT_KEY ${seatKeys.hold(w.eventId, idx('A12'))}`);
      const w2 = await heldWorld({ seatIds: ['A13'] });
      holdHash(w2, 'A13').exp = bad;
      await expect(holds.check(query(w2))).rejects.toThrow(/CORRUPT_KEY/);
    }
  });

  test('주인이 다른 홀드 Hash는 시각 칸이 망가졌어도 NOT_FOUND다(Lua와 같은 차례: 주인 비교가 형식 검사보다 먼저)', async () => {
    const w = await heldWorld({ seatIds: ['A14'] });
    holdHash(w, 'A14').heldAt = -1;
    expect(await holds.check(query(w, { accountId: ACCOUNT_B }))).toEqual(NOT_FOUND);
  });

  test('구매 세션의 홀드 목록이 망가졌으면(빈 목록·좌석 ID 모양이 아님·같은 좌석 둘) Error다', async () => {
    for (const list of [[], ['A15', 'a}b'], ['A15', 'A15']]) {
      const w = await heldWorld({ seatIds: ['A15'] });
      // 시험 대역의 기록 Map을 망가뜨린다(holdsOf는 복사본이라 recordHold를 우회해 같은 jti의 목록을 바꿀 수 없다 → 질의만 바꾼 대역으로 본다)
      const broken = new MemoryOrderHolds({
        seats,
        sessions: { holdsOf: () => new Map([[w.holdId, list]]) } as unknown as MemoryPurchaseSessionStore,
        seatMap,
        clock,
      });
      await expect(broken.check(query(w))).rejects.toThrow(Error);
    }
  });
});
