// 홀드 다시 읽기·해제·연장·주문 표시와 결제 정지 멈춤의 값과 포트(docs/features/seat-hold.md §5, docs/data.md §3, ADR-0254, BUILD_ORDER HOT-070).
import type { SeatRef } from './hold.js';
import type { EventSeatConfig, SeatCallOptions } from './ports.js';

/** 1회 연장 3분(POL-012) */
export const HOLD_EXTENSION_MS = 3 * 60_000;
/** 옮기기·되돌리기 Lua 한 번의 좌석 수 200 [가정](ADR-0086 결정 9) */
export const FREEZE_BATCH_SIZE = 200;
/** 한 틱에 옮기기·되돌리기를 부르는 묶음 수의 상한 20 [가정] */
export const FREEZE_MAX_BATCHES_PER_TICK = 20;
/** 정지 조회의 데드라인 500ms [가정](guidelines §5) */
export const PAUSE_READ_DEADLINE_MS = 500;
/** 답을 받지 못했을 때 마지막 답을 쓰는 시간 10초 [가정](ADR-0085) */
export const PAUSE_ANSWER_STALE_MS = 10_000;
/** 열림이 연속 두 번이어도 첫 열림부터 이만큼 지나야 되돌린다 1초 [가정](틱이 바로 이어질 때 ms 사이에 끝나지 않게) */
export const PAUSE_OPEN_MIN_MS = 1_000;
/** 한 틱에서 만료 인덱스를 건너뛰어 읽는 수의 상한 2,000 [가정](ADR-0254 결정 6) */
export const EXPIRY_MAX_OFFSET_PER_TICK = 2_000;

/** 해제의 까닭(지표 seat_hold_released_total{reason}) */
export type HoldReleaseReason = 'user' | 'left' | 'idle' | 'max_stay' | 'restricted';

/** 어느 홀드를 다루는가 */
export interface HoldTarget {
  eventId: string;
  holdId: string;
  accountId: string;
  purchaseSessionId: string;
  /** 구매 세션의 h:{holdId}에 적힌 좌석을 좌석맵 판으로 바꾼 것(1개 이상) */
  seats: readonly SeatRef[];
}

/** frozen: 결제 정지로 멈췄거나 결제 접수 뒤 묶여 시간이 흐르지 않는다(화면이 타이머로 만료 처리하지 않는다) */
export type HoldReadResult = { kind: 'OK'; expiresAtMs: number; extended: boolean; fencingToken: number; frozen: boolean } | { kind: 'NOT_FOUND' } | { kind: 'NOT_READY' };
export type HoldReleaseResult = { kind: 'OK'; released: number } | { kind: 'NOT_FOUND' } | { kind: 'PINNED' } | { kind: 'NOT_READY' };
export type HoldExtendResult = { kind: 'OK'; expiresAtMs: number; fencingToken: number } | { kind: 'NOT_FOUND' } | { kind: 'ALREADY' } | { kind: 'PINNED' } | { kind: 'NOT_READY' };
export type HoldMarkResult = { kind: 'OK'; added: number } | { kind: 'NOT_FOUND' } | { kind: 'NOT_READY' };
/** 옮기기·되돌리기 한 묶음의 결과 */
export type HoldFreezeResult = { kind: 'OK'; moved: number; dropped: number; corrupt: number } | { kind: 'NOT_READY' };

/** 응답의 좌석 표시 값(openapi Hold.seats·totalAmount). 가격이 없는 등급이 있으면 undefined(두 칸을 뺀다) */
export function holdSeatsView(refs: readonly SeatRef[], config: EventSeatConfig): { seats: { seatId: string; label: string; tierId: string; tierName?: string; price: number }[]; totalAmount: number } | undefined {
  const seats = [];
  let totalAmount = 0;
  for (const r of refs) {
    const price = config.tierPrices?.[r.tierId];
    if (price === undefined) return undefined;
    totalAmount += price;
    const tierName = config.tierNames?.[r.tierId];
    seats.push({ seatId: r.seatId, label: r.label ?? r.seatId, tierId: r.tierId, ...(tierName !== undefined ? { tierName } : {}), price });
  }
  return { seats, totalAmount };
}

/** 정렬 집합의 한 쪽을 읽은 결과. malformed는 정수가 아니어서 지운 멤버 수 */
export interface HoldMemberPage {
  indexes: number[];
  malformed: number;
}

/**
 * 좌석 Redis의 홀드 수명 연산(운영 RedisHoldLifecycle, Lua 계약은 adapters/hold-lifecycle-lua.ts).
 * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
 * @throws Error 키 형이 틀림(PEAKET_CORRUPT_KEY)·스크립트가 모르는 값을 돌려줌
 */
export interface HoldLifecycle {
  read(t: HoldTarget, o?: SeatCallOptions): Promise<HoldReadResult>;
  release(t: HoldTarget, keepUntilMs: number, o?: SeatCallOptions): Promise<HoldReleaseResult>;
  extend(t: HoldTarget, o?: SeatCallOptions): Promise<HoldExtendResult>;
  markOrdered(t: HoldTarget, maxStayMs: number, keepUntilMs: number, o?: SeatCallOptions): Promise<HoldMarkResult>;
  /** ordered를 앞에서 limit개 읽는다(건너뛰기 없음, 옮기면 빠진다) */
  orderedPage(eventId: string, limit: number): Promise<HoldMemberPage>;
  /** paused를 읽는다. dueBeforeMs가 있으면 점수가 그 이하인 것만(최대 체류 회수) */
  frozenPage(eventId: string, limit: number, dueBeforeMs?: number): Promise<HoldMemberPage>;
  frozenCount(eventId: string): Promise<number>;
  freeze(eventId: string, pausedSinceMs: number, keepUntilMs: number, indexes: readonly number[]): Promise<HoldFreezeResult>;
  thaw(eventId: string, keepUntilMs: number, indexes: readonly number[]): Promise<HoldFreezeResult>;
}

/** 새 결제 일시 정지 조회(booking NewPaymentPauses를 main.ts가 잇는다) */
export type PaymentPauseAnswer = { status: 'OK'; pauses: readonly { eventId: string; pausedSinceMs: number }[] } | { status: 'FAILED' };
export interface PaymentPauseSource {
  read(eventIds: readonly string[], o: { deadlineMs: number }): Promise<PaymentPauseAnswer>;
}

/** 회차 하나의 정지 판단 */
export type EventPauseState =
  /** 정지 중: 옮기고 회수를 건너뛴다 */
  | { kind: 'PAUSED'; sinceMs: number }
  /** 확실히 열림(연속 두 번 열림, 또는 답 없음 10초): 되돌린다 */
  | { kind: 'OPEN' }
  /** 판단을 미룬다(한 번만 열림을 봤거나 아직 답을 받은 적이 없다): 옮기지도 되돌리지도 않는다 */
  | { kind: 'UNSETTLED' };
