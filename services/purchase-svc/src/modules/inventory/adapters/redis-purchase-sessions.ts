// 구매 세션 저장소와 시작 사건 더하기를 좌석 Redis(Valkey) Lua로 한다(BUILD_ORDER PRF-136, docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session).
// 키 이름은 sessionKeys다: 재사용 차단 표지와 세션 상태는 해시 태그가 같은 {jti}라 한 슬롯이고, 회차 Stream은 {event:E} 슬롯이다.
// 키에 넣는 값(jti·회차 ID)은 이 어댑터가 KEY_PART 모양을 다시 확인한다(해시 태그를 깨는 값이 키로 가지 않게).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import {
  assertJti,
  assertOpenInput,
  assertSeq,
  assertStartedEntry,
  type OpenSessionInput,
  type OpenSessionResult,
  SESSION_IDLE_MS,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_GRACE_MS,
  SESSION_STARTED_KEEP_MS,
  type SessionStartedEntry,
  sessionStartedFields,
  type StoredSession,
} from '../domain/purchase-session.js';
import type { PurchaseSessionStore, SessionStartedLog } from '../domain/ports.js';
import { ADVANCE_SESSION_LUA, APPEND_SESSION_STARTED_LUA, MARK_SESSION_STARTED_LUA, OPEN_SESSION_LUA } from './purchase-session-lua.js';
import { guard, SEAT_REDIS, seatKeys } from './redis-seat-store.js';

/** 구매 세션 키 이름(docs/data.md §3). 표지와 세션 상태는 같은 {jti} 해시 태그, Stream은 좌석 쪽 seatKeys.stream과 같다 */
export const sessionKeys = {
  marker: (jti: string) => `s:jti:{${jti}}`,
  session: (jti: string) => `s:session:{${jti}}`,
  stream: (eventId: string) => seatKeys.stream(eventId),
};

const OPEN = redisScript(OPEN_SESSION_LUA);
const ADVANCE = redisScript(ADVANCE_SESSION_LUA);
const APPEND = redisScript(APPEND_SESSION_STARTED_LUA);
const MARK = redisScript(MARK_SESSION_STARTED_LUA);

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
    const args = [i.accountId, i.loginSessionId, i.eventId, i.journeyId, i.clientKey, String(i.expiresAtMs), String(i.firstUseDeadlineMs), String(SESSION_IDLE_MS), String(SESSION_KEY_GRACE_MS), i.priorityGrantId ?? '', String(i.reissueUntilMs), String(SESSION_STARTED_GRACE_MS)];
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
    const r = str(await guard(this.redis.evalScript(APPEND, [sessionKeys.stream(e.eventId)], [String(keepUntil), ...sessionStartedFields(e)])));
    if (r !== '1') throw new Error(`시작 사건 Lua가 모르는 값을 돌려줬다: ${r}`);
  }
}
