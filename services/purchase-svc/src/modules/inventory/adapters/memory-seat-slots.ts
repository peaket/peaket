// 결제 접수의 회차 슬롯 읽기 시험 대역(SeatSlotReader, BUILD_ORDER PRF-162). RedisSeatSlots·SEAT_SLOT_READ_LUA(seat-slot-lua.ts)와 같은 계약을 따른다:
// 같은 사례에서 같은 결과를 낸다. 키 모형은 MemorySeatStore의 회차 묶음(db.peek(eventId)의 epoch·ctl)이다.
import { SeatStoreUnavailable } from '../domain/hold.js';
import { INITIAL_SEAT_GEN } from '../domain/pin.js';
import type { SeatCallOptions, SeatSlotRead, SeatSlotReader } from '../domain/ports.js';
import type { MemorySeatStore } from './memory-seat-store.js';
import { assertSlotEventId, SEAT_GEN_MAX } from './redis-seat-slots.js';
import { seatKeys } from './redis-seat-store.js';

export interface MemorySeatSlotsDeps {
  /** 세대 키(epoch.gen)·판매 정지 사본(ctl) */
  seats: MemorySeatStore;
  /** 있으면 참일 때 SeatStoreUnavailable을 던진다(좌석 Redis 장애 흉내) */
  unavailable?: () => boolean;
}

const NOT_READY: SeatSlotRead = { status: 'NOT_READY' };
const PAUSED: SeatSlotRead = { status: 'PAUSED' };
/** 정지 칸(정확히 '1'일 때만 정지, Lua와 같다) */
const PAUSE_FIELDS = ['paused', 'allPaused', 'suspended'] as const;

/**
 * 차례는 RedisSeatSlots와 같다: eventId 모양(KEY_PART 아니면 RangeError) → 장애 흉내(SeatStoreUnavailable) → 회차 묶음이 없거나 epoch가 없으면 NOT_READY
 * → epoch.gen이 있는데 1~2147483647(int4, 리뷰 고침 L5) 정수가 아니면 'PEAKET_CORRUPT_KEY {epoch 키}' Error → ctl의 paused·allPaused·suspended 가운데 '1'이 있으면 PAUSED
 * → OK(gen, 없으면 INITIAL_SEAT_GEN). 아무것도 바꾸지 않는다
 */
export class MemorySeatSlots implements SeatSlotReader {
  constructor(private readonly deps: MemorySeatSlotsDeps) {}

  async read(eventId: string, _o?: SeatCallOptions): Promise<SeatSlotRead> {
    assertSlotEventId(eventId);
    if (this.deps.unavailable?.()) throw new SeatStoreUnavailable(new Error('좌석 Redis 장애 흉내'));
    // 읽기 전용: 없는 회차의 키 묶음을 만들지 않는다(event()가 아니라 peek())
    const ev = this.deps.seats.db.peek(eventId);
    if (!ev?.epoch) return NOT_READY;
    const gen = ev.epoch.gen;
    if (gen !== undefined && !(Number.isSafeInteger(gen) && gen >= 1 && gen <= SEAT_GEN_MAX)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.epoch(eventId)}`);
    if (PAUSE_FIELDS.some((f) => ev.ctl.get(f) === '1')) return PAUSED;
    return { status: 'OK', gen: gen ?? INITIAL_SEAT_GEN };
  }
}
