// 회차 취소 요청 중 보류 취소의 환급 미룸(BAT-420 몫 D, OPEN[45] 결정, docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸',
// refund.proto SetEventRefundHold, docs/data.md event_refund_hold). 빈 뼈대: 규칙 함수는 아직 없다.

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

/** 소문자 UUID, 걸 때 expiresAtMs > nowMs 이고 ≤ nowMs + 7일. @throws EventRefundHoldError('INVALID') (빈 뼈대) */
export function parseEventRefundHold(_i: EventRefundHoldInput): EventRefundHoldInput {
  throw new Error('아직 없음');
}
