// 구매 세션(docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session, BUILD_ORDER PRF-136).
// 상수·저장소 입력/결과 꼴·입력 검사·SESSION_STARTED Stream 항목과 asyncapi PurchaseSessionStarted로 바꾸는 순수 함수. 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import { createHash } from 'node:crypto';
import { KEY_PART, MAX_SEATS, SEAT_ID_PATTERN, SeatStoreUnavailable } from './hold.js';
import { type SeatLuaErrorCode, seatLuaErrorOf } from './lua-errors.js';

/** 유휴 시한: 구매 세션 요청마다 지금 + 5분 [가정]으로 다시 쓴다(queue-admission §6 '무활동 세션 만료 기준은 처음에 5분'). 넘긴 세션을 끝내는 일은 이 단계 밖 */
export const SESSION_IDLE_MS = 5 * 60_000;
/** 세션 키·재사용 차단 표지의 수명 = 최대 체류(입장 토큰 exp) + 60초 [가정] */
export const SESSION_KEY_GRACE_MS = 60_000;
/** SESSION_STARTED가 처음 만든 Stream의 수명 = 최대 체류 + 1일 [가정] (홀드·만료 Lua가 건 더 늦은 수명은 둔다) */
export const SESSION_STARTED_KEEP_MS = 24 * 3600_000;
/**
 * 열린 지 이 시간이 지나도 SESSION_STARTED 기록 표시(sev)가 없으면 REPLAY가 시작 사건을 다시 더하게 한다(1초 [가정]). 그 안은 처음 연 요청이 더하는 중으로 본다
 * (같은 입장 토큰의 동시 요청이 모두 더하지 않게. 처음 요청의 Redis 호출 마감 100ms × 두 번에 여유를 둔 값). 좌석 저장소 503의 Retry-After(2초)보다 짧아야 한다:
 * 열기 응답을 잃은 클라이언트가 Retry-After를 지켜 다시 올 때는 이미 유예가 지나 있어 그 재시도가 시작 사건을 더한다(재검토 2026-11-04)
 */
export const SESSION_STARTED_GRACE_MS = 1_000;
/** Stream 항목의 type */
export const SESSION_STARTED_TYPE = 'SESSION_STARTED';
/** 종료 사건 Stream 항목의 type(BUILD_ORDER PRF-138) */
export const SESSION_ENDED_TYPE = 'SESSION_ENDED';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 클라이언트 임시 공개키 글: 비압축 점 65바이트의 base64url(채움 없음) = 87자 */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;

/** 구매 세션을 여는 저장소 입력(PurchaseSessionStore.open) */
export interface OpenSessionInput {
  /** 입장 토큰의 jti = 구매 세션 ID (KEY_PART 모양, 키의 해시 태그에 들어간다) */
  jti: string;
  accountId: string;
  /** 로그인 세션 ID(입장 토큰의 sid) */
  loginSessionId: string;
  eventId: string;
  /** 여정 ID(입장 토큰의 jny, UUID) */
  journeyId: string;
  /**
   * 클라이언트 임시 공개키(CLIENT_KEY_PATTERN). 저장소는 곡선 위의 점인지 보지 않는다(유스케이스가 거른다).
   * 없으면(undefined) 세션이 열린 뒤의 재요청이다: 표지가 있을 때 키는 비교하지 않고, 표지가 없어 새로 열어야 하면 KEY_REQUIRED를 돌려준다(BUILD_ORDER PRF-137)
   */
  clientKey?: string;
  /** 최대 체류 시각(입장 토큰 exp, epoch ms, 안전한 정수) */
  expiresAtMs: number;
  /** 첫 사용 기한(입장 토큰 iat + 5분, epoch ms, 0 이상의 안전한 정수) */
  firstUseDeadlineMs: number;
  /**
   * 같은 jti로 다시 받을 수 있는 가장 늦은 입장 토큰의 exp(epoch ms, expiresAtMs 이상의 안전한 정수). queue-svc는 자리가 살아 있는 동안(최대 체류 안) 같은 jti로 새 입장 토큰을
   * 다시 주고 그 exp는 새 iat + 최대 체류라서, 유스케이스는 exp + (exp − iat)를 준다. 재사용 차단 표지의 수명은 이 시각 + 60초라 다시 받은 토큰으로 세션을 새로 열지 못한다.
   */
  reissueUntilMs: number;
  /** 우선 구매 입장의 권리 ID(입장 토큰 prio, KEY_PART 모양) */
  priorityGrantId?: string;
}

/**
 * 열기 결과. 저장소 시각(Redis TIME, 메모리는 주입 Clock)으로 가른다:
 * - CREATED: 재사용 차단 표지가 없었고 최대 체류 앞이며 첫 사용 기한 안이라 표지와 세션 상태를 함께 만들었다. startedAtMs = 만든 시각
 * - REPLAY: 표지와 세션 상태가 있고 계정·로그인 세션·회차·임시 공개키가 모두 같고 세션의 처음 최대 체류 앞이다(응답을 잃은 재시도, 같은 jti로 다시 받은 입장 토큰).
 *   startedAtMs = 처음 연 시각, maxStayUntilMs = 세션에 적힌 처음 최대 체류(다시 받은 토큰의 더 늦은 exp가 아니다), needsStarted = 이 요청이 SESSION_STARTED를 더해야 하는지
 *   (markStarted 표시가 없고 연 지 SESSION_STARTED_GRACE_MS가 지났다. 더하기가 실패했거나 표시가 실패한 채 응답을 잃은 재시도다. 그 안은 처음 연 요청이 더하는 중이라 false).
 *   세션 상태는 바꾸지 않는다. 다시 받은 토큰의 exp가 세션의 처음 최대 체류보다 늦으면 표지 수명만 그 토큰의 reissueUntilMs + 60초까지 늘린다(줄이지 않는다)
 * - MISMATCH: 표지와 세션 상태가 있는데 위 넷 가운데 하나라도 다르다
 * - ENDED: 표지만 있고 세션 상태가 없다(끝난 세션. 같은 입장 토큰으로 다시 열지 못한다)
 * - FIRST_USE_EXPIRED: 표지가 없는데 지금이 첫 사용 기한을 지났다(아무것도 쓰지 않았다)
 * - KEY_REQUIRED: 표지가 없어 새로 열어야 하는데 clientKey가 없다(첫 사용 기한 안일 때만. 아무것도 쓰지 않았다)
 * - TOKEN_EXPIRED: 지금이 입장 토큰의 최대 체류(exp) 이상이다(표지 유무와 관계없이 먼저 본다), 또는 REPLAY 갈래에서 세션에 적힌 처음 최대 체류 이상이다. 아무것도 쓰지 않았다
 */
export type OpenSessionResult =
  | { kind: 'CREATED'; startedAtMs: number }
  | { kind: 'REPLAY'; startedAtMs: number; maxStayUntilMs: number; needsStarted: boolean }
  | { kind: 'MISMATCH' }
  | { kind: 'ENDED' }
  | { kind: 'FIRST_USE_EXPIRED' }
  | { kind: 'KEY_REQUIRED' }
  | { kind: 'TOKEN_EXPIRED' };

/** 저장된 구매 세션 상태(docs/data.md §3 s:session:{jti}). 시간으로 거르지 않은 저장 값 그대로다 */
export interface StoredSession {
  /** 구매 세션 ID = 입장 토큰 jti */
  sessionId: string;
  accountId: string;
  loginSessionId: string;
  eventId: string;
  journeyId: string;
  clientKey: string;
  /** 마지막으로 받은 요청 일련번호(처음 0) */
  lastSeq: number;
  startedAtMs: number;
  /** 유휴 시한(epoch ms) */
  idleUntilMs: number;
  /** 최대 체류 시각(epoch ms) */
  maxStayUntilMs: number;
  priorityGrantId?: string;
}

/** SESSION_STARTED Stream 항목 하나(docs/data.md §3 s:{event:E}:stream) */
export interface SessionStartedEntry {
  eventId: string;
  purchaseSessionId: string;
  admissionJti: string;
  journeyId: string;
  startedAtMs: number;
  maxStayUntilMs: number;
}

/** asyncapi/Avro PurchaseSessionStarted (docs/api/avro/peaket/trade/PurchaseSessionStarted.avsc) */
export interface PurchaseSessionStartedMessage {
  eventId: string;
  purchaseSessionId: string;
  admissionJti: string;
  journeyId: string;
  startedAt: string;
  maxStayUntil: string;
  eventKey: string;
}

/**
 * 구매 세션 저장소가 던진 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY s:session:{jti} …)를 code만 담아 다시 던지는 오류. 원래 오류 글에는 구매 세션 ID(jti)가 든 키 이름이 있어
 * 플랫폼 500 응답·정규 로그 줄의 err에 남지 않게 한다(ASVS v5.0.0-16.2.5). 원래 오류를 cause로 싣지 않는다
 */
export class SessionStoreFailure extends Error {
  constructor(readonly code: SeatLuaErrorCode) {
    super(`구매 세션 저장소 오류 ${code}`);
    this.name = 'SessionStoreFailure';
  }
}

/**
 * 저장소 오류에서 키 이름이 든 오류 글(PEAKET_…·s:{…·s:jti·s:session)을 지운다: 그런 Error는 SessionStoreFailure(code만)로 바꿔 돌려주고,
 * 좌석 Redis 일시 장애(SeatStoreUnavailable)와 그 밖의 값은 그대로 돌려준다(던지지 않는다)
 */
export function sessionStoreErrorOf(err: unknown): unknown {
  if (err instanceof SeatStoreUnavailable || !(err instanceof Error)) return err;
  if (!/PEAKET_|s:\{|s:jti|s:session/.test(err.message)) return err;
  return new SessionStoreFailure(seatLuaErrorOf(err)?.code ?? 'OTHER');
}

const isKeyPart = (v: unknown): v is string => typeof v === 'string' && KEY_PART.test(v);
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** jti가 KEY_PART 모양이 아니면 RangeError (Redis 키의 해시 태그를 깨지 않게) */
export function assertJti(jti: string): void {
  if (!isKeyPart(jti)) throw new RangeError('jti가 키 조각 모양이 아니다');
}

/** 일련번호가 1 이상의 안전한 정수가 아니면 RangeError */
export function assertSeq(seq: number): void {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new RangeError('일련번호가 1 이상의 안전한 정수가 아니다');
}

/** 열기 입력의 모양 검사. 틀리면 RangeError (아무것도 부르지 않는다) */
export function assertOpenInput(i: OpenSessionInput): void {
  assertJti(i.jti);
  if (!isKeyPart(i.accountId)) throw new RangeError('accountId가 키 조각 모양이 아니다');
  if (!isKeyPart(i.loginSessionId)) throw new RangeError('loginSessionId가 키 조각 모양이 아니다');
  if (!isKeyPart(i.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (i.priorityGrantId !== undefined && !isKeyPart(i.priorityGrantId)) throw new RangeError('priorityGrantId가 키 조각 모양이 아니다');
  if (typeof i.journeyId !== 'string' || !UUID_PATTERN.test(i.journeyId)) throw new RangeError('journeyId가 UUID가 아니다');
  if (i.clientKey !== undefined && (typeof i.clientKey !== 'string' || !CLIENT_KEY_PATTERN.test(i.clientKey))) throw new RangeError('clientKey가 87자 base64url이 아니다');
  if (!isMs(i.expiresAtMs)) throw new RangeError('expiresAtMs가 0 이상의 안전한 정수가 아니다');
  if (!isMs(i.firstUseDeadlineMs)) throw new RangeError('firstUseDeadlineMs가 0 이상의 안전한 정수가 아니다');
  if (!isMs(i.reissueUntilMs) || i.reissueUntilMs < i.expiresAtMs) throw new RangeError('reissueUntilMs가 expiresAtMs 이상의 안전한 정수가 아니다');
}

/** SESSION_STARTED 항목의 모양 검사. 틀리면 RangeError */
export function assertStartedEntry(e: SessionStartedEntry): void {
  if (!isKeyPart(e.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!isKeyPart(e.purchaseSessionId)) throw new RangeError('purchaseSessionId가 키 조각 모양이 아니다');
  if (!isKeyPart(e.admissionJti)) throw new RangeError('admissionJti가 키 조각 모양이 아니다');
  if (typeof e.journeyId !== 'string' || !UUID_PATTERN.test(e.journeyId)) throw new RangeError('journeyId가 UUID가 아니다');
  if (!isMs(e.startedAtMs) || !isMs(e.maxStayUntilMs)) throw new RangeError('시각이 0 이상의 안전한 정수가 아니다');
}

/** 홀드 기록(PurchaseSessionStore.recordHold) 입력의 모양 검사. jti·holdId는 KEY_PART, 좌석 ID는 1~MAX_SEATS개이고 좌석 ID 모양. 틀리면 RangeError */
export function assertHoldRecord(jti: string, holdId: string, seatIds: readonly string[]): void {
  assertJti(jti);
  if (!isKeyPart(holdId)) throw new RangeError('holdId가 키 조각 모양이 아니다');
  if (!Array.isArray(seatIds) || seatIds.length < 1 || seatIds.length > MAX_SEATS) throw new RangeError(`좌석 ID는 1~${MAX_SEATS}개여야 한다`);
  for (const id of seatIds) if (typeof id !== 'string' || !SEAT_ID_PATTERN.test(id)) throw new RangeError('좌석 ID가 좌석 ID 모양이 아니다');
}

/** XADD에 넘길 이름·값 쌍(값은 모두 글). 순서: type, purchaseSessionId, admissionJti, journeyId, startedAtMs, maxStayUntilMs */
export function sessionStartedFields(e: SessionStartedEntry): string[] {
  return ['type', SESSION_STARTED_TYPE, 'purchaseSessionId', e.purchaseSessionId, 'admissionJti', e.admissionJti, 'journeyId', e.journeyId, 'startedAtMs', String(e.startedAtMs), 'maxStayUntilMs', String(e.maxStayUntilMs)];
}

/**
 * 같은 구매 세션이면 같은 UUID 버전 8(RFC 9562 사용자 정의): SHA-256("PurchaseSessionStarted:" + 구매 세션 ID)의 앞 16바이트에 버전 8·변형 비트를 맞춘다.
 * 같은 사건을 다시 보내면 같은 값이다(중복 제거 키, ADR-0052)
 */
export function sessionStartedEventKey(purchaseSessionId: string): string {
  return uuid8(`PurchaseSessionStarted:${purchaseSessionId}`);
}

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8(RFC 9562 사용자 정의)·변형 비트를 맞춘 UUID 글(좌석 사건 eventKey도 쓴다, seat-event.ts) */
export function uuid8(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const MS_TEXT = /^(0|[1-9][0-9]*)$/;
function msOf(v: string | undefined, name: string): number {
  if (v === undefined || !MS_TEXT.test(v)) throw new RangeError(`${name}이(가) 10진 정수 글이 아니다`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name}이(가) 안전한 정수가 아니다`);
  return n;
}

/**
 * Stream 항목의 칸(XRANGE로 읽은 값)을 asyncapi PurchaseSessionStarted로 바꾼다. eventId는 Stream 키의 회차다.
 * type이 SESSION_STARTED가 아니거나 칸이 없거나 모양이 틀리면 RangeError (잘못된 사건을 Kafka로 내지 않는다)
 */
export function toPurchaseSessionStarted(eventId: string, f: Readonly<Record<string, string | undefined>>): PurchaseSessionStartedMessage {
  if (!isKeyPart(eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (f.type !== SESSION_STARTED_TYPE) throw new RangeError('type이 SESSION_STARTED가 아니다');
  const { purchaseSessionId, admissionJti, journeyId } = f;
  if (!isKeyPart(purchaseSessionId) || !isKeyPart(admissionJti)) throw new RangeError('구매 세션 ID·입장 토큰 jti가 키 조각 모양이 아니다');
  if (typeof journeyId !== 'string' || !UUID_PATTERN.test(journeyId)) throw new RangeError('journeyId가 UUID가 아니다');
  const startedAtMs = msOf(f.startedAtMs, 'startedAtMs');
  const maxStayUntilMs = msOf(f.maxStayUntilMs, 'maxStayUntilMs');
  return {
    eventId,
    purchaseSessionId,
    admissionJti,
    journeyId,
    startedAt: new Date(startedAtMs).toISOString(),
    maxStayUntil: new Date(maxStayUntilMs).toISOString(),
    eventKey: sessionStartedEventKey(purchaseSessionId),
  };
}

// ── 구매 세션 종료와 정리(BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리') ──────────────────────

/** 구매 세션이 끝나는 까닭(asyncapi PurchaseSessionEnded.reason의 UNRECOGNIZED를 뺀 값) */
export type SessionEndReason = 'COMPLETED' | 'LEFT' | 'IDLE' | 'MAX_STAY';
export const SESSION_END_REASONS: readonly SessionEndReason[] = ['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY'];

/** 끝낸 세션에서 읽은 값(PurchaseSessionStore.end의 결과) */
/** 구매 세션의 홀드 한 건(h:{holdId} 칸, BUILD_ORDER HOT-070) */
export interface SessionHoldEntry {
  holdId: string;
  seatIds: string[];
}

export interface EndedSession {
  /** 세션이 묶인 회차 ID */
  eventId: string;
  /** 여정 ID */
  journeyId: string;
  /** 세션의 계정(홀드를 풀 때 쓴다, BUILD_ORDER HOT-070). 없으면 빈 글 */
  accountId?: string;
  /** 세션을 지울 때 함께 읽은 홀드 목록(BUILD_ORDER HOT-070) */
  holds?: SessionHoldEntry[];
}

/** SESSION_ENDED Stream 항목 하나 */
export interface SessionEndedEntry {
  eventId: string;
  purchaseSessionId: string;
  admissionJti: string;
  reason: SessionEndReason;
  endedAtMs: number;
}

/** asyncapi/Avro PurchaseSessionEnded (docs/api/avro/peaket/trade/PurchaseSessionEnded.avsc) */
export interface PurchaseSessionEndedMessage {
  eventId: string;
  purchaseSessionId: string;
  admissionJti: string;
  reason: SessionEndReason;
  endedAt: string;
  eventKey: string;
}

/**
 * 정리 점검(PurchaseSessionStore.sweep)의 결과. 저장소 시각(Redis TIME, 메모리는 주입 Clock)으로 가른다:
 * - GONE: 세션 상태가 없다(이미 끝났거나 키 수명으로 사라졌다)
 * - LIVE: 살아 있다. nextCheckMs = 다음에 볼 시각(Paying이면 min(최대 체류, 지금 + 유휴 5분), 아니면 min(최대 체류, 유휴 시한))
 * - ENDED: 이번 점검이 끝냈다(세션 상태를 지웠다). reason은 IDLE 또는 MAX_STAY, endedAtMs = 끝낸 저장소 시각
 */
export type SweepSessionResult =
  | { kind: 'GONE' }
  | { kind: 'LIVE'; nextCheckMs: number }
  | { kind: 'ENDED'; reason: 'IDLE' | 'MAX_STAY'; eventId: string; journeyId: string; endedAtMs: number; accountId?: string; holds?: SessionHoldEntry[] };

/** 정리 색인 s:{event:E}:sessions의 첫 점수 = min(최대 체류, 시작 + 유휴 5분). 시작 사건을 더하는 Lua가 ZADD NX로 넣는다 */
export function sessionCheckAt(startedAtMs: number, maxStayUntilMs: number): number {
  return Math.min(maxStayUntilMs, startedAtMs + SESSION_IDLE_MS);
}

/** 정리 색인 입력의 모양 검사(공용): eventId·jti는 KEY_PART, 시각은 0 이상의 안전한 정수. 틀리면 RangeError */
export function assertIndexArgs(eventId: string, jti: string | undefined, atMs: number): void {
  assertJti(eventId);
  if (jti !== undefined) assertJti(jti);
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError('시각이 0 이상의 안전한 정수가 아니다');
}

/** SESSION_ENDED 항목의 모양 검사. 틀리면 RangeError(eventId·purchaseSessionId·admissionJti는 KEY_PART, reason은 SESSION_END_REASONS, 시각은 0 이상의 안전한 정수) */
export function assertEndedEntry(e: SessionEndedEntry): void {
  if (!isKeyPart(e.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!isKeyPart(e.purchaseSessionId)) throw new RangeError('purchaseSessionId가 키 조각 모양이 아니다');
  if (!isKeyPart(e.admissionJti)) throw new RangeError('admissionJti가 키 조각 모양이 아니다');
  if (!SESSION_END_REASONS.includes(e.reason)) throw new RangeError('reason이 모르는 값이다');
  if (!isMs(e.endedAtMs)) throw new RangeError('endedAtMs가 0 이상의 안전한 정수가 아니다');
}

/** XADD에 넘길 이름·값 쌍(값은 모두 글). 순서: type, purchaseSessionId, admissionJti, reason, endedAtMs */
export function sessionEndedFields(e: SessionEndedEntry): string[] {
  return ['type', SESSION_ENDED_TYPE, 'purchaseSessionId', e.purchaseSessionId, 'admissionJti', e.admissionJti, 'reason', e.reason, 'endedAtMs', String(e.endedAtMs)];
}

/**
 * 같은 구매 세션이면 같은 UUID 버전 8: SHA-256("PurchaseSessionEnded:" + 구매 세션 ID)의 앞 16바이트에 버전 8·변형 비트를 맞춘다(세션 하나는 한 번 끝난다, ADR-0052).
 * sessionStartedEventKey와 같은 방식이고 접두만 다르다
 */
export function sessionEndedEventKey(purchaseSessionId: string): string {
  return uuid8(`PurchaseSessionEnded:${purchaseSessionId}`);
}

/** Stream 항목의 칸을 asyncapi PurchaseSessionEnded로 바꾼다. type이 SESSION_ENDED가 아니거나 칸이 없거나 모양이 틀리거나 reason이 모르는 값이면 RangeError */
export function toPurchaseSessionEnded(eventId: string, f: Readonly<Record<string, string | undefined>>): PurchaseSessionEndedMessage {
  if (!isKeyPart(eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (f.type !== SESSION_ENDED_TYPE) throw new RangeError('type이 SESSION_ENDED가 아니다');
  const { purchaseSessionId, admissionJti } = f;
  if (!isKeyPart(purchaseSessionId) || !isKeyPart(admissionJti)) throw new RangeError('구매 세션 ID·입장 토큰 jti가 키 조각 모양이 아니다');
  const reason = f.reason as SessionEndReason | undefined;
  if (reason === undefined || !SESSION_END_REASONS.includes(reason)) throw new RangeError('reason이 모르는 값이다');
  const endedAtMs = msOf(f.endedAtMs, 'endedAtMs');
  return { eventId, purchaseSessionId, admissionJti, reason, endedAt: new Date(endedAtMs).toISOString(), eventKey: sessionEndedEventKey(purchaseSessionId) };
}
