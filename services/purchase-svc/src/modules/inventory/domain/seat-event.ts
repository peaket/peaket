// 좌석 Redis Stream 항목 → Kafka 사건 바꾸기와 홀드 원장 적재의 규칙 값(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현',
// asyncapi SeatEvent·PurchaseSessionStarted·PurchaseSessionEnded). 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import { KEY_PART } from './hold.js';
import {
  SESSION_ENDED_TYPE,
  SESSION_STARTED_TYPE,
  toPurchaseSessionEnded,
  toPurchaseSessionStarted,
  uuid8,
  type PurchaseSessionEndedMessage,
  type PurchaseSessionStartedMessage,
} from './purchase-session.js';
import { SALE_UUID_PATTERN } from './seat-sale.js';

/** 좌석 사건 토픽(asyncapi trade.seats)과 구매 세션 사건 토픽(trade.purchase-sessions). 키는 둘 다 회차 ID다 */
export const SEAT_TOPIC = 'trade.seats';
export const PURCHASE_SESSION_TOPIC = 'trade.purchase-sessions';
export type TradeTopic = typeof SEAT_TOPIC | typeof PURCHASE_SESSION_TOPIC;

/** 홀드 사건 종류(좌석 Redis Stream 릴레이가 내는 것). 판매 사건(PENDING·SOLD·AVAILABLE·RETURNED)은 seat_sale Outbox가 낸다 */
export const HOLD_EVENT_TYPES = ['HELD', 'RELEASED', 'EXPIRED'] as const;
export type HoldEventType = (typeof HOLD_EVENT_TYPES)[number];

/** 릴레이 한 틱에 회차마다 읽는 항목 수 100 [가정] */
export const STREAM_RELAY_BATCH = 100;
/** 한 틱에 회차마다 이어 읽는 묶음 수의 상한 20 [가정](회차마다 한 틱에 2,000항목). 닿으면 쉬지 않고 바로 다음 틱을 돈다 */
export const STREAM_RELAY_MAX_BATCHES = 20;
/** 릴레이 틱 주기 1초 [가정] */
export const STREAM_RELAY_TICK_MS = 1_000;
/** 실패 뒤 늘려 쉬기 0.2~5초 [가정] */
export const STREAM_RELAY_BACKOFF_MIN_MS = 200;
export const STREAM_RELAY_BACKOFF_MAX_MS = 5_000;
/** 좌석 Stream 소비자 그룹과 소비자 이름(리더 하나가 같은 이름으로 읽는다, docs/data.md §4 '홀드 원장 적재와 Stream 릴레이') */
export const STREAM_RELAY_GROUP = 'stream-relay';
export const STREAM_RELAY_CONSUMER = 'relay';

/** Stream 항목 하나(XREADGROUP으로 읽은 ID와 칸). 값은 모두 글이다 */
export interface SeatStreamEntry {
  id: string;
  fields: Readonly<Record<string, string>>;
}

/** asyncapi SeatEvent 가운데 홀드 사건(HELD·RELEASED·EXPIRED)의 모양. 시각은 ISO 8601 글이다 */
export interface SeatEventMessage {
  eventId: string;
  seatId: string;
  tierId: string;
  sectionId: string;
  type: HoldEventType;
  fencingToken: number;
  sectionVersion: number;
  seatEpoch: number;
  holdId: string;
  holdKind: 'FAN' | 'PRIORITY';
  /** holdKind FAN일 때만 */
  purchaseSessionId?: string;
  /** holdKind PRIORITY일 때만 */
  priorityGrantId?: string;
  accountId: string;
  expiresAt: string;
  occurredAt: string;
  eventKey: string;
}

/** 보낼 수 없는 항목을 넘기는 까닭(지표 seat_stream_relay_dropped_total의 reason) */
export type StreamDropReason = 'unknown_type' | 'malformed' | 'unmapped_seat';

/** Stream 항목 하나를 어디로 보낼지 */
export type StreamRoute =
  | { kind: 'send'; topic: typeof SEAT_TOPIC; message: SeatEventMessage }
  | { kind: 'send'; topic: typeof PURCHASE_SESSION_TOPIC; message: PurchaseSessionStartedMessage | PurchaseSessionEndedMessage }
  | { kind: 'drop'; reason: StreamDropReason };

const isHoldType = (t: unknown): t is HoldEventType => typeof t === 'string' && (HOLD_EVENT_TYPES as readonly string[]).includes(t);
/** 판매 행 seat_sale의 Outbox가 내는 SeatEvent 종류(원장 적재가 건너뛴다) */
const SALE_EVENT_TYPES: readonly string[] = ['PENDING', 'SOLD', 'AVAILABLE', 'RETURNED'];
const DEC = /^(0|[1-9][0-9]*)$/;

function intOf(v: string | undefined, name: string): number {
  if (v === undefined || !DEC.test(v)) throw new RangeError(`${name}이(가) 10진 정수 글이 아니다`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name}이(가) 안전한 정수가 아니다`);
  return n;
}
function textOf(v: string | undefined, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new RangeError(`${name}이(가) 비었다`);
  return v;
}
function isoOf(ms: number, name: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new RangeError(`${name}이(가) 날짜 범위를 넘었다`);
  return d.toISOString();
}

/**
 * 홀드 사건의 eventKey: UUID 버전 8(SHA-256('SeatEvent:' + type + ':' + eventId + ':' + holdId + ':' + seatId + ':' + fencingToken)의 앞 16바이트).
 * 같은 항목을 다시 보내면 같고, 여러 좌석을 한 번에 잡은 홀드의 좌석끼리, 같은 holdId로 다시 잡은 홀드(좌석 묶기, 새 펜싱 토큰)와 처음 홀드끼리는 다르다
 */
export function seatEventKey(type: HoldEventType, eventId: string, holdId: string, seatId: string, fencingToken: number): string {
  return uuid8(`SeatEvent:${type}:${eventId}:${holdId}:${seatId}:${fencingToken}`);
}

/**
 * 홀드 사건 항목(HELD·RELEASED·EXPIRED)의 칸을 SeatEvent로 바꾼다. eventId는 Stream 키의 회차다.
 * @throws RangeError 칸이 없거나 모양이 틀림(좌석맵 판에 없는 좌석이라 seatId 등이 빈 글인 것도 포함. 구분은 routeStreamEntry가 한다)
 */
export function toSeatEvent(eventId: string, f: Readonly<Record<string, string | undefined>>): SeatEventMessage {
  if (!KEY_PART.test(eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  const type = f.type;
  if (!isHoldType(type)) throw new RangeError('type이 홀드 사건(HELD·RELEASED·EXPIRED)이 아니다');
  const holdKind = f.holdKind;
  if (holdKind !== 'FAN' && holdKind !== 'PRIORITY') throw new RangeError('holdKind가 FAN·PRIORITY가 아니다');
  const holdId = textOf(f.holdId, 'holdId');
  const m: SeatEventMessage = {
    eventId,
    seatId: textOf(f.seatId, 'seatId'),
    tierId: textOf(f.tierId, 'tierId'),
    sectionId: textOf(f.sectionId, 'sectionId'),
    type,
    fencingToken: intOf(f.fencingToken, 'fencingToken'),
    sectionVersion: intOf(f.sectionVersion, 'sectionVersion'),
    seatEpoch: intOf(f.seatEpoch, 'seatEpoch'),
    holdId,
    holdKind,
    accountId: textOf(f.accountId, 'accountId'),
    expiresAt: isoOf(intOf(f.expiresAtMs, 'expiresAtMs'), 'expiresAtMs'),
    occurredAt: isoOf(intOf(f.occurredAtMs, 'occurredAtMs'), 'occurredAtMs'),
    eventKey: '',
  };
  m.eventKey = seatEventKey(type, eventId, holdId, m.seatId, m.fencingToken);
  if (holdKind === 'FAN') m.purchaseSessionId = textOf(f.purchaseSessionId, 'purchaseSessionId');
  else m.priorityGrantId = textOf(f.priorityGrantId, 'priorityGrantId');
  return m;
}

/** 항목 하나의 갈 곳: 홀드 사건은 trade.seats, 구매 세션 사건은 trade.purchase-sessions, 나머지는 넘김(까닭과 함께). 던지지 않는다 */
export function routeStreamEntry(eventId: string, entry: SeatStreamEntry): StreamRoute {
  try {
    const f = entry.fields;
    const type = f.type;
    if (isHoldType(type)) {
      // 좌석맵 판에 없는 좌석의 만료(expiry.ts)는 좌석·등급·구역 ID가 빈 글이다
      if (!f.seatId || !f.tierId || !f.sectionId) return { kind: 'drop', reason: 'unmapped_seat' };
      return { kind: 'send', topic: SEAT_TOPIC, message: toSeatEvent(eventId, f) };
    }
    if (type === SESSION_STARTED_TYPE) return { kind: 'send', topic: PURCHASE_SESSION_TOPIC, message: toPurchaseSessionStarted(eventId, f) };
    if (type === SESSION_ENDED_TYPE) return { kind: 'send', topic: PURCHASE_SESSION_TOPIC, message: toPurchaseSessionEnded(eventId, f) };
    return { kind: 'drop', reason: 'unknown_type' };
  } catch {
    return { kind: 'drop', reason: 'malformed' };
  }
}

const uuidOf = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !SALE_UUID_PATTERN.test(v)) throw new RangeError(`${name}이(가) 소문자 UUID가 아니다`);
  return v;
};
const msOfIso = (v: unknown, name: string): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`${name}이(가) ISO 8601 시각이 아니다`);
  return ms;
};

/** 원장에 쓸 홀드 사건(소비자가 읽어 검사한 값). 시각은 유닉스 밀리초 */
export interface LedgerHoldEvent {
  eventId: string;
  seatId: string;
  accountId: string;
  type: HoldEventType;
  fencingToken: number;
  holdKind: 'FAN' | 'PRIORITY';
  priorityGrantId?: string;
  occurredAtMs: number;
  expiresAtMs: number;
  eventKey: string;
  /** SeatEvent의 holdId·purchaseSessionId(원장 hold_id·purchase_session_id, 다시 만들기가 쓴다, BUILD_ORDER PRF-143) */
  holdId?: string;
  purchaseSessionId?: string;
}

/**
 * Kafka에서 읽은 SeatEvent 값(이미 JSON으로 푼 객체)을 원장 사건으로 바꾼다. 홀드 사건이 아니면(판매 사건) null.
 * @throws RangeError 회차·좌석·계정이 소문자 UUID가 아니거나 accountId·expiresAt·fencingToken·holdId가 빠짐(같은 결과일 실패라 보류된다)
 */
export function toLedgerHoldEvent(value: unknown): LedgerHoldEvent | null {
  if (typeof value !== 'object' || value === null) throw new RangeError('SeatEvent가 객체가 아니다');
  const v = value as Record<string, unknown>;
  if (typeof v.type === 'string' && SALE_EVENT_TYPES.includes(v.type)) return null;
  if (!isHoldType(v.type)) throw new RangeError('type이 홀드 사건(HELD·RELEASED·EXPIRED)이 아니다');
  if (!Number.isSafeInteger(v.fencingToken) || (v.fencingToken as number) < 1) throw new RangeError('fencingToken이 1 이상의 안전한 정수가 아니다');
  if (typeof v.holdId !== 'string' || v.holdId.length === 0) throw new RangeError('holdId가 비었다');
  if (v.holdKind !== 'FAN' && v.holdKind !== 'PRIORITY') throw new RangeError('holdKind가 FAN·PRIORITY가 아니다');
  if (typeof v.eventKey !== 'string' || v.eventKey.length === 0) throw new RangeError('eventKey가 비었다');
  const e: LedgerHoldEvent = {
    eventId: uuidOf(v.eventId, 'eventId'),
    seatId: uuidOf(v.seatId, 'seatId'),
    accountId: uuidOf(v.accountId, 'accountId'),
    type: v.type,
    fencingToken: v.fencingToken as number,
    holdKind: v.holdKind,
    occurredAtMs: msOfIso(v.occurredAt, 'occurredAt'),
    expiresAtMs: msOfIso(v.expiresAt, 'expiresAt'),
    eventKey: v.eventKey,
    // 원장 hold_id(다시 만들기가 되살린 홀드 Hash의 holdId, BUILD_ORDER PRF-143). 위에서 빈 글이 아님을 봤다
    holdId: v.holdId,
  };
  if (v.holdKind === 'PRIORITY') e.priorityGrantId = uuidOf(v.priorityGrantId, 'priorityGrantId');
  // 구매 세션 ID는 FAN 홀드만 싣는다(우선 구매 보류는 구매 세션이 없다. 값이 와도 싣지 않는다). 빈 글·글이 아닌 값은 싣지 않는다(원장 칸은 NULL)
  else if (typeof v.purchaseSessionId === 'string' && v.purchaseSessionId.length > 0) e.purchaseSessionId = v.purchaseSessionId;
  return e;
}
