// 좌석 저장소를 좌석 Redis(Valkey) Lua로 한다(docs/features/seat-hold.md §3, docs/data.md §3 좌석 키, Lua 계약은 hold-lua.ts).
// 회차 키는 {event:E} 해시 태그로 한 슬롯에 둔다. 키에 넣는 값(회차 ID·계정 ID)은 받는 층이 KEY_PART 모양만 넘긴다(해시 태그를 깨지 않게).
import { Inject, Injectable } from '@nestjs/common';
import { type Clock, type HotRedis, isRedisOutOfMemory, isRedisUnavailable, type PlatformLogger, redisScript, systemClock } from '@peaket/platform';
import {
  assertDueExpiriesInput,
  assertExpireInput,
  type DueExpiriesInput,
  type DueExpiry,
  type DueHold,
  type ExpiredHold,
  type ExpireInput,
  type ExpireResult,
  isExpirableFence,
} from '../domain/expiry.js';
import {
  type HeldHold,
  HOLD_TTL_MS,
  type HoldInput,
  type HoldResult,
  KEY_PART,
  REHOLD_WAIT_MS,
  type ReplayInput,
  type ReplayResult,
  SeatStoreUnavailable,
  type SeatRef,
} from '../domain/hold.js';
import type { LogGate } from '../domain/log-gate.js';
import type { SeatCallOptions, SeatEventRetire, SeatExpiries, SeatPins, SeatRebuildTarget, SeatSnapshots, SeatStore, SnapshotReadInput, SnapshotReadResult } from '../domain/ports.js';
import { assertRebuildBegin, assertRebuildFinish, assertRebuildSeats, REBUILD_BATCH, type RebuildFinishInput, type RebuildSeat, type RebuildStep } from '../domain/rebuild.js';
import {
  assertPinInput,
  assertReleaseFailedInput,
  assertRetireInput,
  type PinInput,
  type PinResult,
  type ReleaseFailedInput,
  type ReleaseFailedResult,
  RETIRE_AFTER_SALE_END_MS,
  type RetireResult,
} from '../domain/pin.js';
import { STREAM_RELAY_GROUP } from '../domain/seat-event.js';
import { SNAPSHOT_LUA } from './snapshot-lua.js';
import { assertSnapshotInput } from '../domain/snapshot.js';
import { EXPIRE_LUA } from './expire-lua.js';
import { HOLD_LUA, OPEN_SALE_LUA } from './hold-lua.js';
import { PIN_LUA, RELEASE_FAILED_LUA } from './pin-lua.js';
import { BEGIN_REBUILD_LUA, BUMP_EPOCH_LUA, FINISH_REBUILD_LUA, REBUILD_QUOTAS_LUA, REBUILD_SEATS_LUA } from './rebuild-lua.js';
import { keepEventIds, saleEventsWarnGate } from './sale-events.js';

const HOLD = redisScript(HOLD_LUA);
const SNAPSHOT = redisScript(SNAPSHOT_LUA);
const OPEN_SALE = redisScript(OPEN_SALE_LUA);
const EXPIRE = redisScript(EXPIRE_LUA);
const PIN = redisScript(PIN_LUA);
const RELEASE_FAILED = redisScript(RELEASE_FAILED_LUA);
const BEGIN_REBUILD = redisScript(BEGIN_REBUILD_LUA);
const REBUILD_SEATS = redisScript(REBUILD_SEATS_LUA);
const REBUILD_QUOTAS = redisScript(REBUILD_QUOTAS_LUA);
const FINISH_REBUILD = redisScript(FINISH_REBUILD_LUA);
const BUMP_EPOCH = redisScript(BUMP_EPOCH_LUA);

/** 좌석마다 Lua ARGV 6칸(hold-lua.ts·pin-lua.ts): 좌석 색인, 구역 색인, 구역 안 거리, 좌석 ID, 등급 ID, 구역 ID */
const seatArgsOf = (seats: readonly SeatRef[]): string[] => seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId]);

/** 다시 만들기 좌석 Lua의 좌석 하나 ARGV 10칸(rebuild-lua.ts): 색인, 방식, holdId, owner, psid, fence, heldAt, exp, kind, 예비 ''. 원장 행 없는 판매 좌석의 세 칸은 '' */
const rebuildSeatArgsOf = (s: RebuildSeat): string[] => {
  const timed = s.fencingToken !== undefined ? [String(s.fencingToken), String(s.heldAtMs), String(s.expiresAtMs)] : ['', '', ''];
  return s.mode === 'SOLD'
    ? [String(s.seat.index), 'S', s.holdId, s.accountId, s.purchaseSessionId, ...timed, 'FAN', '']
    : [String(s.seat.index), 'H', s.holdId, s.accountId, s.purchaseSessionId, ...timed, s.kind, ''];
};

/** 다시 만들기 Lua의 답 → RebuildStep(OK·READY gen·STALE). OK의 둘째 칸은 부른 쪽이 본다. 모르는 답이면 Error */
function rebuildStepOf(r: unknown, what: string): { step: RebuildStep; raw: unknown[] } {
  if (!Array.isArray(r)) throw new Error(`${what} Lua가 모르는 값을 돌려줬다: ${String(r)}`);
  const kind = str(r[0]);
  if (kind === 'OK' || kind === 'STALE') return { step: { result: kind }, raw: r };
  if (kind === 'READY') {
    const gen = int(r[1], '세대 키의 판 번호');
    if (gen < 1) throw new Error(`${what} Lua가 돌려준 판 번호가 1 이상이 아니다: ${gen}`);
    return { step: { result: 'READY', gen }, raw: r };
  }
  throw new Error(`${what} Lua가 모르는 값을 돌려줬다: ${kind}`);
}

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

/**
 * 좌석 Redis 오류를 가른다: 일시 장애(마감 초과·끊김·클러스터 재구성, platform isRedisUnavailable)는 SeatStoreUnavailable(err),
 * 메모리 부족(platform isRedisOutOfMemory)은 SeatStoreUnavailable(err, 'oom'), 그 밖(스크립트 오류 같은 버그)은 그대로 돌려준다.
 * isRedisUnavailable을 먼저 본다. RedisSweepLeases도 같은 가르기를 쓴다
 */
export function seatRedisError(err: unknown): unknown {
  if (isRedisUnavailable(err)) return new SeatStoreUnavailable(err);
  if (isRedisOutOfMemory(err)) return new SeatStoreUnavailable(err, 'oom');
  return err;
}

/** 좌석 Redis 호출 하나를 seatRedisError로 가른 오류로 끝낸다 */
export async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw seatRedisError(err);
  }
}

/** 호출 마감 선택값(SeatCallOptions.deadlineMs가 있을 때만 싣는다) */
/** 스냅샷 읽기 Lua가 돌려준 0 ~ 2^32 − 1의 표준 10진 정수 글(Buffer나 글)을 수로 바꾼다. 아니면 Error(Lua가 이미 거른 값이라 버그다) */
function u32Of(v: unknown, what: string): number {
  const text = str(v);
  const n = Number(text);
  if (!/^(0|[1-9][0-9]{0,9})$/.test(text) || n > 0xffff_ffff) throw new Error(`스냅샷 읽기 Lua가 돌려준 ${what}이(가) u32 정수 글이 아니다`);
  return n;
}

const deadlineOf = (o: SeatCallOptions | undefined): { deadlineMs?: number } => (o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {});

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
  /** 다시 만들기 시도의 판 번호(값 = gen, 코드 리뷰 PRF-143. 시작 Lua가 쓰고 좌석·보유 수·끝내기 Lua가 대조한다) */
  rebuild: (e: string) => `s:{event:${e}}:rebuild`,
  /** 회차별 만료 임대(값 = 잡은 파드 ID, BUILD_ORDER PRF-135) */
  sweep: (e: string) => `s:{event:${e}}:sweep`,
  /** 구매 세션 정리 색인(정렬 집합, 멤버 jti, 점수 = 다음에 볼 시각, BUILD_ORDER PRF-138) */
  sessions: (e: string) => `s:{event:${e}}:sessions`,
  /** 구매 세션 정리 반복의 회차별 임대(BUILD_ORDER PRF-138) */
  sessionSweep: (e: string) => `s:{event:${e}}:sesweep`,
};

/**
 * SeatStore·SeatExpiries의 좌석 Redis 구현. hold는 홀드 Lua 한 번(EVALSHA, NOSCRIPT면 같은 마감 안에서 EVAL, platform HotRedis.evalScript)이고
 * KEYS·ARGV·돌려주는 값은 hold-lua.ts의 계약이다. openSale은 s:ctl:events SADD 한 번 뒤 판매 열기 Lua 한 번이다.
 * 일시 장애(platform isRedisUnavailable가 참)는 SeatStoreUnavailable로 바꿔 던지고, 그 밖(스크립트 오류·모르는 결과 값)은 Error로 던진다.
 * Lua의 색인 결과(CONFLICT·REHOLD_WAIT)는 입력 seats로 좌석 ID로 바꿔 돌려준다. 토큰 글은 Number로 바꾸고, 안전한 정수(Number.isSafeInteger)가 아니면 Error를 던진다.
 * ARGV 8의 구역 채널 앞머리는 seatKeys.section(eventId, '')다.
 *
 * PRF-135:
 * - 메모리 부족(platform isRedisOutOfMemory가 참)은 모든 메서드에서 SeatStoreUnavailable(err, 'oom')로 바꿔 던진다(503, 까닭은 지표·서비스 로그에만).
 * - hold·replay의 둘째 인자 SeatCallOptions.deadlineMs를 HotRedis 호출의 deadlineMs로 넘긴다(없으면 넘기지 않아 플랫폼 기본 100ms).
 * - saleEvents는 SMEMBERS s:ctl:events 한 번, dueExpiries는 ZRANGE 한 번 뒤 좌석마다 HMGET(함께 보낸다), expire는 만료 Lua 한 번(expire-lua.ts 계약,
 *   ARGV 2의 구역 채널 앞머리는 seatKeys.section(eventId, '')). 결과 해석과 오류는 ports.ts SeatExpiries의 설명이다.
 *
 * PRF-142: pin·releaseFailed는 입력 검사(RangeError, 아무것도 부르지 않는다) 뒤 pin-lua.ts의 Lua 한 번(hold와 같은 마감·오류 가르기),
 * retireEvent는 주입 Clock으로 시각을 가른 뒤 회차 슬롯의 XLEN·XPENDING과 목록 슬롯의 SREM을 따로 보낸다.
 *
 * PRF-143: isReady는 HEXISTS epoch 한 번, begin·writeSeats·bumpEpoch는 입력 검사(RangeError) 뒤 rebuild-lua.ts의 Lua 한 번(같은 오류 가르기,
 * 마감은 플랫폼 기본). finish는 목록 슬롯에 SADD s:ctl:events를 먼저 따로 보낸 뒤 보유 수 Lua(200계정씩)와 끝내기 Lua다(코드 리뷰로 고침).
 */
@Injectable()
export class RedisSeatStore implements SeatStore, SeatExpiries, SeatSnapshots, SeatPins, SeatEventRetire, SeatRebuildTarget {
  readonly #filterWarnGate: LogGate;
  readonly #clock: Clock;

  /**
   * @param redis 좌석 Redis
   * @param logger 서비스 로거(선택). saleEvents가 거른 값의 수를 남긴다(L8, 파드마다 60초에 한 줄까지, C3). 모듈은 useFactory로 넘긴다
   * @param clock 경고 문의 시각과 retireEvent의 지금(기본 systemClock, Lua 안의 시각은 Redis TIME). 모듈은 주입 Clock을 넘긴다
   */
  constructor(
    @Inject(SEAT_REDIS) private readonly redis: HotRedis,
    private readonly logger?: PlatformLogger,
    clock: Clock = systemClock,
  ) {
    this.#clock = clock;
    this.#filterWarnGate = saleEventsWarnGate(clock);
  }

  async hold(i: HoldInput, o?: SeatCallOptions): Promise<HoldResult> {
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
    const r = (await guard(this.redis.evalScript(HOLD, keys, args, deadlineOf(o)))) as unknown[];
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
  async replay(i: ReplayInput, o?: SeatCallOptions): Promise<ReplayResult> {
    const key = seatKeys.idem(i.eventId, i.accountId, i.idempotencyKey);
    const r = (await guard(this.redis.command(['HMGET', key, 'fp', 'resp'], { key, ...deadlineOf(o) }))) as unknown[];
    if (!Array.isArray(r) || r[0] === null || r[0] === undefined) return null;
    if (str(r[0]) !== i.fingerprint) return { kind: 'IDEM_REUSED' };
    return { kind: 'IDEM_REPLAY', ...firstResponseOf(r[1] === null || r[1] === undefined ? '' : str(r[1])) };
  }

  async read(i: SnapshotReadInput, o?: SeatCallOptions): Promise<SnapshotReadResult> {
    assertSnapshotInput(i);
    const firstByte = Math.floor(i.firstBit / 8);
    const lastByte = Math.floor((i.firstBit + i.bitCount - 1) / 8);
    const keys = [seatKeys.bitmap(i.eventId), seatKeys.epoch(i.eventId), seatKeys.secver(i.eventId)];
    const args = [String(firstByte), String(lastByte), ...i.sectionIndexes.map(String)];
    // 비트맵 바이트를 글자로 풀면 0x80 같은 바이트가 깨져 응답을 Buffer로 받는다(platform CallOptions.binary)
    const r = await guard(this.redis.evalScript(SNAPSHOT, keys, args, { ...deadlineOf(o), binary: true }));
    if (!Array.isArray(r) || r.length < 1) throw new Error(`스냅샷 읽기 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY') return { kind: 'NOT_READY' };
    if (kind !== 'OK' || r.length !== 3 + i.sectionIndexes.length) throw new Error(`스냅샷 읽기 Lua가 모르는 값을 돌려줬다: ${kind}`);
    const want = lastByte - firstByte + 1;
    const got = Buffer.isBuffer(r[2]) ? r[2] : Buffer.from(String(r[2]), 'latin1');
    // 비트맵이 짧거나 없으면 모자란 바이트는 0으로 채운다
    const bytes = got.length === want ? got : Buffer.concat([got.subarray(0, want), Buffer.alloc(Math.max(0, want - got.length))]);
    return { kind: 'OK', seatEpoch: u32Of(r[1], '세대'), bytes, sectionVersions: r.slice(3).map((v) => u32Of(v, '구역 일련번호')) };
  }

  /**
   * 좌석 묶기(BUILD_ORDER PRF-142, 계약은 adapters/pin-lua.ts PIN_LUA): assertPinInput 뒤 묶기 Lua 한 번(hold와 같은 마감·오류 가르기).
   * TAKEN의 색인이 입력에 없거나, 다시 잡은 수와 토큰 글이 맞지 않으면(다시 잡았는데 토큰이 없음·안 잡았는데 토큰이 있음) Error
   */
  async pin(i: PinInput, o?: SeatCallOptions): Promise<PinResult> {
    assertPinInput(i);
    const e = i.eventId;
    const a = i.accountId;
    const keys = [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, a),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.fence(e),
      ...i.seats.map((s) => seatKeys.hold(e, s.index)),
    ];
    const args = [
      a,
      i.purchaseSessionId,
      i.holdId,
      String(i.limit),
      String(i.orderGen),
      String(HOLD_TTL_MS),
      String(i.keepUntilMs),
      seatKeys.section(e, ''),
      ...seatArgsOf(i.seats),
    ];
    const r = (await guard(this.redis.evalScript(PIN, keys, args, deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`묶기 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    const kind = str(r[0]);
    switch (kind) {
      // {'OK', gen, 다시 잡은 수, 토큰 글 또는 ''}
      case 'OK': {
        const gen = int(r[1], '판 번호');
        const regrabbed = count(r[2], '다시 잡은 수');
        const tok = str(r[3] ?? '');
        if (regrabbed === 0) {
          if (tok !== '') throw new Error(`묶기 Lua가 다시 잡지 않았는데 토큰을 돌려줬다: ${tok}`);
          return { kind, gen, regrabbed };
        }
        return { kind, gen, regrabbed, fencingToken: fencingTokenOf(tok) };
      }
      case 'NOT_READY':
      case 'QUOTA_EXCEEDED':
        return { kind };
      case 'TAKEN': {
        const seatIndex = count(r[1], '좌석 색인');
        if (!i.seats.some((s) => s.index === seatIndex)) throw new Error(`묶기 Lua가 입력에 없는 좌석 색인을 돌려줬다: ${seatIndex}`);
        return { kind, seatIndex };
      }
      case 'STALE_GEN':
        return { kind, gen: int(r[1], '판 번호') };
      default:
        throw new Error(`묶기 Lua가 모르는 값을 돌려줬다: ${kind}`);
    }
  }

  /** 결제 실패 해제(BUILD_ORDER PRF-142, 계약은 adapters/pin-lua.ts RELEASE_FAILED_LUA): assertReleaseFailedInput 뒤 실패 해제 Lua 한 번. 푼 수가 좌석 수보다 크면 Error */
  async releaseFailed(i: ReleaseFailedInput, o?: SeatCallOptions): Promise<ReleaseFailedResult> {
    assertReleaseFailedInput(i);
    const e = i.eventId;
    const a = i.accountId;
    const keys = [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, a),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      ...i.seats.map((s) => seatKeys.hold(e, s.index)),
    ];
    const args = [a, i.holdId, String(i.keepUntilMs), seatKeys.section(e, ''), ...seatArgsOf(i.seats)];
    const r = (await guard(this.redis.evalScript(RELEASE_FAILED, keys, args, deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`실패 해제 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY') return { kind };
    if (kind !== 'OK') throw new Error(`실패 해제 Lua가 모르는 값을 돌려줬다: ${kind}`);
    const released = count(r[1], '푼 수');
    if (released > i.seats.length) throw new Error(`실패 해제 Lua의 푼 수(${released})가 넘긴 좌석 수(${i.seats.length})보다 크다`);
    return { kind, released };
  }

  /**
   * 회차 목록에서 빼기(BUILD_ORDER PRF-142, ports.ts SeatEventRetire). 차례(앞이 걸리면 뒤는 부르지 않는다):
   * 1 주입 Clock의 지금 < 판매 종료 + RETIRE_AFTER_SALE_END_MS → TOO_EARLY(Redis를 부르지 않는다)
   * 2 회차 슬롯에서 XLEN stream > 0 → STREAM_PENDING, XPENDING stream stream-relay 요약의 수 > 0 → STREAM_PENDING(그룹·키가 없어 NOGROUP이면 0).
   *   둘 다 읽기라 Stream 키를 만들지 않는다
   * 3 목록 슬롯에 SREM s:ctl:events 회차 따로 한 번: 1이면 RETIRED, 0이면 NOT_LISTED(목록에 없었다)
   * 일시 장애·메모리 부족은 SeatStoreUnavailable(다시 부르면 된다. SREM만 멱등이 아닌데 다시 부르면 NOT_LISTED다)
   */
  async retireEvent(i: { eventId: string; saleEndMs: number }): Promise<RetireResult> {
    assertRetireInput(i);
    if (this.#clock.now() < i.saleEndMs + RETIRE_AFTER_SALE_END_MS) return 'TOO_EARLY';
    const stream = seatKeys.stream(i.eventId);
    const expiry = seatKeys.expiry(i.eventId);
    // 회차 슬롯에서 본다: Stream 길이, 확인받지 못한 항목, 만료 인덱스에 남은 홀드
    const left = async (): Promise<RetireResult | undefined> => {
      if (count(await guard(this.redis.command(['XLEN', stream], { key: stream })), 'Stream 길이') > 0) return 'STREAM_PENDING';
      if ((await this.#pendingOf(stream)) > 0) return 'STREAM_PENDING';
      if (count(await guard(this.redis.command(['ZCARD', expiry], { key: expiry })), '만료 인덱스 길이') > 0) return 'EXPIRY_PENDING';
      return undefined;
    };
    const before = await left();
    if (before) return before;
    const list = seatKeys.ctlEvents();
    if (count(await guard(this.redis.command(['SREM', list, i.eventId], { key: list })), '뺀 수') === 0) return 'NOT_LISTED';
    // 두 슬롯 사이(확인과 빼기 사이)에 항목·홀드가 들어왔으면 되돌린다. 릴레이·만료 반복은 목록에 있는 회차만 읽는다
    const after = await left();
    if (after) {
      await guard(this.redis.command(['SADD', list, i.eventId], { key: list }));
      return after;
    }
    return 'RETIRED';
  }

  /** 소비자 그룹 stream-relay의 확인받지 못한 항목 수(XPENDING 요약의 첫 값). 그룹이나 키가 없으면(NOGROUP) 0 */
  async #pendingOf(stream: string): Promise<number> {
    let r: unknown;
    try {
      r = await this.redis.command(['XPENDING', stream, STREAM_RELAY_GROUP], { key: stream });
    } catch (err) {
      if (err instanceof Error && /^NOGROUP\b/.test(err.message)) return 0;
      throw seatRedisError(err);
    }
    if (!Array.isArray(r)) throw new Error(`XPENDING 답이 배열이 아니다: ${String(r)}`);
    return count(r[0] ?? 0, '확인받지 못한 항목 수');
  }

  /** 다시 만들기(BUILD_ORDER PRF-143): 세대 키의 epoch 칸이 있나(HEXISTS 한 번, 쓰지 않음) */
  async isReady(eventId: string): Promise<boolean> {
    if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
    const key = seatKeys.epoch(eventId);
    return count(await guard(this.redis.command(['HEXISTS', key, 'epoch'], { key })), '세대 칸 있음') === 1;
  }

  /** 다시 만들기 시작(BEGIN_REBUILD_LUA): assertRebuildBegin 뒤 Lua 한 번(오류 가르기는 pin과 같다). 모르는 답이면 Error */
  async begin(eventId: string, gen: number, keepUntilMs: number): Promise<RebuildStep> {
    assertRebuildBegin(eventId, gen, keepUntilMs);
    const e = eventId;
    const keys = [seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.epoch(e), seatKeys.rebuild(e)];
    return rebuildStepOf(await guard(this.redis.evalScript(BEGIN_REBUILD, keys, [String(gen), String(keepUntilMs)])), '다시 만들기 시작').step;
  }

  /**
   * 다시 만들기 좌석 쓰기(계약은 adapters/rebuild-lua.ts REBUILD_SEATS_LUA): assertRebuildSeats 뒤 Lua 한 번(오류 가르기는 pin과 같다).
   * 쓴 수가 넘긴 좌석 수와 다르거나 모르는 답이면 Error
   */
  async writeSeats(eventId: string, seats: readonly RebuildSeat[], keepUntilMs: number, gen: number): Promise<RebuildStep> {
    assertRebuildSeats(eventId, seats, keepUntilMs, gen);
    const e = eventId;
    const keys = [seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.epoch(e), seatKeys.rebuild(e), ...seats.map((s) => seatKeys.hold(e, s.seat.index))];
    const args = [String(keepUntilMs), String(gen), ...seats.flatMap(rebuildSeatArgsOf)];
    const { step, raw } = rebuildStepOf(await guard(this.redis.evalScript(REBUILD_SEATS, keys, args)), '다시 만들기 좌석');
    if (step.result === 'OK') {
      const written = count(raw[1], '쓴 수');
      if (written !== seats.length) throw new Error(`다시 만들기 좌석 Lua의 쓴 수(${written})가 넘긴 좌석 수(${seats.length})와 다르다`);
    }
    return step;
  }

  /**
   * 다시 만들기 끝: assertRebuildFinish 뒤 회차 목록 s:ctl:events에 SADD를 먼저 따로 한 번(다른 슬롯, 여러 번 해도 같다. Lua 뒤에 두면 SADD가 실패했을 때
   * 세대 키만 서고 목록에서 빠진 회차가 READY로 굳는다) → 보유 수 Lua(REBUILD_QUOTAS_LUA)를 REBUILD_BATCH계정씩(KEYS·ARGV의 계정 차례는 quotas의 차례)
   * → 끝내기 Lua(FINISH_REBUILD_LUA: 펜싱 카운터 = max(fence, maxToken), 세대 키) 한 번. 어느 Lua든 READY·STALE이면 거기서 멈춘다
   */
  async finish(eventId: string, input: RebuildFinishInput): Promise<RebuildStep> {
    assertRebuildFinish(eventId, input);
    const e = eventId;
    // 전체 유실 때 회차 목록도 사라진다. 다시 넣어야 만료 반복·Stream 릴레이가 이 회차를 돈다
    const list = seatKeys.ctlEvents();
    await guard(this.redis.command(['SADD', list, e], { key: list }));
    const gen = String(input.gen);
    const keep = String(input.keepUntilMs);
    const accounts = [...input.quotas.keys()];
    for (let k = 0; k < accounts.length; k += REBUILD_BATCH) {
      const batch = accounts.slice(k, k + REBUILD_BATCH);
      const keys = [seatKeys.epoch(e), seatKeys.rebuild(e), ...batch.map((a) => seatKeys.quota(e, a))];
      const { step, raw } = rebuildStepOf(await guard(this.redis.evalScript(REBUILD_QUOTAS, keys, [gen, keep, ...batch.map((a) => String(input.quotas.get(a)))])), '다시 만들기 보유 수');
      if (step.result !== 'OK') return step;
      if (count(raw[1], '쓴 수') !== batch.length) throw new Error(`다시 만들기 보유 수 Lua의 쓴 수가 넘긴 계정 수(${batch.length})와 다르다`);
    }
    const keys = [seatKeys.epoch(e), seatKeys.rebuild(e), seatKeys.fence(e)];
    const { step, raw } = rebuildStepOf(await guard(this.redis.evalScript(FINISH_REBUILD, keys, [gen, input.node, keep, String(input.maxToken ?? 0)])), '다시 만들기 끝내기');
    if (step.result === 'OK') int(raw[1], '세대');
    return step;
  }

  /** 장애 조치 뒤 세대 올리기(BUMP_EPOCH_LUA): Lua 한 번. eventId가 KEY_PART가 아니거나 node가 비었으면 RangeError(부르지 않는다) */
  async bumpEpoch(eventId: string, node: string): Promise<{ result: 'BUMPED' | 'SAME'; epoch: number } | { result: 'NOT_READY' }> {
    if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
    if (typeof node !== 'string' || node.length === 0) throw new RangeError('node가 비었다');
    const r = (await guard(this.redis.evalScript(BUMP_EPOCH, [seatKeys.epoch(eventId)], [node]))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`세대 올리기 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY') return { result: kind };
    if (kind === 'SAME' || kind === 'BUMPED') return { result: kind, epoch: count(r[1], '세대') };
    throw new Error(`세대 올리기 Lua가 모르는 값을 돌려줬다: ${kind}`);
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

  /** SeatExpiries.saleEvents: SMEMBERS s:ctl:events 한 번 */
  async saleEvents(): Promise<string[]> {
    const list = seatKeys.ctlEvents();
    const r = await guard(this.redis.command(['SMEMBERS', list], { key: list }));
    if (!Array.isArray(r)) throw new Error(`회차 목록 답이 배열이 아니다: ${String(r)}`);
    // 회차 ID 모양이 아닌 값은 거른다(해시 태그를 깨는 값이 임대·만료 키에 들어가지 않게, L8). 값은 로그에 싣지 않고 경고는 파드마다 60초에 한 줄까지다(C3)
    return keepEventIds(r.map(str), this.#filterWarnGate, this.logger);
  }

  /**
   * SeatExpiries.dueExpiries: ZRANGE expiry -inf nowMs BYSCORE LIMIT 0 limit WITHSCORES 한 번 뒤 좌석마다 HMGET hold:{i} holdId fence owner.
   * 홀드 키의 형이 틀려 HMGET이 WRONGTYPE이면 그 좌석만 { hold: null, corrupt: true }다(B1. 나머지 좌석의 읽기는 그대로 이어진다).
   * 만료 인덱스 키(ZRANGE) 자체의 오류와 다른 종류의 HMGET 오류는 읽기 전체 오류라 그대로 던진다(일시 장애·메모리 부족은 SeatStoreUnavailable)
   */
  async dueExpiries(i: DueExpiriesInput): Promise<DueExpiry[]> {
    assertDueExpiriesInput(i);
    const e = i.eventId;
    const expiry = seatKeys.expiry(e);
    const range = await guard(this.redis.command(['ZRANGE', expiry, '-inf', String(i.nowMs), 'BYSCORE', 'LIMIT', '0', String(i.limit), 'WITHSCORES'], { key: expiry }));
    const due = scoredMembers(range).map(([member, score]) => {
      const m = str(member);
      const index = Number(m);
      const expiresAtMs = Number(str(score));
      // 멤버는 앞 0 없는 10진 정수 글이다('0'은 첫 좌석). 만료 Lua는 String(색인)으로 조회하므로 '007'을 색인 7로 받으면 그 멤버를 지우지 못하고, 정상 '7'과 겹친다
      if (!/^(0|[1-9][0-9]*)$/.test(m) || !Number.isSafeInteger(index) || !Number.isFinite(expiresAtMs)) throw new Error(`PEAKET_CORRUPT_KEY ${expiry}`);
      return { index, expiresAtMs };
    });
    // 같은 슬롯이라 함께 보낸다(클라이언트가 한 연결에 이어 보낸다)
    const hashes = await Promise.all(
      due.map(async (d) => {
        const key = seatKeys.hold(e, d.index);
        try {
          return await this.redis.command(['HMGET', key, 'holdId', 'fence', 'owner'], { key });
        } catch (err) {
          // 홀드 키의 형이 틀린 좌석만 망가진 좌석이다(B1). 그 밖의 오류(스크립트 버그·일시 장애·메모리 부족)는 읽기 전체 오류라 가른 오류로 던진다
          if (isWrongType(err)) return WRONG_TYPE;
          throw seatRedisError(err);
        }
      }),
    );
    return due.map((d, k): DueExpiry => {
      const hold = hashes[k] === WRONG_TYPE ? 'corrupt' : dueHoldOf(hashes[k]);
      return hold === 'corrupt' ? { ...d, hold: null, corrupt: true } : { ...d, hold };
    });
  }

  /** SeatExpiries.expire: 만료 Lua 한 번(expire-lua.ts의 KEYS·ARGV, 계정 m개는 seats의 expected.owner를 처음 나온 차례로) */
  async expire(i: ExpireInput): Promise<ExpireResult> {
    assertExpireInput(i);
    const e = i.eventId;
    const owners: string[] = [];
    for (const s of i.seats) if (s.expected && !owners.includes(s.expected.owner)) owners.push(s.expected.owner);
    const keys = [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      ...i.seats.map((s) => seatKeys.hold(e, s.index)),
      ...owners.map((a) => seatKeys.quota(e, a)),
      ...owners.map((a) => seatKeys.rel(e, a)),
    ];
    const args = [
      String(REHOLD_WAIT_MS),
      seatKeys.section(e, ''),
      String(i.keepUntilMs),
      String(owners.length),
      ...owners,
      ...i.seats.flatMap((s) => [
        String(s.index),
        s.expected?.holdId ?? '',
        s.expected?.fencingToken ?? '',
        s.expected ? String(owners.indexOf(s.expected.owner) + 1) : '0',
        s.seat ? String(s.seat.sectionIndex) : '',
        s.seat ? String(s.seat.seatOffset) : '',
        s.seat?.seatId ?? '',
        s.seat?.tierId ?? '',
        s.seat?.sectionId ?? '',
      ]),
    ];
    const r = (await guard(this.redis.evalScript(EXPIRE, keys, args))) as unknown;
    if (!Array.isArray(r)) throw new Error(`만료 Lua가 모르는 값을 돌려줬다: ${String(r)}`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY') return { kind };
    if (kind !== 'OK') throw new Error(`만료 Lua가 모르는 값을 돌려줬다: ${kind}`);
    // {'OK', µs, 푼 수, 건너뛴 수, 고아 수, (색인, 토큰)…}
    const released = count(r[2], '푼 수');
    const skipped = count(r[3], '건너뛴 수');
    const orphans = count(r[4], '고아 수');
    if (r.length !== 5 + 2 * released) throw new Error(`만료 Lua 답의 길이가 푼 수와 맞지 않는다: ${r.length}, 푼 수 ${released}`);
    // 망가진 좌석 수는 Lua 답에 없다: 넘긴 좌석 수 − (푼 + 건너뛴 + 고아)(M2)
    const corrupt = i.seats.length - (released + skipped + orphans);
    if (corrupt < 0) throw new Error(`만료 Lua 답의 푼·건너뛴·고아 수의 합이 넘긴 좌석 수(${i.seats.length})보다 크다`);
    const inputIndexes = new Set(i.seats.map((s) => s.index));
    const expired: ExpiredHold[] = [];
    for (let k = 5; k < r.length; k += 2) {
      const index = count(r[k], '좌석 색인');
      if (!inputIndexes.has(index)) throw new Error(`만료 Lua가 입력에 없는 좌석 색인을 돌려줬다: ${index}`);
      expired.push({ index, fencingToken: fencingTokenOf(r[k + 1]) });
    }
    return { kind: 'OK', nowUs: count(r[1], '지금(µs)'), released, skipped, orphans, corrupt, expired };
  }
}

/** Lua·명령이 돌려준 0 이상의 10진 정수(수 또는 글) */
function count(v: unknown, what: string): number {
  const s = str(v);
  const n = Number(s);
  if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`좌석 Redis 답의 ${what}이(가) 0 이상의 정수가 아니다: ${s}`);
  return n;
}

/** ZRANGE … WITHSCORES 답(RESP2 평평한 배열, RESP3 짝 배열)을 [멤버, 점수] 짝으로 */
function scoredMembers(v: unknown): [unknown, unknown][] {
  if (!Array.isArray(v)) throw new Error(`ZRANGE 답이 배열이 아니다: ${String(v)}`);
  if (v.length > 0 && v.every((x) => Array.isArray(x))) return (v as unknown[][]).map((p) => [p[0], p[1]]);
  if (v.length % 2 !== 0) throw new Error(`ZRANGE WITHSCORES 답의 길이가 짝수가 아니다: ${v.length}`);
  const out: [unknown, unknown][] = [];
  for (let k = 0; k < v.length; k += 2) out.push([v[k], v[k + 1]]);
  return out;
}

/** HMGET이 홀드 키의 형 오류(WRONGTYPE)로 거절됐다는 표시(B1) */
const WRONG_TYPE = Symbol('purchase.WrongTypeHold');

/** 홀드 키의 형이 틀려 Redis가 거절한 오류인가(답이 'WRONGTYPE …'로 시작하는 Error, B1) */
const isWrongType = (err: unknown): boolean => err instanceof Error && /^WRONGTYPE\b/.test(err.message);

/**
 * 홀드 Hash의 holdId·fence·owner(HMGET 답). 셋 모두 없으면 null, 일부만 있거나 owner가 키 조각 모양이 아니거나 fence가 만료 Lua가 받지 못하는 모양
 * (앞 0 없는 10진 정수가 아니거나 2^53 − 1 초과, isExpirableFence, A2)이면 망가진 Hash('corrupt', M2)다
 */
function dueHoldOf(v: unknown): DueHold | null | 'corrupt' {
  const [holdId, fence, owner] = Array.isArray(v) ? v : [];
  if (isNil(holdId) && isNil(fence) && isNil(owner)) return null;
  if (isNil(holdId) || isNil(fence) || isNil(owner) || !KEY_PART.test(str(owner)) || !isExpirableFence(str(fence))) return 'corrupt';
  return { holdId: str(holdId), fencingToken: str(fence), owner: str(owner) };
}
