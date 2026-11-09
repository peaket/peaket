// 구매 세션 저장소와 시작 사건 더하기를 좌석 Redis(Valkey) Lua로 한다(BUILD_ORDER PRF-136, docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session).
// 키 이름은 sessionKeys다: 재사용 차단 표지와 세션 상태는 해시 태그가 같은 {jti}라 한 슬롯이고, 회차 Stream은 {event:E} 슬롯이다.
// 키에 넣는 값(jti·회차 ID)은 이 어댑터가 KEY_PART 모양을 다시 확인한다(해시 태그를 깨는 값이 키로 가지 않게).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import {
  assertEndedEntry,
  assertHoldRecord,
  assertIndexArgs,
  assertJti,
  type EndedSession,
  type SweepSessionResult,
  assertOpenInput,
  assertSeq,
  assertStartedEntry,
  type OpenSessionInput,
  type OpenSessionResult,
  SESSION_IDLE_MS,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_GRACE_MS,
  SESSION_STARTED_KEEP_MS,
  type SessionEndedEntry,
  type SessionStartedEntry,
  sessionCheckAt,
  sessionEndedFields,
  sessionStartedFields,
  type StoredSession,
} from '../domain/purchase-session.js';
import type { PurchaseSessionStore, SeatCallOptions, SessionEndedLog, SessionIndex, SessionStartedLog } from '../domain/ports.js';
import {
  ADVANCE_SESSION_LUA,
  APPEND_SESSION_ENDED_LUA,
  APPEND_SESSION_STARTED_LUA,
  END_SESSION_LUA,
  MARK_SESSION_STARTED_LUA,
  OPEN_SESSION_LUA,
  PAY_SESSION_LUA,
  RECORD_HOLD_LUA,
  CLAIM_SEAT_BEHAVIOR_LUA,
  SWEEP_SESSION_LUA,
} from './purchase-session-lua.js';
import { guard, SEAT_REDIS, seatKeys } from './redis-seat-store.js';

/** 구매 세션 키 이름(docs/data.md §3). 표지와 세션 상태는 같은 {jti} 해시 태그, Stream은 좌석 쪽 seatKeys.stream과 같다 */
export const sessionKeys = {
  /** 구매 세션 정리 색인 s:{event:E}:sessions(BUILD_ORDER PRF-138) */
  index: (eventId: string) => seatKeys.sessions(eventId),
  marker: (jti: string) => `s:jti:{${jti}}`,
  session: (jti: string) => `s:session:{${jti}}`,
  stream: (eventId: string) => seatKeys.stream(eventId),
};

const OPEN = redisScript(OPEN_SESSION_LUA);
const ADVANCE = redisScript(ADVANCE_SESSION_LUA);
const APPEND = redisScript(APPEND_SESSION_STARTED_LUA);
const MARK = redisScript(MARK_SESSION_STARTED_LUA);
const RECORD = redisScript(RECORD_HOLD_LUA);
const CLAIM_BEHAVIOR = redisScript(CLAIM_SEAT_BEHAVIOR_LUA);
const END = redisScript(END_SESSION_LUA);
const SWEEP = redisScript(SWEEP_SESSION_LUA);
const PAY = redisScript(PAY_SESSION_LUA);
const APPEND_ENDED = redisScript(APPEND_SESSION_ENDED_LUA);

const deadlineOf = (o: SeatCallOptions | undefined): { deadlineMs?: number } => (o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {});
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const MS_TEXT = /^(0|[1-9][0-9]*)$/;

function msOf(v: unknown, what: string): number {
  const s = str(v);
  const n = Number(s);
  if (!MS_TEXT.test(s) || !Number.isSafeInteger(n)) throw new Error(`구매 세션의 ${what} 칸이 안전한 정수 글이 아니다`);
  return n;
}

/**
 * PurchaseSessionStore의 좌석 Redis 구현. open은 열기 Lua 한 번(KEYS = [표지, 세션 상태], 기본 마감 100ms), advance는 일련번호 올리기 Lua 한 번, markStarted는 기록 표시 Lua 한 번,
 * read는 HMGET 한 번이다(일반 명령). 일시 장애(platform isRedisUnavailable)는 SeatStoreUnavailable(err), 메모리 부족은 SeatStoreUnavailable(err, 'oom')로 바꿔 던지고
 * 그 밖(스크립트 오류·WRONGTYPE·모르는 결과 값)은 그대로 던진다
 */
@Injectable()
export class RedisPurchaseSessionStore implements PurchaseSessionStore {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async open(i: OpenSessionInput): Promise<OpenSessionResult> {
    assertOpenInput(i);
    const keys = [sessionKeys.marker(i.jti), sessionKeys.session(i.jti)];
    const args = [i.accountId, i.loginSessionId, i.eventId, i.journeyId, i.clientKey ?? '', String(i.expiresAtMs), String(i.firstUseDeadlineMs), String(SESSION_IDLE_MS), String(SESSION_KEY_GRACE_MS), i.priorityGrantId ?? '', String(i.reissueUntilMs), String(SESSION_STARTED_GRACE_MS)];
    const r = await guard(this.redis.evalScript(OPEN, keys, args));
    if (!Array.isArray(r) || r.length < 1) throw new Error(`열기 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
    const kind = str(r[0]);
    switch (kind) {
      case 'CREATED':
        return { kind, startedAtMs: msOf(r[1], 'started') };
      case 'REPLAY':
        return { kind, startedAtMs: msOf(r[1], 'started'), maxStayUntilMs: msOf(r[2], 'max'), needsStarted: str(r[3]) === '1' };
      case 'MISMATCH':
      case 'ENDED':
      case 'FIRST_USE_EXPIRED':
      case 'KEY_REQUIRED':
      case 'TOKEN_EXPIRED':
        return { kind };
      default:
        throw new Error(`열기 Lua가 모르는 결과를 돌려줬다: ${kind}`);
    }
  }

  async read(jti: string): Promise<StoredSession | undefined> {
    assertJti(jti);
    const key = sessionKeys.session(jti);
    const r = await guard(this.redis.command(['HMGET', key, 'acct', 'login', 'event', 'jny', 'cpk', 'seq', 'idle', 'started', 'max', 'prio'], { key }));
    if (!Array.isArray(r) || r.length !== 10) throw new Error('구매 세션 읽기가 모르는 값을 돌려줬다');
    const [acct, login, event, jny, cpk, seq, idle, started, max, prio] = r as unknown[];
    if (isNil(acct)) return undefined;
    if ([login, event, jny, cpk, seq, idle, started, max].some(isNil)) throw new Error('구매 세션 상태의 칸이 모자란다');
    return {
      sessionId: jti,
      accountId: str(acct),
      loginSessionId: str(login),
      eventId: str(event),
      journeyId: str(jny),
      clientKey: str(cpk),
      lastSeq: msOf(seq, 'seq'),
      startedAtMs: msOf(started, 'started'),
      idleUntilMs: msOf(idle, 'idle'),
      maxStayUntilMs: msOf(max, 'max'),
      ...(isNil(prio) ? {} : { priorityGrantId: str(prio) }),
    };
  }

  async advance(jti: string, seq: number): Promise<boolean> {
    assertJti(jti);
    assertSeq(seq);
    const r = str(await guard(this.redis.evalScript(ADVANCE, [sessionKeys.session(jti)], [String(seq), String(SESSION_IDLE_MS)])));
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`일련번호 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async end(jti: string, o?: SeatCallOptions): Promise<EndedSession | null> {
    assertJti(jti);
    const r = await guard(this.redis.evalScript(END, [sessionKeys.session(jti)], [], deadlineOf(o)));
    if (!Array.isArray(r) || r.length < 1) throw new Error(`세션 끝내기 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
    const kind = str(r[0]);
    if (kind === 'GONE') return null;
    if (kind === 'ENDED' && r.length === 3) return { eventId: str(r[1]), journeyId: str(r[2]) };
    throw new Error(`세션 끝내기 Lua가 모르는 결과를 돌려줬다: ${kind}`);
  }

  async sweep(jti: string, o?: SeatCallOptions): Promise<SweepSessionResult> {
    assertJti(jti);
    const r = await guard(this.redis.evalScript(SWEEP, [sessionKeys.session(jti)], [String(SESSION_IDLE_MS)], deadlineOf(o)));
    if (!Array.isArray(r) || r.length < 1) throw new Error(`정리 점검 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
    const kind = str(r[0]);
    if (kind === 'GONE') return { kind: 'GONE' };
    if (kind === 'LIVE' && r.length === 2) return { kind: 'LIVE', nextCheckMs: msOf(r[1], 'nextCheck') };
    if (kind === 'ENDED' && r.length === 5) {
      const reason = str(r[1]);
      if (reason !== 'IDLE' && reason !== 'MAX_STAY') throw new Error(`정리 점검 Lua가 모르는 까닭을 돌려줬다: ${reason}`);
      return { kind: 'ENDED', reason, eventId: str(r[2]), journeyId: str(r[3]), endedAtMs: msOf(r[4], 'endedAt') };
    }
    throw new Error(`정리 점검 Lua가 모르는 결과를 돌려줬다: ${kind}`);
  }

  async setPaying(jti: string, paying: boolean, o?: SeatCallOptions): Promise<boolean> {
    assertJti(jti);
    const r = str(await guard(this.redis.evalScript(PAY, [sessionKeys.session(jti)], [paying ? '1' : '0', String(SESSION_IDLE_MS)], deadlineOf(o))));
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`Paying 표시 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async recordHold(jti: string, holdId: string, seatIds: readonly string[], o?: SeatCallOptions): Promise<boolean | null> {
    assertHoldRecord(jti, holdId, seatIds);
    const r = str(await guard(this.redis.evalScript(RECORD, [sessionKeys.session(jti)], [holdId, seatIds.join(',')], o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {})));
    if (r === '-1') return null;
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`홀드 기록 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async claimSeatBehavior(jti: string, o?: SeatCallOptions): Promise<boolean | null> {
    assertJti(jti);
    const r = str(await guard(this.redis.evalScript(CLAIM_BEHAVIOR, [sessionKeys.session(jti)], [], o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {})));
    if (r === '-1') return null;
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`행동 요약 표시 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async markStarted(jti: string): Promise<boolean> {
    assertJti(jti);
    const r = str(await guard(this.redis.evalScript(MARK, [sessionKeys.session(jti)], [])));
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`시작 사건 표시 Lua가 모르는 값을 돌려줬다: ${r}`);
  }
}

/** SessionStartedLog의 좌석 Redis 구현: 시작 사건 더하기 Lua 한 번(KEYS = [회차 Stream]) */
@Injectable()
export class RedisSessionStartedLog implements SessionStartedLog {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async appendStarted(e: SessionStartedEntry): Promise<void> {
    assertStartedEntry(e);
    const keepUntil = e.maxStayUntilMs + SESSION_STARTED_KEEP_MS;
    const keys = [sessionKeys.stream(e.eventId), sessionKeys.index(e.eventId)];
    const r = str(await guard(this.redis.evalScript(APPEND, keys, [String(keepUntil), e.purchaseSessionId, String(sessionCheckAt(e.startedAtMs, e.maxStayUntilMs)), ...sessionStartedFields(e)])));
    if (r !== '1') throw new Error(`시작 사건 Lua가 모르는 값을 돌려줬다: ${r}`);
  }
}

/** SessionEndedLog의 좌석 Redis 구현: 종료 사건 더하기 Lua 한 번(KEYS = [회차 Stream, 정리 색인]) */
@Injectable()
export class RedisSessionEndedLog implements SessionEndedLog {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async appendEnded(e: SessionEndedEntry, o?: SeatCallOptions): Promise<void> {
    assertEndedEntry(e);
    const keepUntil = e.endedAtMs + SESSION_STARTED_KEEP_MS;
    const keys = [sessionKeys.stream(e.eventId), sessionKeys.index(e.eventId)];
    const r = str(await guard(this.redis.evalScript(APPEND_ENDED, keys, [String(keepUntil), e.admissionJti, ...sessionEndedFields(e)], deadlineOf(o))));
    if (r !== '1') throw new Error(`종료 사건 Lua가 모르는 값을 돌려줬다: ${r}`);
  }
}

/** SessionIndex의 좌석 Redis 구현: 정렬 집합 s:{event:E}:sessions를 일반 명령으로 읽고 고친다 */
@Injectable()
export class RedisSessionIndex implements SessionIndex {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async due(eventId: string, nowMs: number, limit: number, o?: SeatCallOptions): Promise<string[]> {
    assertIndexArgs(eventId, undefined, nowMs);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit이 1 ~ 1000의 정수가 아니다');
    const key = sessionKeys.index(eventId);
    const r = await guard(this.redis.command(['ZRANGE', key, '-inf', String(nowMs), 'BYSCORE', 'LIMIT', '0', String(limit)], { key, ...deadlineOf(o) }));
    if (!Array.isArray(r)) throw new Error('정리 색인 읽기가 모르는 값을 돌려줬다');
    return r.map(str);
  }

  async requeue(eventId: string, jti: string, atMs: number, o?: SeatCallOptions): Promise<void> {
    assertIndexArgs(eventId, jti, atMs);
    const key = sessionKeys.index(eventId);
    await guard(this.redis.command(['ZADD', key, 'XX', String(atMs), jti], { key, ...deadlineOf(o) }));
  }

  async drop(eventId: string, jti: string, o?: SeatCallOptions): Promise<void> {
    assertIndexArgs(eventId, jti, 0);
    const key = sessionKeys.index(eventId);
    await guard(this.redis.command(['ZREM', key, jti], { key, ...deadlineOf(o) }));
  }
}
