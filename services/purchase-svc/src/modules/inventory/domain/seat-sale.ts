// 판매 확정(Hard Sale) 저장소의 값과 입력 검사(docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현', docs/data.md §2 seat_sale·purchase_quota, BUILD_ORDER PRF-140 ①).
// 좌석 ID는 표의 uuid 글(소문자 UUID)이다. 좌석 Redis의 홀드 경로가 받는 키 조각 모양(SEAT_ID_PATTERN)보다 좁다(결정은 seat-hold.md §6 '좌석 ID 글').
import { MAX_SEATS } from './hold.js';

/** seat_sale.status(CHECK 제약과 같다) */
export const SEAT_SALE_STATUSES = ['PENDING', 'SOLD', 'RETURNED'] as const;
export type SeatSaleStatus = (typeof SEAT_SALE_STATUSES)[number];

/** 주문 하나의 좌석 수 상한. 홀드 요청의 상한과 같다(openapi HoldRequest.seatIds maxItems) */
export const MAX_SALE_SEATS = MAX_SEATS;
/** 소문자 UUID(표 uuid 칸을 풀어 쓴 글). 대문자·중괄호·하이픈 없는 글은 같은 좌석을 다르게 적어 중복 검사를 피할 수 있어 받지 않는다 */
export const SALE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 어떤 주문의 어떤 좌석들인지. 기본 키 (event_id, seat_id, order_id)로 바로 찾는다(주문 ID만으로 찾는 인덱스를 두지 않는다) */
export interface SeatSaleOrder {
  eventId: string;
  orderId: string;
  /** 주문 항목의 좌석 ID들(소문자 UUID, 1~MAX_SALE_SEATS개, 겹치면 안 된다) */
  seatIds: readonly string[];
}

/** 예약 입력. 한도·계정은 한도 행(purchase_quota)에 쓴다 */
export interface ReserveInput extends SeatSaleOrder {
  accountId: string;
  /** 그 회차의 1인 한도(POL-011, 양의 정수). 호출한 쪽이 회차 설정에서 읽어 넘기고, 행의 limit_count를 이 값으로 맞춘다 */
  limit: number;
  /** 가상계좌 PENDING의 기한(유닉스 밀리초, 입금 기한 + 10분 [가정], ADR-0086). 없으면 비운다 */
  pendingUntilMs?: number;
}

/** 해제·반품 입력. 한도 행을 되돌리려고 계정이 필요하다(seat_sale에는 계정 칸이 없다) */
export interface SeatSaleRelease extends SeatSaleOrder {
  accountId: string;
}

/**
 * 예약 결과. RESERVED면 한도와 좌석이 모두 반영된 것이고, 나머지는 아무것도 남기지 않았다.
 * SEAT_TAKEN의 seatIds는 이미 활성 판매 행(PENDING·SOLD)이 있는 좌석들이다(입력 순서)
 */
export type ReserveResult = { status: 'RESERVED' } | { status: 'QUOTA_EXCEEDED' } | { status: 'SEAT_TAKEN'; seatIds: string[] };

const isUuid = (v: unknown): v is string => typeof v === 'string' && SALE_UUID_PATTERN.test(v);

function assertUuid(name: string, v: unknown): void {
  if (!isUuid(v)) throw new RangeError(`${name}가 소문자 UUID가 아니다`);
}

/** 좌석 ID들을 검사하고 문자 코드 순으로 정렬해 돌려준다(겹치는 좌석을 가진 두 주문이 같은 차례로 넣어 서로를 기다리지 않게, S-T10) */
export function sortedSeatIds(seatIds: readonly string[]): string[] {
  if (!Array.isArray(seatIds)) throw new RangeError('seatIds가 배열이 아니다');
  if (seatIds.length < 1 || seatIds.length > MAX_SALE_SEATS) throw new RangeError(`seatIds는 1~${MAX_SALE_SEATS}개여야 한다: ${seatIds.length}개`);
  for (const id of seatIds) if (!isUuid(id)) throw new RangeError('seatIds에 소문자 UUID가 아닌 좌석 ID가 있다');
  // 기본 정렬은 UTF-16 코드 단위 순서다(localeCompare가 아니다). 소문자 UUID는 모두 같은 길이라 PostgreSQL uuid의 바이트 순서와도 같다
  const sorted = [...seatIds].sort();
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i] === sorted[i - 1]) throw new RangeError('seatIds에 같은 좌석이 두 번 있다');
  return sorted;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** 주문 입력 모양 검사 */
export function assertSeatSaleOrder(o: SeatSaleOrder): void {
  if (!isObject(o)) throw new RangeError('입력이 객체가 아니다');
  assertUuid('eventId', o.eventId);
  assertUuid('orderId', o.orderId);
  sortedSeatIds(o.seatIds);
}

/** 예약 입력 모양 검사. 좌석 수가 한도보다 많은 것은 모양 오류가 아니라 QUOTA_EXCEEDED 결과다 */
export function assertReserveInput(i: ReserveInput): void {
  assertSeatSaleOrder(i);
  assertUuid('accountId', i.accountId);
  if (!Number.isSafeInteger(i.limit) || i.limit < 1) throw new RangeError(`limit이 1 이상의 안전한 정수가 아니다: ${String(i.limit)}`);
  if (i.pendingUntilMs !== undefined && (!Number.isSafeInteger(i.pendingUntilMs) || i.pendingUntilMs <= 0)) {
    throw new RangeError(`pendingUntilMs가 양의 안전한 정수(유닉스 밀리초)가 아니다: ${String(i.pendingUntilMs)}`);
  }
}

/** 해제·반품 입력 모양 검사 */
export function assertSeatSaleRelease(i: SeatSaleRelease): void {
  assertSeatSaleOrder(i);
  assertUuid('accountId', i.accountId);
}
