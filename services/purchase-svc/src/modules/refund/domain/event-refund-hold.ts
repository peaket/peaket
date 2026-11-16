// 회차 취소 요청 중 보류 취소의 환급 미룸(BAT-420 몫 D, OPEN[45] 결정, docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸',
// refund.proto SetEventRefundHold, docs/data.md event_refund_hold). 회차 취소(CANCEL)가 요청된 회차의 보류 취소는 판정이 끝날 때까지 마감 뒤 환급을 미룬다.
// ops-svc가 요청 전에 걸고(지금 + 72시간), 판정·확정 시도 때 늘리며, 판정 전 반려 때 푼다. 확정은 요청 행과 같은 트랜잭션에서 푼다.

/** 걸기 기한 상한: 지금 + 7일 [가정] */
export const EVENT_REFUND_HOLD_MAX_MS = 604_800_000;

export interface EventRefundHoldInput {
  readonly eventId: string;
  readonly cancellationRequestId: string;
  /** 참이면 걸거나 기한을 늘리고, 거짓이면 푼다 */
  readonly held: boolean;
  /** 걸 때만. 이 시각이 지나면 저절로 풀린다 */
  readonly expiresAtMs?: number;
  readonly nowMs: number;
}

export interface EventRefundHoldState {
  readonly held: boolean;
  readonly expiresAtMs?: number;
}

export class EventRefundHoldError extends Error {
  constructor(
    readonly code: 'INVALID' | 'ALREADY_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'EventRefundHoldError';
  }
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 소문자 UUID, 걸 때 expiresAtMs > nowMs 이고 ≤ nowMs + 7일. 풀 때는 기한을 받지 않는다(넘어와도 버린다). @throws EventRefundHoldError('INVALID') */
export function parseEventRefundHold(i: EventRefundHoldInput): EventRefundHoldInput {
  if (typeof i.eventId !== 'string' || !LOWER_UUID.test(i.eventId)) throw new EventRefundHoldError('INVALID', 'event_id는 소문자 UUID여야 한다');
  if (typeof i.cancellationRequestId !== 'string' || !LOWER_UUID.test(i.cancellationRequestId)) throw new EventRefundHoldError('INVALID', 'cancellation_request_id는 소문자 UUID여야 한다');
  if (typeof i.held !== 'boolean') throw new EventRefundHoldError('INVALID', 'held가 없다');
  if (!Number.isSafeInteger(i.nowMs)) throw new EventRefundHoldError('INVALID', 'nowMs가 올바르지 않다');
  if (!i.held) return { eventId: i.eventId, cancellationRequestId: i.cancellationRequestId, held: false, nowMs: i.nowMs };
  const expiresAtMs = i.expiresAtMs;
  if (expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs)) throw new EventRefundHoldError('INVALID', '걸 때는 expires_at이 필요하다');
  if (expiresAtMs <= i.nowMs || expiresAtMs > i.nowMs + EVENT_REFUND_HOLD_MAX_MS) throw new EventRefundHoldError('INVALID', 'expires_at은 지금보다 늦고 지금 + 7일 안이어야 한다');
  return { eventId: i.eventId, cancellationRequestId: i.cancellationRequestId, held: true, expiresAtMs, nowMs: i.nowMs };
}
