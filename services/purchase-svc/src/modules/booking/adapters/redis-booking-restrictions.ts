// 예매 제한 사본 읽기(좌석 Redis s:rst:{account} Hash, docs/data.md §3 s:rst 행, docs/features/payment.md §2 '예매 제한 확인'·'주문 생성의 첫 구현' 예매 제한 사본, BUILD_ORDER PRF-161).
// 칸: st(ACTIVE·LIFTED), until(끝 시각 유닉스 밀리초, 비면 끝 없음), rid(제한 ID), ver(판 번호). 주문 생성은 네 칸을 함께 읽고(HMGET 한 번, 일반 명령) 판정은 st·until로 한다.
// 계정 단위라 회차 해시 태그 없이 흩는다. 사본을 쓰는 쪽(SetBookingRestriction 받기, 판 번호가 클 때만)은 GAT-310이다.
import { type HotRedis, isRedisOutOfMemory, isRedisUnavailable } from '@peaket/platform';
import { type BookingRestriction, type BookingRestrictions, OrderSeatStoreUnavailable } from '../domain/ports.js';

/** 키 이름(계정 ID는 소문자 UUID라 해시 태그를 깨지 않는다. 그래도 어댑터가 모양을 다시 본다) */
export const bookingRestrictionKey = (accountId: string): string => `s:rst:${accountId}`;

/** 계정 ID 모양(소문자 UUID) */
const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 앞 0 없는 0 이상 10진 정수 글 */
const MS_TEXT = /^(0|[1-9][0-9]*)$/;

const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * BookingRestrictions의 좌석 Redis 구현. read 차례: accountId가 소문자 UUID가 아니면 RangeError(부르지 않는다) → HMGET s:rst:{account} st until rid ver(네 칸 함께)
 * → 네 칸이 모두 없으면 undefined(사본 없음 = 제한 없음) → 다른 칸이 있는데 st가 없거나, st가 ACTIVE·LIFTED가 아니거나, until이 빈 글이 아닌데 앞 0 없는 0 이상 안전한 정수 글이
 * 아니면 Error(망가진 사본. 제한 없음으로 숨기지 않는다, 리뷰 고침 L3) → { st, untilMs? }. rid·ver는 있는지만 본다(값 판정은 쓰는 쪽 GAT-310).
 * 일시 장애(platform isRedisUnavailable)·메모리 부족은 OrderSeatStoreUnavailable로 바꿔 던진다
 */
export class RedisBookingRestrictions implements BookingRestrictions {
  constructor(private readonly redis: HotRedis) {}

  async read(accountId: string): Promise<BookingRestriction | undefined> {
    if (typeof accountId !== 'string' || !ACCOUNT_UUID.test(accountId)) throw new RangeError('예매 제한 사본의 계정 ID가 소문자 UUID가 아니다');
    const key = bookingRestrictionKey(accountId);
    let r: unknown;
    try {
      r = await this.redis.command(['HMGET', key, 'st', 'until', 'rid', 'ver'], { key });
    } catch (e) {
      // WRONGTYPE 같은 버그는 일시 장애로 숨기지 않고 그대로 던진다
      if (isRedisUnavailable(e) || isRedisOutOfMemory(e)) throw new OrderSeatStoreUnavailable(e);
      throw e;
    }
    if (!Array.isArray(r) || r.length !== 4) throw new Error('예매 제한 사본 읽기가 모르는 값을 돌려줬다');
    const [st, until, rid, ver] = r as unknown[];
    if ([st, until, rid, ver].every(isNil)) return undefined;
    if (isNil(st)) throw new Error('예매 제한 사본에 st 칸이 없는데 다른 칸이 있다(망가진 사본)');
    // 오류 글에 받은 값을 싣지 않는다(사본 칸 이름만)
    const state = str(st);
    if (state !== 'ACTIVE' && state !== 'LIFTED') throw new Error('예매 제한 사본의 st 칸이 ACTIVE·LIFTED가 아니다(망가진 사본)');
    const untilText = isNil(until) ? '' : str(until);
    if (untilText === '') return { st: state };
    const untilMs = Number(untilText);
    if (!MS_TEXT.test(untilText) || !Number.isSafeInteger(untilMs)) throw new Error('예매 제한 사본의 until 칸이 0 이상 정수 글이 아니다(망가진 사본)');
    return { st: state, untilMs };
  }
}

/** 시험 대역: 계정 → 사본(없으면 제한 없음). failWith가 있으면 그 오류를 던진다 */
export class MemoryBookingRestrictions implements BookingRestrictions {
  readonly rows = new Map<string, BookingRestriction>();
  failWith: unknown;

  async read(accountId: string): Promise<BookingRestriction | undefined> {
    if (this.failWith !== undefined) throw this.failWith;
    const row = this.rows.get(accountId);
    return row ? { ...row } : undefined;
  }
}
