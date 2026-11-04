// 결제 접수의 회차 슬롯 읽기 시험 대역(inventory MemorySeatSlots, BUILD_ORDER PRF-162). 운영 RedisSeatSlots·SEAT_SLOT_READ_LUA와 같은 계약인지
// 메모리 좌석 저장소(MemorySeatStore의 세대 키 epoch·판매 정지 사본 ctl)로 본다. 실제 Valkey로 도는 것은 test-int(다른 담당)다.
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { INITIAL_SEAT_GEN, MemorySeatSlots, MemorySeatStore, SeatStoreUnavailable, seatKeys } from '../src/modules/inventory/index.js';
import { DAY, newEvent, SEAT_COUNT } from './hold-cases.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
let seats: MemorySeatStore;
let down = false;
let slots: MemorySeatSlots;

beforeEach(() => {
  seats = new MemorySeatStore(fakeClock({ now: NOW }));
  down = false;
  slots = new MemorySeatSlots({ seats, unavailable: () => down });
});

/** 판매를 연 회차(세대 키 epoch, gen = 1) */
async function opened(): Promise<string> {
  const eventId = newEvent();
  await seats.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
  return eventId;
}

/** 키 묶음 전체의 모습(읽기가 아무것도 바꾸지 않았는지 보려고) */
const snapshotOf = (eventId: string) => {
  const ev = seats.db.peek(eventId);
  return JSON.stringify({ epoch: ev?.epoch, ctl: ev ? [...ev.ctl] : undefined, expireAt: ev ? [...ev.expireAt] : undefined });
};

describe('MemorySeatSlots.read', () => {
  test('FR011_판매를 연 회차는 OK이고 gen은 판매 열기가 둔 1(INITIAL_SEAT_GEN)이다', async () => {
    const e = await opened();
    expect(await slots.read(e)).toEqual({ status: 'OK', gen: INITIAL_SEAT_GEN });
    expect(INITIAL_SEAT_GEN).toBe(1);
  });

  test('FR011_gen은 세대 키의 gen 칸이다(다시 만들기 판 번호 7)', async () => {
    const e = await opened();
    seats.db.peek(e)!.epoch!.gen = 7;
    expect(await slots.read(e)).toEqual({ status: 'OK', gen: 7 });
  });

  test('FR011_세대 키에 gen 칸이 없으면 1로 본다', async () => {
    const e = await opened();
    delete seats.db.peek(e)!.epoch!.gen;
    expect(await slots.read(e)).toEqual({ status: 'OK', gen: 1 });
  });

  test('NFR015_회차 키 묶음이 없거나 세대 키(epoch)가 없으면 NOT_READY다', async () => {
    expect(await slots.read(newEvent())).toEqual({ status: 'NOT_READY' });
    const e = newEvent();
    seats.db.event(e).ctl.set('paused', '1');
    // 세대 키가 없으면 정지 사본보다 NOT_READY가 먼저다
    expect(await slots.read(e)).toEqual({ status: 'NOT_READY' });
  });

  test.each([['paused'], ['allPaused'], ['suspended']])('FR011_판매 정지 사본 ctl의 %s가 1이면 PAUSED다', async (field) => {
    const e = await opened();
    seats.db.peek(e)!.ctl.set(field, '1');
    expect(await slots.read(e)).toEqual({ status: 'PAUSED' });
  });

  test('FR011_정지 칸이 1이 아니거나(0·빈 글) 다른 칸(rev·cmd·allRev)만 있으면 OK다', async () => {
    const e = await opened();
    const ctl = seats.db.peek(e)!.ctl;
    ctl.set('paused', '0');
    ctl.set('allPaused', '');
    ctl.set('rev', '1');
    ctl.set('cmd', '1');
    ctl.set('allRev', '1');
    expect(await slots.read(e)).toEqual({ status: 'OK', gen: 1 });
  });

  test.each([[0], [-1], [1.5], [2 ** 31], [1e15 - 1], [1e15], [Number.NaN]])(
    'ASVS16.5.3_세대 키의 gen 칸이 %s면 망가진 키라 PEAKET_CORRUPT_KEY {epoch 키} Error를 던진다(위 끝은 int4, 리뷰 고침 L5) [ASVS v5.0.0-16.5.3]',
    async (gen) => {
      const e = await opened();
      seats.db.peek(e)!.epoch!.gen = gen;
      await expect(slots.read(e)).rejects.toThrow(`PEAKET_CORRUPT_KEY ${seatKeys.epoch(e)}`);
    },
  );

  test('FR011_gen 칸의 큰 경계: int4 위 끝 2147483647은 OK다(purchase_order.seat_gen에 들어간다, 리뷰 고침 L5)', async () => {
    const e = await opened();
    seats.db.peek(e)!.epoch!.gen = 2_147_483_647;
    expect(await slots.read(e)).toEqual({ status: 'OK', gen: 2_147_483_647 });
  });

  test('FR011_망가진 gen은 정지보다 먼저다: gen이 틀리고 paused가 1이어도 던진다', async () => {
    const e = await opened();
    seats.db.peek(e)!.epoch!.gen = 0;
    seats.db.peek(e)!.ctl.set('paused', '1');
    await expect(slots.read(e)).rejects.toThrow('PEAKET_CORRUPT_KEY');
  });

  test('NFR015_장애 흉내(unavailable 참)면 SeatStoreUnavailable을 던진다', async () => {
    const e = await opened();
    down = true;
    await expect(slots.read(e)).rejects.toBeInstanceOf(SeatStoreUnavailable);
  });

  test('FR011_eventId가 KEY_PART 모양이 아니면 저장소를 보지 않고 RangeError다(장애 흉내보다 먼저)', async () => {
    down = true;
    for (const bad of ['', 'a b', 'x'.repeat(65), 'ev:1', '{e}']) await expect(slots.read(bad), bad).rejects.toBeInstanceOf(RangeError);
  });

  test('FR011_읽기만 한다: 키 묶음이 바뀌지 않고, 없는 회차의 키 묶음을 만들지 않는다', async () => {
    const e = await opened();
    seats.db.peek(e)!.ctl.set('paused', '1');
    const before = snapshotOf(e);
    await slots.read(e);
    await slots.read(e, { deadlineMs: 5 });
    expect(snapshotOf(e)).toBe(before);
    const missing = newEvent();
    await slots.read(missing);
    expect(seats.db.peek(missing)).toBeUndefined();
  });
});
