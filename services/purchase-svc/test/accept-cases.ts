// 결제 접수 POST /v1/orders/{orderId}/payment-acceptance(BUILD_ORDER PRF-162, docs/features/payment.md §2 '결제 접수의 첫 구현') 단위 시험의 공용 재료.
// booking 결제 접수 포트의 메모리 가짜(부른 차례와 인자를 적는다)와 정상 요청 하나. accept-payment.test.ts(쓰임새)와 accept-http.test.ts(받는 층)가 함께 쓰고,
// 주문 생성 시험(orders-http.test.ts·order-adapters.test.ts)은 BookingModuleDeps의 accepts·slots를 채우는 데 쓴다.
// 가짜는 값을 정해 두면 그대로 답하고, Error를 넣어 두면 그것을 던진다. reset()이 모두 처음 값으로 되돌린다.
import type {
  AcceptInput,
  AcceptLog,
  AcceptOrderView,
  AcceptOutcome,
  AcceptPaymentCommand,
  ActiveAttemptView,
  CommittedAcceptLookup,
  OrderAcceptReads,
  OrderAcceptWrites,
  OrderRequestOnce,
  OrderSessions,
  OrderSessionView,
  PaymentAcceptBody,
  SeatSlotRead,
  SeatSlotReads,
  TransactionCallOptions,
} from '../src/modules/booking/index.js';
import { ACCOUNT, AMOUNT, EVENT, IDEM_KEY, JOURNEY, NOW, PSID } from './order-cases.js';

/** 접수할 주문(소문자 UUID) */
export const ORDER_ID = '0190f3a1-7c2e-7f00-8000-0000000000f2';
/** 그 주문의 활성 결제 시도 */
export const ATTEMPT_ID = '0190f3a1-7c2e-7f00-8000-0000000000a7';
/** 다른 계정(남의 주문 시험용) */
export const OTHER_ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a2';
/** 같은 계정의 다른 구매 세션(다른 탭) */
export const OTHER_PSID = '0190f3a1-7c2e-7b00-8000-0000000000b2';
/** 토스·시뮬레이터 성공 URL의 paymentKey(로그·응답에 나가면 안 되는 값이라 눈에 띄는 글을 넣었다) */
export const PAYMENT_KEY = 'tgen_PAYKEYSECRET_20261105';
/** 포트원 paymentId(= 시도의 pg_order_ref, pay-{orderId}) */
export const PORTONE_PAYMENT_ID = `pay-${ORDER_ID}`;
/** 포트원 결제 토큰(수동 승인용. 로그·응답에 나가면 안 된다) */
export const PAYMENT_TOKEN = 'PAYTOKENSECRET-portone-0001';
/** 포트원 txId(로그·응답에 나가면 안 된다) */
export const TX_ID = 'TXIDSECRET-portone-0001';
/** 회차 슬롯 읽기의 다시 만들기 판 번호 */
export const SEAT_GEN = 3;
/** 40분(결제 시도를 받는 시간) */
export const MIN = 60_000;

/** 토스 본문(정상: 주문 금액과 같다) */
export function tossBody(over: Partial<{ pg: 'TOSS' | 'SIMULATOR'; paymentKey: string; amount: number }> = {}): PaymentAcceptBody {
  return { pg: 'TOSS', paymentKey: PAYMENT_KEY, amount: AMOUNT, ...over };
}

/** 포트원 본문(정상: paymentId = 시도의 pg_order_ref) */
export function portoneBody(over: Partial<{ paymentId: string; paymentToken: string; txId: string }> = {}): PaymentAcceptBody {
  return { pg: 'PORTONE', paymentId: PORTONE_PAYMENT_ID, paymentToken: PAYMENT_TOKEN, txId: TX_ID, ...over };
}

/** 정상 멱등 요청 값(범위 계정 × ACCEPT_PAYMENT) */
export function acceptIdem(over: Partial<OrderRequestOnce> = {}): OrderRequestOnce {
  return { accountRef: ACCOUNT, operation: 'ACCEPT_PAYMENT', key: IDEM_KEY, requestHash: new Uint8Array(32).fill(5), ...over };
}

/** 정상 쓰임새 입력(토스) */
export function acceptCommand(over: Partial<AcceptPaymentCommand> = {}): AcceptPaymentCommand {
  return { accountId: ACCOUNT, purchaseSessionId: PSID, orderId: ORDER_ID, idem: acceptIdem(), body: tossBody(), ...over };
}

/** 정상 주문(CREATED, 이 계정·이 구매 세션) */
export function okOrder(over: Partial<AcceptOrderView> = {}): AcceptOrderView {
  return { orderId: ORDER_ID, accountId: ACCOUNT, eventId: EVENT, purchaseSessionId: PSID, status: 'CREATED', amount: AMOUNT, ...over };
}

/** 정상 결제 시도(READY, 5분 전에 만듦). pg를 주면 그 결제사, 포트원이면 pgOrderRef = pay-{orderId} */
export function okAttempt(over: Partial<ActiveAttemptView> = {}): ActiveAttemptView {
  const pg = over.pg ?? 'TOSS';
  return { attemptId: ATTEMPT_ID, pg, status: 'READY', pgOrderRef: pg === 'PORTONE' ? PORTONE_PAYMENT_ID : ORDER_ID, createdAtMs: NOW - 5 * MIN, ...over };
}

/** 부른 포트 이름(차례 비교용) */
export type AcceptCall = 'sessions.get' | 'reads.findCommitted' | 'reads.order' | 'reads.activeAttempt' | 'slots.read' | 'writes.accept' | 'log.attemptMismatch';

const defaults = () => ({
  session: { sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY } as OrderSessionView | undefined | Error,
  committed: { status: 'NONE' } as CommittedAcceptLookup | Error,
  order: okOrder() as AcceptOrderView | undefined | Error,
  attempt: okAttempt() as ActiveAttemptView | undefined | Error,
  slot: { status: 'OK', gen: SEAT_GEN } as SeatSlotRead | Error,
  outcome: { status: 'ACCEPTED' } as AcceptOutcome | Error,
});

/**
 * 결제 접수 포트(구매 세션·DB 읽기·DB 쓰기·회차 슬롯·보안 로그)의 메모리 가짜. calls에 부른 차례를 적고, 각 포트의 인자를 따로 적는다.
 * sessions.markPaying은 결제 접수가 쓰지 않는다(부르면 calls에 'sessions.markPaying'이 아니라 던진다)
 */
export class AcceptFakes {
  calls: AcceptCall[] = [];
  session = defaults().session;
  committed = defaults().committed;
  order = defaults().order;
  attempt = defaults().attempt;
  slot = defaults().slot;
  outcome = defaults().outcome;

  sessionGets: string[] = [];
  committedQueries: OrderRequestOnce[] = [];
  orderReads: string[] = [];
  attemptReads: string[] = [];
  slotReads: { eventId: string; o: { deadlineMs?: number } | undefined }[] = [];
  accepted: { once: OrderRequestOnce; input: AcceptInput }[] = [];
  /** writes.accept에 넘긴 트랜잭션 선택값(부른 차례, 리뷰 고침 L4) */
  acceptOptions: (TransactionCallOptions | undefined)[] = [];
  mismatchLogs: Parameters<AcceptLog['attemptMismatch']>[0][] = [];

  /** 답과 기록을 모두 처음으로 */
  reset(): void {
    Object.assign(this, defaults());
    this.calls = [];
    this.sessionGets = [];
    this.committedQueries = [];
    this.orderReads = [];
    this.attemptReads = [];
    this.slotReads = [];
    this.accepted = [];
    this.acceptOptions = [];
    this.mismatchLogs = [];
  }

  readonly sessions: OrderSessions = {
    get: async (sessionId) => {
      this.calls.push('sessions.get');
      this.sessionGets.push(sessionId);
      if (this.session instanceof Error) throw this.session;
      return this.session;
    },
    markPaying: async () => {
      throw new Error('결제 접수는 Paying 표시를 부르지 않는다');
    },
  };

  /** 운영의 DrizzleOrderAccepts처럼 읽기·쓰기를 한 객체가 구현한다 */
  readonly accepts: OrderAcceptReads & OrderAcceptWrites = {
    findCommitted: async (once) => {
      this.calls.push('reads.findCommitted');
      this.committedQueries.push(once);
      if (this.committed instanceof Error) throw this.committed;
      return this.committed;
    },
    order: async (orderId) => {
      this.calls.push('reads.order');
      this.orderReads.push(orderId);
      if (this.order instanceof Error) throw this.order;
      return this.order;
    },
    activeAttempt: async (orderId) => {
      this.calls.push('reads.activeAttempt');
      this.attemptReads.push(orderId);
      if (this.attempt instanceof Error) throw this.attempt;
      return this.attempt;
    },
    accept: async (once, input, o) => {
      this.calls.push('writes.accept');
      this.accepted.push({ once, input });
      this.acceptOptions.push(o);
      if (this.outcome instanceof Error) throw this.outcome;
      return this.outcome;
    },
  };

  readonly slots: SeatSlotReads = {
    read: async (eventId, o) => {
      this.calls.push('slots.read');
      this.slotReads.push({ eventId, o });
      if (this.slot instanceof Error) throw this.slot;
      return this.slot;
    },
  };

  readonly log: AcceptLog = {
    attemptMismatch: (e) => {
      this.calls.push('log.attemptMismatch');
      this.mismatchLogs.push(e);
    },
  };

  /** BookingModuleDeps에 펼치는 결제 접수 칸(accepts·slots·acceptLog). sessions는 주문 생성과 같이 쓰므로 넣지 않는다 */
  bookingPorts() {
    return { accepts: this.accepts, slots: this.slots, acceptLog: this.log };
  }

  /** 마지막 accept 입력 */
  lastInput(): AcceptInput {
    const a = this.accepted.at(-1);
    if (!a) throw new Error('writes.accept를 부르지 않았다');
    return a.input;
  }
}
