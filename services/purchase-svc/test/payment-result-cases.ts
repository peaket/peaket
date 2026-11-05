// 결제 결과 반영(BUILD_ORDER PRF-163, docs/features/payment.md §2 '결제 결과 반영의 첫 구현', §3 T9~T17) 단위 시험의 공용 재료.
// 결제 사건 하나(도메인 모양과 trade.payments JSON 대역 모양), 반영이 보는 주문 하나, 반영 쓰임새 포트의 메모리 가짜(부른 차례와 인자를 적는다).
// payment-result-domain.test.ts(결정), apply-payment-result.test.ts(쓰임새), payment-result-handler.test.ts(키 단위 처리기)가 함께 쓴다.
// 가짜는 값을 정해 두면 그대로 답하고, Error를 넣어 두면 그것을 던진다. reset()이 모두 처음 값으로 되돌린다.
import type {
  PaymentApproveInput,
  PaymentFailInput,
  PaymentMarkInput,
  PaymentResultEvent,
  PaymentResultLog,
  PaymentResultOrder,
  PaymentResultReads,
  PaymentResultSessions,
  PaymentResultWriteOutcome,
  PaymentResultWrites,
  SagaWake,
} from '../src/modules/booking/index.js';
import { ORDER_ID } from './accept-cases.js';
import { ACCOUNT, AMOUNT, EVENT, NOW, PSID } from './order-cases.js';

export { ORDER_ID };
/** 같은 회차의 다른 주문(키 단위 처리 시험용) */
export const OTHER_ORDER_ID = '0190f3a1-7c2e-7f00-8000-0000000000f3';
/** 주문 항목의 좌석 ID(줄 번호 차례) */
export const SEAT_IDS: readonly string[] = Object.freeze(['0190f3a1-7c2e-7f00-8000-00000000a101', '0190f3a1-7c2e-7f00-8000-00000000a102']);
/** 사건의 승인 시각(시계 NOW보다 5초 뒤. 발권 기한은 이 값에 묶인다) */
export const OCCURRED_AT = '2026-11-05T03:00:05.000Z';
export const OCCURRED_AT_MS = Date.parse(OCCURRED_AT);
/** 반영 시각(당기기로 늦게 반영하는 흉내: 사건보다 10분 뒤) */
export const APPLY_NOW = NOW + 10 * 60_000;
/** 사건의 중복 제거 키(UUID v7 모양) */
export const EVENT_KEY = '0190f3a1-7c2e-7f00-8000-0000000000e7';
/** 주문이 반영한 마지막 결제 사건 순번 */
export const ORDER_PAYMENT_SEQ = 2;
/** 이번 사건 순번(주문의 것 + 1) */
export const EVENT_SEQ = 3;
/** 조사용 가명 칸(purchase가 버려야 하는 값이라 눈에 띄는 글을 넣었다) */
export const PAYMENT_METHOD_REF = 'k1.PAYREFSECRET-0001';
export const CARD_BIN = '987654';

/** 정상 결제 사건(토스 승인, 주문 금액과 같다, 순번 3) */
export function paymentEvent(over: Partial<PaymentResultEvent> = {}): PaymentResultEvent {
  return {
    eventId: EVENT,
    orderId: ORDER_ID,
    pg: 'TOSS',
    type: 'APPROVED',
    amount: AMOUNT,
    payMethodCategory: 'CARD',
    refMissing: false,
    result: 'APPROVED',
    attemptNo: 1,
    latencyMs: 180,
    occurredAt: OCCURRED_AT,
    eventSeq: EVENT_SEQ,
    eventKey: EVENT_KEY,
    ...over,
  };
}

/** 정상 주문(RESERVED, 순번 2, 토스로 접수함) */
export function resultOrder(over: Partial<PaymentResultOrder> = {}): PaymentResultOrder {
  return {
    orderId: ORDER_ID,
    status: 'RESERVED',
    amount: AMOUNT,
    paymentEventSeq: ORDER_PAYMENT_SEQ,
    acceptedPg: 'TOSS',
    eventId: EVENT,
    accountId: ACCOUNT,
    purchaseSessionId: PSID,
    seatIds: SEAT_IDS,
    ...over,
  };
}

/** trade.payments 값(asyncapi PaymentEvent 모양, JSON 대역). 도메인 사건에 조사용 가명 칸 둘을 더한다 */
export function wireEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...paymentEvent(), paymentMethodRef: PAYMENT_METHOD_REF, cardBin: CARD_BIN, ...over };
}

/** 부른 포트 이름(차례 비교용) */
export type ResultCall =
  | 'reads.read'
  | 'writes.approve'
  | 'writes.fail'
  | 'writes.mark'
  | 'sessions.complete'
  | 'sessions.unmarkPaying'
  | 'saga.kick'
  | 'log.held'
  | 'log.afterCommitFailed';

const defaults = () => ({
  order: resultOrder() as PaymentResultOrder | undefined | Error,
  /** 차례대로 쓰는 읽기 답(비면 order). STALE 뒤 다시 읽기 시험용 */
  readQueue: [] as (PaymentResultOrder | undefined | Error)[],
  outcome: { status: 'APPLIED' } as PaymentResultWriteOutcome | Error,
  /** 차례대로 쓰는 쓰기 답(비면 outcome) */
  outcomeQueue: [] as (PaymentResultWriteOutcome | Error)[],
  completeAnswer: true as boolean | Error,
  unmarkAnswer: true as boolean | Error,
});

/** 결제 결과 반영 포트(읽기·쓰기·구매 세션·Saga 깨우기·로그)의 메모리 가짜 */
export class ResultFakes {
  calls: ResultCall[] = [];
  order = defaults().order;
  readQueue = defaults().readQueue;
  outcome = defaults().outcome;
  outcomeQueue = defaults().outcomeQueue;
  completeAnswer = defaults().completeAnswer;
  unmarkAnswer = defaults().unmarkAnswer;

  readIds: string[] = [];
  approved: PaymentApproveInput[] = [];
  failed: PaymentFailInput[] = [];
  marked: PaymentMarkInput[] = [];
  completed: string[] = [];
  unmarked: string[] = [];
  kicked: string[] = [];
  heldLogs: Parameters<PaymentResultLog['held']>[0][] = [];
  afterCommitLogs: Parameters<PaymentResultLog['afterCommitFailed']>[0][] = [];

  reset(): void {
    Object.assign(this, defaults());
    this.calls = [];
    this.readIds = [];
    this.approved = [];
    this.failed = [];
    this.marked = [];
    this.completed = [];
    this.unmarked = [];
    this.kicked = [];
    this.heldLogs = [];
    this.afterCommitLogs = [];
  }

  #nextOutcome(): PaymentResultWriteOutcome {
    const o = this.outcomeQueue.length > 0 ? this.outcomeQueue.shift()! : this.outcome;
    if (o instanceof Error) throw o;
    return o;
  }

  readonly reads: PaymentResultReads = {
    read: async (orderId) => {
      this.calls.push('reads.read');
      this.readIds.push(orderId);
      const o = this.readQueue.length > 0 ? this.readQueue.shift() : this.order;
      if (o instanceof Error) throw o;
      return o;
    },
  };

  readonly writes: PaymentResultWrites = {
    approve: async (input) => {
      this.calls.push('writes.approve');
      this.approved.push(input);
      return this.#nextOutcome();
    },
    fail: async (input) => {
      this.calls.push('writes.fail');
      this.failed.push(input);
      return this.#nextOutcome();
    },
    mark: async (input) => {
      this.calls.push('writes.mark');
      this.marked.push(input);
      return this.#nextOutcome();
    },
  };

  readonly sessions: PaymentResultSessions = {
    complete: async (purchaseSessionId) => {
      this.calls.push('sessions.complete');
      this.completed.push(purchaseSessionId);
      if (this.completeAnswer instanceof Error) throw this.completeAnswer;
      return this.completeAnswer;
    },
    unmarkPaying: async (purchaseSessionId) => {
      this.calls.push('sessions.unmarkPaying');
      this.unmarked.push(purchaseSessionId);
      if (this.unmarkAnswer instanceof Error) throw this.unmarkAnswer;
      return this.unmarkAnswer;
    },
  };

  readonly saga: SagaWake = {
    kick: (orderId) => {
      this.calls.push('saga.kick');
      this.kicked.push(orderId);
    },
  };

  readonly log: PaymentResultLog = {
    held: (e) => {
      this.calls.push('log.held');
      this.heldLogs.push(e);
    },
    afterCommitFailed: (e) => {
      this.calls.push('log.afterCommitFailed');
      this.afterCommitLogs.push(e);
    },
  };

  /** 쓰기 세 갈래를 부른 수 */
  writeCount(): number {
    return this.approved.length + this.failed.length + this.marked.length;
  }
}
