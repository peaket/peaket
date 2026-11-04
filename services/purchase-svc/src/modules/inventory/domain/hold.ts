// 좌석 홀드의 규칙 값과 타입(docs/features/seat-hold.md §3~§5, docs/data.md §3 좌석 키, BUILD_ORDER PRF-130 ①).
// 값의 출처: 홀드 TTL 7분(POL-012), 다시 잡기 30초 [가정](ADR-0161 결정 2), 좌석 수 1~10(openapi HoldRequest), 멱등 키 수명 = 홀드 TTL(guidelines §4, R-224).
import { createHash } from 'node:crypto';

/** 홀드 TTL 7분(POL-012). 홀드 Hash의 exp = heldAt + 이 값 */
export const HOLD_TTL_MS = 7 * 60_000;
/** 샤드 Pub/Sub 델타의 좌석 상태 값(docs/data.md §3 s:{event:E}:sec:{section}, docs/frontend.md §4.4.1): 1 = 다른 분 선택(홀드) */
export const SEAT_STATE_HELD = 1;
/** 같은 계정이 방금 놓은 좌석을 다시 잡을 수 있을 때까지 30초 [가정](ADR-0161 결정 2). 해제·만료 Lua가 rel 점수로 쓴다(PRF-130 ①의 홀드 Lua는 읽기만) */
export const REHOLD_WAIT_MS = 30_000;
/** 요청 하나의 좌석 수 상한(openapi HoldRequest.seatIds maxItems) */
export const MAX_SEATS = 10;
/** 홀드 멱등 키 s:{event:E}:idem:{account}:{key}의 수명 7분(홀드 TTL과 같다, guidelines §4, R-224) */
export const IDEM_TTL_MS = HOLD_TTL_MS;
/** 회차 키(비트맵·홀드·보유 수·fence·expiry·epoch)의 수명 = 판매 종료 + 1일 [가정](docs/data.md §3) */
export const KEEP_AFTER_SALE_END_MS = 24 * 3600_000;
/** 좌석 저장소 503(seat-store-unavailable)의 Retry-After 2초 [가정](ADR-0121) */
export const SEAT_STORE_RETRY_AFTER_SEC = 2;

/** Redis 키의 해시 태그·구분자 안에 들어가는 값(회차 ID·계정 ID)의 모양. 받는 층이 이 모양만 넘긴다 */
export const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 좌석 ID의 모양(openapi HoldRequest.seatIds.items.pattern) */
export const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 좌석맵 판의 좌석 하나(좌석 ID를 비트맵 색인으로 바꾼 것, docs/data.md §3 좌석 키의 색인 뜻) */
export interface SeatRef {
  /** 좌석 ID(SEAT_ID_PATTERN) */
  seatId: string;
  /** 비트맵 색인(0부터, 회차 좌석 수 미만의 정수). 홀드 Hash s:{event:E}:hold:{색인}·만료 인덱스 멤버·Stream seatIdx */
  index: number;
  /** 구역 ID(Stream sectionId, HoldAttempt.sectionId) */
  sectionId: string;
  /** 구역 색인(0부터의 정수). secver의 칸 이름이고 샤드 Pub/Sub 채널 s:{event:E}:sec:{구역 색인}의 끝이다 */
  sectionIndex: number;
  /** 구역 안 거리(그 구역 seatIndexRange.from에서의 거리, 0 이상의 정수). 샤드 Pub/Sub 델타의 seatOffset */
  seatOffset: number;
  /** 등급 ID(Stream tierId, HoldAttempt.tierId) */
  tierId: string;
}

/**
 * SeatStore.hold의 입력. 부르는 쪽(HoldSeats)이 다음을 맞춰 넘긴다(저장소는 다시 보지 않는다).
 * - eventId·accountId는 KEY_PART 모양이다.
 * - seats는 1~MAX_SEATS개이고 좌석 ID 오름차순(문자 코드 순)으로 정렬했으며 좌석 ID·색인이 겹치지 않는다.
 * - fingerprint는 holdFingerprint(seats의 좌석 ID)다.
 */
export interface HoldInput {
  eventId: string;
  /** 소유 계정(플랫폼 인증 가드가 정한 계정). quota:{account}·rel:{account}·idem:{account}:{key}의 계정 */
  accountId: string;
  /** 구매 세션 ID. 홀드 Hash의 psid */
  purchaseSessionId: string;
  /** purchase-svc가 Lua 전에 만든 홀드 ID(UUIDv7) */
  holdId: string;
  /** 멱등 키(소문자 UUID v4, 플랫폼 @IdempotencyRequest의 key) */
  idempotencyKey: string;
  /** 요청 지문(holdFingerprint, SHA-256 소문자 hex 64자) */
  fingerprint: string;
  /** 잡을 좌석(위 정렬·겹침 규칙) */
  seats: readonly SeatRef[];
  /** 1인 한도(회차 설정, 예 2매, 최대 4매) */
  limit: number;
  /** 회차 키의 만료 시각(epoch ms) = 판매 종료 + KEEP_AFTER_SALE_END_MS. 키 수명이 이보다 짧거나 없을 때만 이 시각으로 건다 */
  keepUntilMs: number;
}

/** 잡은 홀드(처음 응답). OK와 IDEM_REPLAY가 같은 모양이다 */
export interface HeldHold {
  holdId: string;
  /**
   * 펜싱 토큰(양의 정수, 지금 시각으로 약 1.7e15 = 16자리, Number.MAX_SAFE_INTEGER 이하). 회차 안에서 엄격히 단조 증가한다.
   * Lua는 string.format('%.0f')의 10진 글로 돌려주고 어댑터가 Number로 바꾼다. 바꾼 값이 안전한 정수(Number.isSafeInteger)가 아니면 어댑터가 Error를 던진다
   */
  fencingToken: number;
  /** 잡은 시각(epoch ms) = floor(Redis TIME µs / 1000). 같은 홀드의 SeatEvent HELD occurredAt·HoldAttempt heldAt과 같다 */
  heldAtMs: number;
  /** 만료 시각(epoch ms) = heldAtMs + HOLD_TTL_MS */
  expiresAtMs: number;
}

/**
 * SeatStore.hold의 결과(홀드 Lua가 돌려주는 값을 그대로 옮긴 것). 검사는 아래 차례로 하고 앞이 걸리면 뒤는 보지 않는다.
 * OK가 아니면 아무것도 쓰지 않았다(전부 되거나 전부 안 된다).
 *
 * 1. NOT_READY: 세대 키 s:{event:E}:epoch의 epoch 칸이 없다(키가 없는 것 포함. 좌석 저장소가 준비되지 않음, 503 seat-store-unavailable)
 * 2. IDEM_REPLAY: 같은 계정·같은 멱등 키의 기록이 있고 지문이 같다. 처음 응답을 그대로 준다(좌석을 다시 보지 않고 쓰지 않는다, 201)
 *    IDEM_REUSED: 기록이 있는데 지문이 다르다(좌석을 보지 않는다, 422 idempotency-key-reused)
 * 3. PAUSED: ctl의 paused(회차 범위 판매 일시정지)·allPaused(전체 범위)·suspended(판매 중지) 가운데 하나라도 '1'(423 sale-paused).
 *    키나 칸이 없으면 정지가 아니다
 * 4. CONFLICT: 요청 좌석 가운데 비트가 1인 좌석이 있다. seatId는 seats 차례로 첫 충돌 좌석(409 seat-already-held)
 * 5. REHOLD_WAIT: 비트는 모두 0인데 rel:{account} 점수가 지금(Redis TIME)보다 큰 좌석이 있다. seatIds는 그런 좌석 모두(seats 차례),
 *    availableAtMs는 그 가운데 가장 늦은 점수(409 seat-recently-released). 경합(4)이 먼저다
 * 6. QUOTA_EXCEEDED: 지금 보유 수(키가 없으면 0) + 좌석 수 > limit(422 purchase-limit-exceeded)
 * 7. OK: 썼다(쓰는 것은 SeatStore.hold의 설명)
 *
 * 5와 6 사이에서 쓰기 전 지킴을 본다(추천 적용 2026-11-04). 걸리면 결과가 아니라 일시 장애가 아닌 Error를 던지고 아무것도 쓰지 않는다:
 * keepUntilMs가 저장소 시각(Lua는 TIME, 메모리는 Clock) 이하, 보유 수·fence 값이 10진 정수 글(^%d+$)이 아님('-1'·'1e3'·' 5'·'0x10'·'1.5' 모두 거절),
 * expiry(zset)·stream(stream)·secver(hash)·hold:{색인}(hash) 키의 형이 틀림(키가 없으면 통과). 오류 글은 keepUntil이 PEAKET_KEEP_UNTIL_PAST, 값·형이 PEAKET_CORRUPT_KEY다.
 * 토큰이 2^53 − 1을 넘는 것(PEAKET_FENCE_OVERFLOW)도 같은 방식이다
 */
export type HoldResult =
  | ({ kind: 'OK' } & HeldHold)
  | { kind: 'NOT_READY' }
  | ({ kind: 'IDEM_REPLAY' } & HeldHold)
  | { kind: 'IDEM_REUSED' }
  | { kind: 'PAUSED' }
  | { kind: 'CONFLICT'; seatId: string }
  | { kind: 'REHOLD_WAIT'; seatIds: string[]; availableAtMs: number }
  | { kind: 'QUOTA_EXCEEDED' };

/** SeatStore.replay의 입력: 멱등 범위(계정 × 키)와 이 요청의 지문(holdFingerprint) */
export interface ReplayInput {
  eventId: string;
  accountId: string;
  idempotencyKey: string;
  fingerprint: string;
}

/**
 * SeatStore.replay의 결과. 같은 계정·같은 키의 살아 있는 기록이 같은 지문이면 처음 응답(IDEM_REPLAY), 다른 지문이면 IDEM_REUSED,
 * 기록이 없거나 수명(7분)이 지났으면 null이다
 */
export type ReplayResult = ({ kind: 'IDEM_REPLAY' } & HeldHold) | { kind: 'IDEM_REUSED' } | null;

/** 좌석 Redis 일시 장애(마감 초과·끊김·클러스터 재구성, platform isRedisUnavailable). 받는 층이 503 seat-store-unavailable + Retry-After로 바꾼다 */
export class SeatStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('좌석 Redis를 잠시 쓸 수 없다', { cause });
    this.name = 'SeatStoreUnavailable';
  }
}

/**
 * 홀드 멱등 지문: 좌석 ID를 오름차순(문자 코드 순, Array.prototype.sort 기본. 좌석 ID는 ASCII라 바이트 순과 같다)으로 정렬해 LF('\n')로 이은
 * UTF-8 바이트의 SHA-256, 소문자 hex 64자. 좌석 선택만으로 만든다. 본문의 다른 칸(behavior·clientEphemeralPublicKey)과 회차는 넣지 않는다
 * (seat-hold.md §3 '멱등키'의 '지문', guidelines §4의 예외).
 * - 같은 좌석 집합이면 보낸 차례와 관계없이 같은 값이다(['B','A']와 ['A','B']가 같다).
 * - 입력 배열을 바꾸지 않는다.
 * - 빈 배열은 RangeError(홀드에는 좌석이 1개 이상 있다).
 * @param seatIds 좌석 ID들(SEAT_ID_PATTERN 모양, 겹침 없음)
 */
export function holdFingerprint(seatIds: readonly string[]): string {
  if (seatIds.length === 0) throw new RangeError('홀드 지문을 만들 좌석이 없다');
  return createHash('sha256').update([...seatIds].sort().join('\n'), 'utf8').digest('hex');
}
