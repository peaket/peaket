// 좌석 저장소를 좌석 Redis(Valkey) Lua로 한다(docs/features/seat-hold.md §3, docs/data.md §3 좌석 키, Lua 계약은 hold-lua.ts).
// 회차 키는 {event:E} 해시 태그로 한 슬롯에 둔다. 키에 넣는 값(회차 ID·계정 ID)은 받는 층이 KEY_PART 모양만 넘긴다(해시 태그를 깨지 않게).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import { type HeldHold, HOLD_TTL_MS, type HoldInput, type HoldResult, type ReplayInput, type ReplayResult, SeatStoreUnavailable } from '../domain/hold.js';
import type { SeatStore } from '../domain/ports.js';
import { HOLD_LUA, OPEN_SALE_LUA } from './hold-lua.js';

const HOLD = redisScript(HOLD_LUA);
const OPEN_SALE = redisScript(OPEN_SALE_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** 일시 장애(마감 초과·끊김·클러스터 재구성)만 SeatStoreUnavailable로 바꾼다. 그 밖(스크립트 오류 같은 버그)은 그대로 던진다 */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new SeatStoreUnavailable(err);
    throw err;
  }
}

/** Lua가 돌려준 10진 정수 글(시각) */
function int(v: unknown, what: string): number {
  const s = str(v);
  const n = Number(s);
  if (!/^-?[0-9]+$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`홀드 Lua의 ${what}이(가) 정수가 아니다: ${s}`);
  return n;
}

/** 펜싱 토큰 글 → 수. 앞 0 없는 양의 10진 정수이고 안전한 정수(2^53 − 1 이하)여야 한다 */
function fencingTokenOf(v: unknown): number {
  const s = str(v);
  const n = Number(s);
  if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`펜싱 토큰이 안전한 정수가 아니다: ${s}`);
  return n;
}

/** 멱등 기록의 처음 응답 '{holdId}:{heldAt}:{exp}:{토큰}'(docs/data.md §3) */
export function firstResponseOf(resp: string): HeldHold {
  const m = /^(.+):(\d+):(\d+):(\d+)$/.exec(resp);
  if (!m) throw new Error(`멱등 기록의 처음 응답 모양이 틀렸다: ${resp}`);
  return { holdId: m[1]!, heldAtMs: int(m[2], '잡은 시각'), expiresAtMs: int(m[3], '만료 시각'), fencingToken: fencingTokenOf(m[4]) };
}

/** 좌석 Redis 주입 이름 */
export const SEAT_REDIS = Symbol('purchase.SeatRedis');

/** 좌석 키 이름(docs/data.md §3). 시험은 이 이름으로 상태를 읽고 채운다 */
export const seatKeys = {
  bitmap: (e: string) => `s:{event:${e}}:bitmap`,
  /** 좌석 색인 하나의 홀드 Hash */
  hold: (e: string, index: number) => `s:{event:${e}}:hold:${index}`,
  expiry: (e: string) => `s:{event:${e}}:expiry`,
  quota: (e: string, account: string) => `s:{event:${e}}:quota:${account}`,
  stream: (e: string) => `s:{event:${e}}:stream`,
  /** 홀드 멱등 기록(계정 × 키) */
  idem: (e: string, account: string, key: string) => `s:{event:${e}}:idem:${account}:${key}`,
  /** 세대 키(좌석 저장소 준비 표시, ADR-0121) */
  epoch: (e: string) => `s:{event:${e}}:epoch`,
  /** 판매 정지 사본(ADR-0103·0123) */
  ctl: (e: string) => `s:{event:${e}}:ctl`,
  /** 그 계정이 방금 놓은 좌석(ADR-0161 결정 2) */
  rel: (e: string, account: string) => `s:{event:${e}}:rel:${account}`,
  secver: (e: string) => `s:{event:${e}}:secver`,
  /** 회차의 마지막 펜싱 토큰(OPEN[16] 추천 적용) */
  fence: (e: string) => `s:{event:${e}}:fence`,
  /** 구역 델타 샤드 Pub/Sub 채널(키가 아니라 채널) */
  section: (e: string, sectionId: string) => `s:{event:${e}}:sec:${sectionId}`,
  /** 좌석 비트맵이 있는 회차 목록(회차 태그 없음, 다른 슬롯) */
  ctlEvents: () => 's:ctl:events',
};

/**
 * SeatStore의 좌석 Redis 구현. hold는 홀드 Lua 한 번(EVALSHA, NOSCRIPT면 같은 마감 안에서 EVAL, platform HotRedis.evalScript)이고
 * KEYS·ARGV·돌려주는 값은 hold-lua.ts의 계약이다. openSale은 s:ctl:events SADD 한 번 뒤 판매 열기 Lua 한 번이다.
 * 일시 장애(platform isRedisUnavailable가 참)는 SeatStoreUnavailable로 바꿔 던지고, 그 밖(스크립트 오류·모르는 결과 값)은 Error로 던진다.
 * Lua의 색인 결과(CONFLICT·REHOLD_WAIT)는 입력 seats로 좌석 ID로 바꿔 돌려준다. 토큰 글은 Number로 바꾸고, 안전한 정수(Number.isSafeInteger)가 아니면 Error를 던진다.
 * ARGV 8의 구역 채널 앞머리는 seatKeys.section(eventId, '')다.
 */
@Injectable()
export class RedisSeatStore implements SeatStore {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async hold(i: HoldInput): Promise<HoldResult> {
    const e = i.eventId;
    const a = i.accountId;
    const keys = [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, a),
      seatKeys.stream(e),
      seatKeys.idem(e, a, i.idempotencyKey),
      seatKeys.epoch(e),
      seatKeys.ctl(e),
      seatKeys.rel(e, a),
      seatKeys.secver(e),
      seatKeys.fence(e),
      ...i.seats.map((s) => seatKeys.hold(e, s.index)),
    ];
    const args = [
      a,
      i.purchaseSessionId,
      i.holdId,
      i.fingerprint,
      String(i.limit),
      String(HOLD_TTL_MS),
      String(i.keepUntilMs),
      seatKeys.section(e, ''),
      ...i.seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId]),
    ];
    const r = (await guard(this.redis.evalScript(HOLD, keys, args))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`홀드 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    const kind = str(r[0]);
    // Lua의 좌석 색인 → 입력의 좌석 ID
    const seatOf = (v: unknown): string => {
      const index = Number(str(v));
      const seat = i.seats.find((s) => s.index === index);
      if (!seat) throw new Error(`홀드 Lua가 입력에 없는 좌석 색인을 돌려줬다: ${str(v)}`);
      return seat.seatId;
    };
    switch (kind) {
      // {'OK', 토큰, heldAt, exp}
      case 'OK':
        return { kind, holdId: i.holdId, fencingToken: fencingTokenOf(r[1]), heldAtMs: int(r[2], '잡은 시각'), expiresAtMs: int(r[3], '만료 시각') };
      // {'IDEM_REPLAY', holdId, heldAt, exp, 토큰}(멱등 기록의 처음 응답)
      case 'IDEM_REPLAY':
        return { kind, holdId: str(r[1]), fencingToken: fencingTokenOf(r[4]), heldAtMs: int(r[2], '잡은 시각'), expiresAtMs: int(r[3], '만료 시각') };
      case 'NOT_READY':
      case 'IDEM_REUSED':
      case 'PAUSED':
      case 'QUOTA_EXCEEDED':
        return { kind };
      case 'CONFLICT':
        return { kind, seatId: seatOf(r[1]) };
      case 'REHOLD_WAIT':
        return { kind, seatIds: r.slice(2).map(seatOf), availableAtMs: int(r[1], '다시 잡을 수 있는 시각') };
      default:
        throw new Error(`홀드 Lua가 모르는 값을 돌려줬다: ${kind}`);
    }
  }

  /** 멱등 기록 하나를 HMGET으로 읽는다(같은 슬롯, 쓰지 않음). 만료는 Redis가 지운다 */
  async replay(i: ReplayInput): Promise<ReplayResult> {
    const key = seatKeys.idem(i.eventId, i.accountId, i.idempotencyKey);
    const r = (await guard(this.redis.command(['HMGET', key, 'fp', 'resp'], { key }))) as unknown[];
    if (!Array.isArray(r) || r[0] === null || r[0] === undefined) return null;
    if (str(r[0]) !== i.fingerprint) return { kind: 'IDEM_REUSED' };
    return { kind: 'IDEM_REPLAY', ...firstResponseOf(r[1] === null || r[1] === undefined ? '' : str(r[1])) };
  }

  async openSale(i: { eventId: string; seatCount: number; keepUntilMs: number }): Promise<{ created: boolean; seatEpoch: number }> {
    if (!Number.isSafeInteger(i.seatCount) || i.seatCount < 1) throw new RangeError(`좌석 수는 1 이상의 정수다: ${i.seatCount}`);
    // 회차 목록을 먼저(다른 슬롯이라 Lua 밖에서), 그다음 비트맵 → 세대 키(docs/data.md §3 s:ctl:events)
    const list = seatKeys.ctlEvents();
    await guard(this.redis.command(['SADD', list, i.eventId], { key: list }));
    const r = (await guard(this.redis.evalScript(OPEN_SALE, [seatKeys.bitmap(i.eventId), seatKeys.epoch(i.eventId)], [String(i.seatCount), String(i.keepUntilMs)]))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`판매 열기 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    return { created: str(r[0]) === '1', seatEpoch: int(r[1], '세대') };
  }
}
