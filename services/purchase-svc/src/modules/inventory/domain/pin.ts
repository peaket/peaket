// 판매 예약 앞의 좌석 묶기(pin)·결제 실패 해제(releaseFailed)·회차 목록 빼기(retireEvent)의 값과 형(BUILD_ORDER PRF-142,
// docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현', 명세 specs/seat.qnt의 pin·releaseFailed, OPEN[15] 소유자 결정 2026-11-02).
import { KEY_PART, MAX_SEATS, SEAT_ID_PATTERN, type SeatRef } from './hold.js';
import { UUID_PATTERN } from './purchase-session.js';

/** 회차를 회차 목록 s:ctl:events에서 뺄 수 있는 때 = 판매 종료 + 1시간 [가정](최대 체류 45분 + 승인 기한 연장 10분보다 길게) */
export const RETIRE_AFTER_SALE_END_MS = 60 * 60_000;
/** 세대 키에 gen 칸이 없을 때 보는 판 번호(판매 열기가 처음 쓰는 값) */
export const INITIAL_SEAT_GEN = 1;

export interface PinInput {
  eventId: string;
  /** 주문한 계정(홀드 Hash의 owner와 같아야 내 홀드다) */
  accountId: string;
  /** 주문의 구매 세션 ID(빈 좌석을 다시 잡을 때 홀드 Hash psid에 쓴다) */
  purchaseSessionId: string;
  /** 주문의 holdId(홀드 Hash의 holdId와 같아야 내 홀드다. 다시 잡을 때도 이 값을 쓴다) */
  holdId: string;
  /** 주문의 좌석(홀드와 같은 정렬·겹침 규칙: 좌석 ID 오름차순, 1~10석) */
  seats: readonly SeatRef[];
  /** 1인 한도(빈 좌석을 다시 잡을 때 보유 수 + 빈 좌석 수 ≤ 한도) */
  limit: number;
  /** 결제 접수 때 주문에 적은 다시 만들기 판 번호(1 이상의 정수). 빈 좌석은 세대 키의 gen과 같을 때만 다시 잡는다 */
  orderGen: number;
  /** 회차 키의 만료 시각(epoch ms) = 판매 종료 + 1일(홀드와 같다) */
  keepUntilMs: number;
}

/**
 * 묶기 결과. OK가 아니면 아무것도 쓰지 않았다(Saga는 승인하지 않고 끝내 과금이 없다).
 * - OK: gen은 지금 판 번호, regrabbed는 다시 잡은 빈 좌석 수(0이면 모두 내 홀드였다), fencingToken은 다시 잡았을 때의 새 토큰
 * - TAKEN: 남이 잡은 첫 좌석(좌석 차례)의 색인
 * - STALE_GEN: 빈 좌석이 있는데 orderGen이 지금 판 번호(gen)와 다르다
 */
export type PinResult =
  | { kind: 'OK'; gen: number; regrabbed: number; fencingToken?: number }
  | { kind: 'NOT_READY' }
  | { kind: 'TAKEN'; seatIndex: number }
  | { kind: 'STALE_GEN'; gen: number }
  | { kind: 'QUOTA_EXCEEDED' };

export interface ReleaseFailedInput {
  eventId: string;
  accountId: string;
  /** 실패한 주문의 holdId. 홀드 Hash의 holdId·owner가 같은 좌석만 푼다 */
  holdId: string;
  seats: readonly SeatRef[];
  keepUntilMs: number;
}

/** 실패 해제 결과. released는 푼 좌석 수(남의 좌석·이미 풀린 좌석은 세지 않는다) */
export type ReleaseFailedResult = { kind: 'OK'; released: number } | { kind: 'NOT_READY' };

/**
 * 회차 목록에서 빼기 결과.
 * - RETIRED: 뺐다 · TOO_EARLY: 판매 종료 + RETIRE_AFTER_SALE_END_MS 전 · STREAM_PENDING: Stream 길이나 확인받지 못한 항목이 0이 아님
 * - EXPIRY_PENDING: 만료 인덱스에 홀드가 남음(만료가 멈췄던 회차) · NOT_LISTED: 목록에 없었다
 * 뺀 뒤 Stream 길이·만료 인덱스를 다시 보고 0이 아니면 목록에 되돌린다(두 슬롯 사이에 항목이 들어온 경주, PRF-142 코드 리뷰)
 */
export type RetireResult = 'RETIRED' | 'TOO_EARLY' | 'STREAM_PENDING' | 'EXPIRY_PENDING' | 'NOT_LISTED';

const isKeyPart = (v: unknown): v is string => typeof v === 'string' && KEY_PART.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_PATTERN.test(v);
/** 0 이상의 안전한 정수 */
const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * 좌석 입력 모양(pin·releaseFailed 공통, 홀드와 같은 규칙): 1~MAX_SEATS개, 좌석 ID는 SEAT_ID_PATTERN(키 조각)이고 오름차순(문자 코드 순, 겹치면 오름차순이 아니다),
 * 색인·구역 색인·구역 안 거리는 0 이상의 안전한 정수이고 색인이 겹치지 않는다. 구역 ID·등급 ID는 글이다(Stream 칸에 그대로 싣는다)
 */
function assertSeats(seats: readonly SeatRef[]): void {
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS) throw new RangeError(`좌석 수는 1 ~ ${MAX_SEATS}다: ${Array.isArray(seats) ? seats.length : String(seats)}`);
  const indexes = new Set<number>();
  let prev: string | undefined;
  for (const s of seats) {
    if (typeof s?.seatId !== 'string' || !SEAT_ID_PATTERN.test(s.seatId)) throw new RangeError('좌석 ID가 키 조각 모양이 아니다');
    if (prev !== undefined && !(prev < s.seatId)) throw new RangeError('좌석 ID가 오름차순이 아니거나 겹친다');
    prev = s.seatId;
    if (!isIndex(s.index) || !isIndex(s.sectionIndex) || !isIndex(s.seatOffset)) throw new RangeError('좌석 색인·구역 색인·구역 안 거리는 0 이상의 안전한 정수다');
    if (indexes.has(s.index)) throw new RangeError(`좌석 색인이 겹친다: ${s.index}`);
    indexes.add(s.index);
    // 빈 글이면 릴레이가 그 HELD를 좌석맵 판에 없는 좌석으로 넘겨 원장에서 빠진다(PRF-142 코드 리뷰)
    if (typeof s.sectionId !== 'string' || typeof s.tierId !== 'string' || s.sectionId.length === 0 || s.tierId.length === 0) throw new RangeError('구역 ID·등급 ID가 빈 글이 아닌 글이 아니다');
  }
}

/** 회차 키 만료 시각: 양의 안전한 정수(epoch ms) */
function assertKeepUntil(v: number): void {
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`keepUntilMs는 양의 안전한 정수(epoch ms)다: ${v}`);
}

/** 묶기 입력 모양 검사(키 조각·UUID·좌석 정렬·한도·판 번호·시각). 틀리면 RangeError */
export function assertPinInput(i: PinInput): void {
  if (!isKeyPart(i.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!isKeyPart(i.accountId)) throw new RangeError('accountId가 키 조각 모양이 아니다');
  if (!isUuid(i.holdId)) throw new RangeError('holdId가 UUID가 아니다');
  if (!isUuid(i.purchaseSessionId)) throw new RangeError('purchaseSessionId가 UUID가 아니다');
  assertSeats(i.seats);
  if (!Number.isSafeInteger(i.limit) || i.limit < 1) throw new RangeError(`1인 한도는 1 이상의 정수다: ${i.limit}`);
  if (!Number.isSafeInteger(i.orderGen) || i.orderGen < 1) throw new RangeError(`orderGen은 1 이상의 정수다: ${i.orderGen}`);
  assertKeepUntil(i.keepUntilMs);
}

/** 실패 해제 입력 모양 검사. 틀리면 RangeError */
export function assertReleaseFailedInput(i: ReleaseFailedInput): void {
  if (!isKeyPart(i.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!isKeyPart(i.accountId)) throw new RangeError('accountId가 키 조각 모양이 아니다');
  if (!isUuid(i.holdId)) throw new RangeError('holdId가 UUID가 아니다');
  assertSeats(i.seats);
  assertKeepUntil(i.keepUntilMs);
}

/** 회차 목록에서 빼기 입력 모양 검사(두 구현이 같이 쓴다). 회차는 키 조각, 판매 종료 시각은 안전한 정수(epoch ms). 틀리면 RangeError */
export function assertRetireInput(i: { eventId: string; saleEndMs: number }): void {
  if (!isKeyPart(i.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
  if (!Number.isSafeInteger(i.saleEndMs)) throw new RangeError(`saleEndMs는 안전한 정수(epoch ms)다: ${i.saleEndMs}`);
}
