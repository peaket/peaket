// 결제 시도 시작 POST /v1/orders/{orderId}/payments(BUILD_ORDER PRF-191, docs/features/payment.md §2 '결제 시도 시작의 첫 구현') 단위 시험의 공용 재료.
// 포트의 메모리 가짜(부른 차례와 인자를 적는다)와 정상 요청 하나. start-payment.test.ts(쓰임새)와 start-payment-http.test.ts(받는 층)가 함께 쓴다.
// 가짜는 값을 정해 두면 그대로 답하고, Error를 넣어 두면 그것을 던진다. reset()이 모두 처음 값으로 되돌린다.
import type {
  BehaviorSignalMessage,
  BehaviorSummary,
  CheckoutOutcome,
  CheckoutValues,
  CommittedStartLookup,
  OrderHoldExpiries,
  OrderRequestOnce,
  OrderSessions,
  OrderSessionView,
  PaymentCheckouts,
  PrepareCheckoutQuery,
  SaleConfig,
  SeatSlotRead,
  SeatSlotReads,
  StartedAttemptView,
  StartInput,
  StartOrderView,
  StartOutcome,
  StartPaymentCommand,
  StartPaymentLog,
  StartPaymentMetricOutcome,
  StartPaymentReads,
  StartPaymentSignals,
  StartPaymentWrites,
  TransactionCallOptions,
} from '../src/modules/booking/index.js';
import { ATTEMPT_ID, ORDER_ID, PORTONE_PAYMENT_ID, SEAT_GEN } from './accept-cases.js';
import { ACCOUNT, AMOUNT, EVENT, HOLD_ID, IDEM_KEY, JOURNEY, NOW, PID, PSID, TIER_PRICES } from './order-cases.js';

/** 판 파일의 주문명 */
export const ORDER_NAME = '2026 피켓 콘서트 R석';
/** 판 파일의 입장 시작 시각 */
export const ENTRY_OPENS_AT_MS = NOW + 3 * 24 * 3600_000;
/** 홀드 만료 시각 */
export const HOLD_EXPIRES_AT_MS = NOW + 7 * 60_000;
/** 입금 기한 */
export const DEPOSIT_DUE_AT_MS = NOW + 24 * 3600_000;
/** 토스 클라이언트 키(공개 값) */
export const CLIENT_KEY = 'test_ck_public_0001';
/** 구매자 키(로그에 나가면 안 된다) */
export const CUSTOMER_KEY = 'CUSTKEYSECRET_0001';

export const TOSS_CHECKOUT: CheckoutValues = {
  shape: 'TOSS',
  clientKey: CLIENT_KEY,
  customerKey: CUSTOMER_KEY,
  orderId: ORDER_ID,
  orderName: ORDER_NAME,
  amount: AMOUNT,
  successUrl: 'https://peaket.test/booking/e/checkout/return?order=o&pg=TOSS',
  failUrl: 'https://peaket.test/booking/e/checkout/return?order=o&pg=TOSS',
};

export const PORTONE_CHECKOUT: CheckoutValues = {
  shape: 'PORTONE',
  storeId: 'store-1',
  channelKey: 'channel-key-1',
  paymentId: PORTONE_PAYMENT_ID,
  orderName: ORDER_NAME,
  totalAmount: AMOUNT,
  currency: 'KRW',
  redirectUrl: 'https://peaket.test/booking/e/checkout/return?order=o&pg=PORTONE',
  customData: { orderId: ORDER_ID },
};

/** 결제창 준비 성공(토스) */
export function okCheckout(over: Partial<Extract<CheckoutOutcome, { status: 'OK' }>> = {}): CheckoutOutcome {
  return { status: 'OK', pg: 'TOSS', switched: false, checkout: TOSS_CHECKOUT, allowedPayMethods: ['CARD', 'EASY_PAY', 'VIRTUAL_ACCOUNT'], depositDueAtMs: DEPOSIT_DUE_AT_MS, ...over };
}

/** 정상 주문(CREATED, 이 계정·이 구매 세션) */
export function startOrder(over: Partial<StartOrderView> = {}): StartOrderView {
  return { orderId: ORDER_ID, accountId: ACCOUNT, eventId: EVENT, purchaseSessionId: PSID, status: 'CREATED', amount: AMOUNT, holdId: HOLD_ID, seatIds: ['A01', 'A02', 'B01'], ...over };
}

/** 정상 멱등 요청 값(범위 계정 × START_PAYMENT) */
export function startIdem(over: Partial<OrderRequestOnce> = {}): OrderRequestOnce {
  return { accountRef: ACCOUNT, operation: 'START_PAYMENT', key: IDEM_KEY, requestHash: new Uint8Array(32).fill(7), ...over };
}

/** 행동 요약 */
export const BEHAVIOR: BehaviorSummary = { v: 1, windowMs: 12_000, pointerMoves: 40, pointerEntropy: 1.25 };

/** 정상 쓰임새 입력 */
export function startCommand(over: Partial<StartPaymentCommand> = {}): StartPaymentCommand {
  return { accountId: ACCOUNT, pid: PID, purchaseSessionId: PSID, orderId: ORDER_ID, idem: startIdem(), body: {}, ...over };
}

/** 부른 포트 이름(차례 비교용) */
export type StartCall =
  | 'sessions.get'
  | 'reads.findCommitted'
  | 'reads.order'
  | 'reads.attemptCount'
  | 'reads.attempt'
  | 'slots.read'
  | 'saleConfigs.get'
  | 'holdExpiries.expiresAt'
  | 'checkouts.prepare'
  | 'writes.start'
  | 'behavior.publish';

const defaults = () => ({
  session: { sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY } as OrderSessionView | undefined | Error,
  committed: { status: 'NONE' } as CommittedStartLookup | Error,
  order: startOrder() as StartOrderView | undefined | Error,
  count: 0 as number | Error,
  attemptView: { attemptId: ATTEMPT_ID, orderId: ORDER_ID, pg: 'TOSS' } as StartedAttemptView | undefined | Error,
  slot: { status: 'OK', gen: SEAT_GEN } as SeatSlotRead | Error,
  sale: { saleEndsAtMs: NOW + 86_400_000, tierPrices: TIER_PRICES, orderName: ORDER_NAME, entryOpensAtMs: ENTRY_OPENS_AT_MS, virtualAccountAllowed: false } as SaleConfig | undefined,
  holdExpiry: HOLD_EXPIRES_AT_MS as number | undefined | Error,
  /** 차례대로 답한다(하나 남으면 그 값을 되풀이) */
  checkouts: [okCheckout()] as (CheckoutOutcome | Error)[],
  outcome: { status: 'STARTED', attemptNo: 1 } as StartOutcome | Error,
  publish: undefined as Error | 'sync-throw' | undefined,
});

export class StartFakes {
  calls: StartCall[] = [];
  session = defaults().session;
  committed = defaults().committed;
  order = defaults().order;
  count = defaults().count;
  attemptView = defaults().attemptView;
  slot = defaults().slot;
  sale = defaults().sale;
  holdExpiry = defaults().holdExpiry;
  checkoutAnswers = defaults().checkouts;
  outcome = defaults().outcome;
  publishFailure = defaults().publish;

  prepared: PrepareCheckoutQuery[] = [];
  started: { once: OrderRequestOnce; input: StartInput; o: TransactionCallOptions | undefined }[] = [];
  slotReads: { eventId: string; o: { deadlineMs?: number } | undefined }[] = [];
  holdExpiryReads: { q: { eventId: string; holdId: string; seatIds: readonly string[] }; o: { deadlineMs?: number } | undefined }[] = [];
  published: BehaviorSignalMessage[] = [];
  metrics: { pg: string; outcome: StartPaymentMetricOutcome }[] = [];
  dropped: string[] = [];
  exceededLogs: Parameters<StartPaymentLog['attemptsExceeded']>[0][] = [];
  misconfiguredLogs: Parameters<StartPaymentLog['checkoutMisconfigured']>[0][] = [];
  holdExpiryLogs: Parameters<StartPaymentLog['holdExpiryUnreadable']>[0][] = [];

  reset(): void {
    const d = defaults();
    this.calls = [];
    this.session = d.session;
    this.committed = d.committed;
    this.order = d.order;
    this.count = d.count;
    this.attemptView = d.attemptView;
    this.slot = d.slot;
    this.sale = d.sale;
    this.holdExpiry = d.holdExpiry;
    this.checkoutAnswers = d.checkouts;
    this.outcome = d.outcome;
    this.publishFailure = d.publish;
    this.prepared = [];
    this.started = [];
    this.slotReads = [];
    this.holdExpiryReads = [];
    this.published = [];
    this.metrics = [];
    this.dropped = [];
    this.exceededLogs = [];
    this.misconfiguredLogs = [];
    this.holdExpiryLogs = [];
  }

  readonly sessions: OrderSessions = {
    get: async () => {
      this.calls.push('sessions.get');
      if (this.session instanceof Error) throw this.session;
      return this.session;
    },
    markPaying: async () => {
      throw new Error('결제 시도 시작은 Paying 표시를 부르지 않는다');
    },
  };

  readonly starts: StartPaymentReads & StartPaymentWrites = {
    findCommitted: async () => {
      this.calls.push('reads.findCommitted');
      if (this.committed instanceof Error) throw this.committed;
      return this.committed;
    },
    order: async () => {
      this.calls.push('reads.order');
      if (this.order instanceof Error) throw this.order;
      return this.order;
    },
    attemptCount: async () => {
      this.calls.push('reads.attemptCount');
      if (this.count instanceof Error) throw this.count;
      return this.count;
    },
    attempt: async () => {
      this.calls.push('reads.attempt');
      if (this.attemptView instanceof Error) throw this.attemptView;
      return this.attemptView;
    },
    start: async (once, input, o) => {
      this.calls.push('writes.start');
      this.started.push({ once, input, o });
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

  readonly saleConfigs = {
    get: async () => {
      this.calls.push('saleConfigs.get');
      return this.sale;
    },
  };

  readonly holdExpiries: OrderHoldExpiries = {
    expiresAt: async (q, o) => {
      this.calls.push('holdExpiries.expiresAt');
      this.holdExpiryReads.push({ q, o });
      if (this.holdExpiry instanceof Error) throw this.holdExpiry;
      return this.holdExpiry;
    },
  };

  readonly checkouts: PaymentCheckouts = {
    prepare: async (q) => {
      this.calls.push('checkouts.prepare');
      this.prepared.push(q);
      const a = this.checkoutAnswers.length > 1 ? this.checkoutAnswers.shift()! : this.checkoutAnswers[0]!;
      if (a instanceof Error) throw a;
      return a;
    },
  };

  readonly behavior = {
    publish: (m: BehaviorSignalMessage): Promise<void> => {
      this.calls.push('behavior.publish');
      if (this.publishFailure === 'sync-throw') throw new Error('보내기 전에 던졌다');
      if (this.publishFailure) return Promise.reject(this.publishFailure);
      this.published.push(m);
      return Promise.resolve();
    },
  };

  readonly signals: StartPaymentSignals = {
    paymentAttempt: (pg, outcome) => void this.metrics.push({ pg, outcome }),
    telemetryDropped: (record) => void this.dropped.push(record),
  };

  readonly log: StartPaymentLog = {
    attemptsExceeded: (e) => void this.exceededLogs.push(e),
    checkoutMisconfigured: (e) => void this.misconfiguredLogs.push(e),
    holdExpiryUnreadable: (e) => void this.holdExpiryLogs.push(e),
  };

  /** BookingModuleDeps.startPayment */
  bookingPorts() {
    return { starts: this.starts, checkouts: this.checkouts, holdExpiries: this.holdExpiries, behavior: this.behavior, signals: this.signals, log: this.log };
  }

  lastPrepared(): PrepareCheckoutQuery {
    const q = this.prepared.at(-1);
    if (!q) throw new Error('checkouts.prepare를 부르지 않았다');
    return q;
  }

  lastStarted(): StartInput {
    const s = this.started.at(-1);
    if (!s) throw new Error('writes.start를 부르지 않았다');
    return s.input;
  }
}
