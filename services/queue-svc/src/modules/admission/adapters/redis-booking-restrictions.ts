// 예매 제한 사본의 대기열 Redis 구현(queue.proto BookingRestrictionService, docs/data.md `q:rst`, GAT-310).
// 읽기는 계정 키 하나만 본다. 칸이 망가졌으면 제한 없음으로 숨기지 않고 Error로 드러낸다(입장을 열지 않는다).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, QUEUE_REDIS } from '../../entry/index.js';
import { bookingRestrictionKeyOf, type BookingRestrictionApply, type BookingRestrictionCopy, type BookingRestrictionState } from '../domain/booking-restriction.js';
import type { BookingRestrictions } from '../domain/ports.js';
import { SET_BOOKING_RESTRICTION_LUA } from './booking-restriction-lua.js';

const SET = redisScript(SET_BOOKING_RESTRICTION_LUA);
const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MS_TEXT = /^(0|[1-9][0-9]*)$/;
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

function validate(i: BookingRestrictionApply): void {
  if (typeof i.accountId !== 'string' || !ACCOUNT_UUID.test(i.accountId)) throw new RangeError('예매 제한 사본의 계정 ID가 소문자 UUID가 아니다');
  if (typeof i.restrictionId !== 'string' || i.restrictionId === '') throw new RangeError('예매 제한 사본의 제한 ID가 비었다');
  if (i.state !== 'ACTIVE' && i.state !== 'LIFTED') throw new RangeError('예매 제한 사본의 상태가 ACTIVE·LIFTED가 아니다');
  if (!Number.isSafeInteger(i.version) || i.version < 1) throw new RangeError('예매 제한 사본의 판 번호가 1 이상 정수가 아니다');
  if (i.untilMs !== undefined && (!Number.isSafeInteger(i.untilMs) || i.untilMs < 0)) throw new RangeError('예매 제한 사본의 끝 시각이 0 이상 정수가 아니다');
}

@Injectable()
export class RedisBookingRestrictions implements BookingRestrictions {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async apply(i: BookingRestrictionApply): Promise<{ changed: boolean }> {
    validate(i);
    const r = await guard(this.redis.evalScript(SET, [bookingRestrictionKeyOf(i.accountId)], [i.state, i.restrictionId, i.untilMs === undefined ? '' : String(i.untilMs), String(i.version)]));
    return { changed: Number(str(r)) === 1 };
  }

  async read(accountId: string): Promise<BookingRestrictionCopy | undefined> {
    if (typeof accountId !== 'string' || !ACCOUNT_UUID.test(accountId)) throw new RangeError('예매 제한 사본의 계정 ID가 소문자 UUID가 아니다');
    const key = bookingRestrictionKeyOf(accountId);
    const r = (await guard(this.redis.command(['HMGET', key, 'st', 'until', 'rid', 'ver'], { key }))) as unknown[];
    if (!Array.isArray(r) || r.length !== 4) throw new Error('예매 제한 사본 읽기가 모르는 값을 돌려줬다');
    const [st, until, rid, ver] = r;
    if (r.every(isNil)) return undefined;
    if (isNil(st)) throw new Error('예매 제한 사본에 st 칸이 없는데 다른 칸이 있다(망가진 사본)');
    const state = str(st);
    if (state !== 'ACTIVE' && state !== 'LIFTED') throw new Error('예매 제한 사본의 st 칸이 ACTIVE·LIFTED가 아니다(망가진 사본)');
    const untilText = isNil(until) ? '' : str(until);
    if (untilText === '') return { st: state as BookingRestrictionState, ...(isNil(rid) ? {} : { rid: str(rid) }), ...(isNil(ver) ? {} : { ver: Number(str(ver)) }) };
    const untilMs = Number(untilText);
    if (!MS_TEXT.test(untilText) || !Number.isSafeInteger(untilMs)) throw new Error('예매 제한 사본의 until 칸이 0 이상 정수 글이 아니다(망가진 사본)');
    return { st: state as BookingRestrictionState, untilMs, ...(isNil(rid) ? {} : { rid: str(rid) }), ...(isNil(ver) ? {} : { ver: Number(str(ver)) }) };
  }
}
