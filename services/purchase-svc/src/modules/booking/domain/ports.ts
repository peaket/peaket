// booking 모듈의 포트(바깥 저장소·지표와 닿는 면, BUILD_ORDER PRF-160).
import type { OrderEventMessage, OrderItem, OrderStatus, OrderRow, CreatedExtras, SeatAssignment, TransitionId } from './order.js';

/** 주문 사건을 Outbox 값 바이트로 바꾼다. Avro 인코더(BAS-030)가 오기 전까지 JSON 대역이다 */
export interface OrderEventCodec {
  encode(message: OrderEventMessage): Uint8Array;
}

/** 새 주문(T1). id는 부르는 쪽이 만든 UUIDv7이다 */
export interface NewOrder {
  readonly id: string;
  readonly accountId: string;
  readonly eventId: string;
  /** 서버가 계산한 금액(원, 0 이상 정수) */
  readonly amount: number;
  readonly buyerName: string;
  readonly buyerPhone: string;
  /** 클라이언트 Idempotency-Key 사본(소문자 UUID v4) */
  readonly idempotencyKey: string;
  /** 두 동의에 보인 고지 문안의 판(1~32자, ^[0-9A-Za-z._-]+$) */
  readonly consentVersion: string;
  readonly seatAssignment: SeatAssignment;
  /** 줄 번호는 이 차례로 1부터 매긴다. 1~10개 [가정: 주문 하나 10석 이하], 좌석 ID는 겹치지 않는다 */
  readonly items: readonly OrderItem[];
  /** 행위자(ACTOR_PATTERN). 주문 생성은 보통 account:<계정 ID> */
  readonly actor: string;
  readonly created: CreatedExtras;
}

export interface TransitionInput {
  readonly orderId: string;
  readonly transition: TransitionId;
  readonly actor: string;
  /** 결제 결과 반영 전이(T9~T17·T21, PAYMENT_RESULT_TRANSITIONS)에만 준다. 양의 정수(payment_event.seq) */
  readonly paymentEventSeq?: number;
}

export type TransitionResult =
  | {
      readonly status: 'APPLIED';
      /** 이번 이력 번호 */
      readonly seq: number;
      /** 전이 뒤의 주문 행 */
      readonly order: OrderRow;
      /** 넣은 Outbox 행 ID(사건이 없는 전이면 undefined) */
      readonly outboxId?: string;
    }
  | {
      /** 전이하지 않았다. NOT_FOUND: 주문 없음, STATUS: 지금 상태가 출발이 아님, PAYMENT_SEQ: 그 순번 이상을 이미 반영함 */
      readonly status: 'STALE';
      readonly reason: 'NOT_FOUND' | 'STATUS' | 'PAYMENT_SEQ';
      readonly current?: OrderStatus;
    };

/** 매일 상태·이력 검사에서 어긋난 주문 하나 */
export interface OrderHistoryMismatch {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly eventSeq: number;
  /** 이력의 마지막 번호 */
  readonly lastSeq: number;
  /** 이력 행 수 */
  readonly rows: number;
  /** 마지막 이력의 도착 상태 */
  readonly lastTo: OrderStatus;
}

export interface OrderHistoryReport {
  /** 본 주문 수 */
  readonly checked: number;
  readonly mismatched: readonly OrderHistoryMismatch[];
}

/** booking 모듈의 지표 */
export interface OrderSignals {
  /** 매일 검사에서 어긋난 주문 수(order_history_mismatch) */
  historyMismatch(count: number): void;
}
