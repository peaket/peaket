// 결제 접수의 회차 슬롯 읽기 운영 어댑터(SeatSlotReader, docs/features/payment.md §2 '결제 접수의 첫 구현', Lua 계약은 seat-slot-lua.ts, BUILD_ORDER PRF-162).
// 회차 슬롯의 읽기 전용 Lua 한 번(KEYS = [s:{event:E}:epoch, s:{event:E}:ctl])으로 세대 키와 판매 정지 사본을 함께 본다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { KEY_PART } from '../domain/hold.js';
import type { SeatCallOptions, SeatSlotRead, SeatSlotReader } from '../domain/ports.js';
import { guard, seatKeys } from './redis-seat-store.js';
import { SEAT_SLOT_READ_LUA } from './seat-slot-lua.js';

const SEAT_SLOT_READ = redisScript(SEAT_SLOT_READ_LUA);

const NOT_READY: SeatSlotRead = { status: 'NOT_READY' };
const PAUSED: SeatSlotRead = { status: 'PAUSED' };

/** Lua가 돌려준 판 번호 글(앞 0 없는 양의 10진 정수 10자리 이하, Lua가 이미 거른 모양) */
const GEN_TEXT = /^[1-9][0-9]{0,9}$/;
/** 판 번호 위 끝(int4, purchase_order.seat_gen 칸, 리뷰 고침 L5) */
export const SEAT_GEN_MAX = 2_147_483_647;

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const deadlineOf = (o: SeatCallOptions | undefined): { deadlineMs?: number } => (o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {});

/** 회차 ID가 키에 넣을 수 있는 모양(KEY_PART)인지 본다. 아니면 RangeError(값은 오류 글에 싣지 않는다) */
export function assertSlotEventId(eventId: unknown): asserts eventId is string {
  if (typeof eventId !== 'string' || !KEY_PART.test(eventId)) throw new RangeError('회차 ID가 좌석 키 조각 모양(영문·숫자·_- 1~64자)이 아니다');
}

/**
 * SeatSlotReader의 좌석 Redis 구현. 차례:
 * ① eventId가 KEY_PART가 아니면 RangeError(부르지 않는다)
 * ② SEAT_SLOT_READ_LUA(KEYS = [seatKeys.epoch(E), seatKeys.ctl(E)], ARGV 없음, o.deadlineMs) → NOT_READY, PAUSED, OK(gen 글 → 1 이상 안전한 정수)
 * 일시 장애는 guard가 SeatStoreUnavailable로 바꿔 던진다. 스크립트 오류(CORRUPT_KEY·WRONGTYPE)·모르는 결과는 Error로 던진다
 */
export class RedisSeatSlots implements SeatSlotReader {
  /** main.ts가 좌석 Redis(SEAT_REDIS와 같은 연결)로 만든다 */
  constructor(private readonly redis: HotRedis) {}

  async read(eventId: string, o?: SeatCallOptions): Promise<SeatSlotRead> {
    assertSlotEventId(eventId);
    const keys = [seatKeys.epoch(eventId), seatKeys.ctl(eventId)];
    const r = await guard(this.redis.evalScript(SEAT_SLOT_READ, keys, [], deadlineOf(o)));
    if (!Array.isArray(r) || r.length < 1) throw new Error(`회차 슬롯 읽기 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY' && r.length === 1) return NOT_READY;
    if (kind === 'PAUSED' && r.length === 1) return PAUSED;
    if (kind === 'OK' && r.length === 2) {
      const text = str(r[1]);
      const gen = Number(text);
      if (!GEN_TEXT.test(text) || gen > SEAT_GEN_MAX) throw new Error('회차 슬롯 읽기 Lua가 돌려준 판 번호가 1~2147483647의 정수 글이 아니다');
      return { status: 'OK', gen };
    }
    throw new Error(`회차 슬롯 읽기 Lua가 모르는 결과를 돌려줬다: ${kind}`);
  }
}
