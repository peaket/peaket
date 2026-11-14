// 주문 생성 POST /v1/orders(BUILD_ORDER PRF-161, docs/features/payment.md §2 '주문 생성의 첫 구현') 단위 시험의 공용 재료.
// booking 포트의 메모리 가짜(부른 차례와 인자를 적는다)와 정상 요청 하나. create-order.test.ts(쓰임새)와 orders-http.test.ts(받는 층)가 함께 쓴다.
// 가짜는 값을 정해 두면 그대로 답하고, Error를 넣어 두면 그것을 던진다. reset()이 모두 처음 값으로 되돌린다.
import { fakeClock, type FakeClock } from '@peaket/platform';
import type {
  BookingRestriction,
  BookingRestrictions,
  CommittedOrderLookup,
  ContactRefs,
  CreateOrderBody,
  CreateOrderCommand,
  FallbackReason,
  HeldSeat,
  IdentityRecheck,
  IdentityRecheckQuery,
  NewOrder,
  OrderCreateOutcome,
  OrderHoldCheck,
  OrderHoldQuery,
  OrderHolds,
  OrderLog,
  OrderRequestOnce,
  OrderSessions,
  OrderSessionView,
  OrderSignals,
  OrderView,
  OrderWrites,
  PriorityGrants,
  PriorityGrantView,
  RecheckAnswer,
  SaleConfig,
  SaleConfigs,
  TransactionCallOptions,
} from '../src/modules/booking/index.js';

export const NOW = Date.parse('2026-11-05T03:00:00.000Z');
export const DAY = 24 * 3600_000;
/** 계정(소문자 UUID, 행위자 모양 account:<UUID>에 맞는다) */
export const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
/** 액세스 토큰의 로그인 세션 ID(Principal.sessionId) */
export const LOGIN = 'ls-order-1';
/** 구매 세션 ID(= 입장 토큰 jti) */
export const PSID = '0190f3a1-7c2e-7b00-8000-0000000000b1';
/** 구매 세션이 묶인 회차 */
export const EVENT = '0190f3a1-7c2e-7c00-8000-0000000000c1';
/** 구매 세션 상태의 여정 ID(입장 토큰 jny, UUIDv7) */
export const JOURNEY = '0190f3a1-7c2e-7d00-8000-0000000000d1';
/** 본문 holdId(소문자 UUID) */
export const HOLD_ID = '0190f3a1-7c2e-7e00-8000-0000000000e1';
/** 멱등 키(소문자 UUID v4) */
export const IDEM_KEY = '3f0b8c1e-2d4a-4b6c-9e8f-1a2b3c4d5e6f';
/** 토큰의 pid(사람 식별값) */
export const PID = 'pid-0001';
/** 지금 동의 문안 판(PEAKET_ORDER_CONSENT_VERSION) */
export const CONSENT_VERSION = 'v3';
/** 조사용 연락처 가명(identity가 돌려주는 모양: 키 판 접두어 + base64url) */
export const CONTACT_REF = 'k1.Zm9vYmFyYmF6';
/** 등급 가격(원) */
export const TIER_PRICES: Readonly<Record<string, number>> = Object.freeze({ R: 110_000, S: 88_000 });
/** 홀드 좌석(구매 세션에 기록한 차례 = 좌석 ID 오름차순) */
export const SEATS: readonly HeldSeat[] = Object.freeze([
  { seatId: 'A01', tierId: 'R', sectionId: 'SEC-A' },
  { seatId: 'A02', tierId: 'R', sectionId: 'SEC-A' },
  { seatId: 'B01', tierId: 'S', sectionId: 'SEC-B' },
]);
/** SEATS의 등급 가격 합 = 110,000 × 2 + 88,000 */
export const AMOUNT = 308_000;
/** SEATS의 주문 항목(좌석 차례, unitPrice = 등급 가격) */
export const ITEMS = Object.freeze([
  { seatId: 'A01', tierId: 'R', sectionId: 'SEC-A', unitPrice: 110_000 },
  { seatId: 'A02', tierId: 'R', sectionId: 'SEC-A', unitPrice: 110_000 },
  { seatId: 'B01', tierId: 'S', sectionId: 'SEC-B', unitPrice: 88_000 },
]);

/** 정상 본문(동의 둘 true, 지금 판, 국내 표기 번호) */
export function okBody(over: Partial<CreateOrderBody> = {}): CreateOrderBody {
  return {
    holdId: HOLD_ID,
    buyer: { name: '홍길동', phone: '010-1234-5678' },
    consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT_VERSION },
    ...over,
  };
}

/** 정상 멱등 요청 값(범위 계정 × CREATE_ORDER) */
export function okIdem(over: Partial<OrderRequestOnce> = {}): OrderRequestOnce {
  return { accountRef: ACCOUNT, operation: 'CREATE_ORDER', key: IDEM_KEY, requestHash: new Uint8Array(32).fill(7), ...over };
}

/** 정상 쓰임새 입력(토큰에 ticket:buy와 pid가 있다) */
export function okCommand(over: Partial<CreateOrderCommand> = {}): CreateOrderCommand {
  return {
    accountId: ACCOUNT,
    loginSessionId: LOGIN,
    token: { pid: PID, scopes: ['ticket:buy'] },
    purchaseSessionId: PSID,
    idem: okIdem(),
    body: okBody(),
    ...over,
  };
}

/** 부른 포트 이름(차례 비교용) */
export type PortCall =
  | 'sessions.get'
  | 'writes.findCommitted'
  | 'saleConfigs.get'
  | 'holds.check'
  | 'priorityGrants.find'
  | 'identity.check'
  | 'restrictions.read'
  | 'contactRefs.compute'
  | 'writes.create'
  | 'sessions.markPaying';

/** 새 주문을 그대로 돌려주는 주문 모습(가짜 writes.create의 기본 답) */
export const viewOf = (o: NewOrder): OrderView => ({ orderId: o.id, amount: o.amount, status: 'CREATED', items: o.items });

/** 다른 요청이 먼저 커밋해 둔 주문 하나(멱등 재생 시험용) */
export const COMMITTED_VIEW: OrderView = Object.freeze({
  orderId: '0190f3a1-7c2e-7f00-8000-0000000000f1',
  amount: AMOUNT,
  status: 'CREATED',
  items: ITEMS,
});

const defaults = () => ({
  session: { sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY } as OrderSessionView | undefined | Error,
  committed: { status: 'NONE' } as CommittedOrderLookup | Error,
  sale: { saleEndsAtMs: NOW + DAY, tierPrices: TIER_PRICES } as SaleConfig | undefined,
  hold: { status: 'OK', heldAtMs: NOW - 60_000, seats: SEATS } as OrderHoldCheck,
  priorityGrant: undefined as PriorityGrantView | undefined,
  recheck: { status: 'VERIFIED', pid: PID } as RecheckAnswer,
  restriction: undefined as BookingRestriction | undefined | Error,
  contactRef: CONTACT_REF as string | undefined,
  outcome: undefined as OrderCreateOutcome | Error | undefined,
  paying: true as boolean | Error,
  /** 있으면 markPaying이 이 차례로 하나씩 꺼내 답한다(다 쓰면 paying). 다시 부르기 시험용 */
  payingSeq: [] as (boolean | Error)[],
});

/**
 * booking 포트 아홉의 메모리 가짜. calls에 부른 차례를 적고, 각 포트의 인자를 따로 적는다.
 * outcome이 undefined면 writes.create는 받은 새 주문으로 CREATED(viewOf)를 돌려준다
 */
export class OrderFakes {
  readonly clock: FakeClock;
  calls: PortCall[] = [];
  session = defaults().session;
  committed = defaults().committed;
  sale = defaults().sale;
  hold = defaults().hold;
  priorityGrant = defaults().priorityGrant;
  recheck = defaults().recheck;
  restriction = defaults().restriction;
  contactRef = defaults().contactRef;
  outcome = defaults().outcome;
  paying = defaults().paying;
  payingSeq = defaults().payingSeq;

  sessionGets: string[] = [];
  committedQueries: OrderRequestOnce[] = [];
  saleGets: string[] = [];
  holdQueries: OrderHoldQuery[] = [];
  recheckQueries: IdentityRecheckQuery[] = [];
  restrictionReads: string[] = [];
  contactCalls: { phoneE164: string; deadlineMs: number }[] = [];
  created: { once: OrderRequestOnce; order: NewOrder }[] = [];
  /** writes.create에 넘긴 트랜잭션 선택값(부른 차례, 리뷰 고침 L4) */
  createOptions: (TransactionCallOptions | undefined)[] = [];
  payingCalls: string[] = [];
  /** markPaying에 넘긴 마감 선택값(부른 차례) */
  payingOptions: ({ deadlineMs?: number } | undefined)[] = [];
  fallbackSignals: FallbackReason[] = [];
  fallbackLogs: Parameters<OrderLog['identityFallback']>[0][] = [];
  configErrors: Parameters<OrderLog['configError']>[0][] = [];
  /** 있으면 writes.create가 이 약속을 기다린다(BAT-037 칸막이 시험이 처리기를 붙잡는 문) */
  createGate: Promise<void> | undefined = undefined;
  /** Paying 표시 실패 지표(purchase_order_paying_mark_failed_total)를 올린 수 */
  payingFailedSignals = 0;
  payingFailedLogs: Parameters<OrderLog['payingMarkFailed']>[0][] = [];

  constructor(clock: FakeClock = fakeClock({ now: NOW })) {
    this.clock = clock;
  }

  /** 답과 기록을 모두 처음으로 */
  reset(): void {
    Object.assign(this, defaults());
    this.calls = [];
    this.sessionGets = [];
    this.committedQueries = [];
    this.saleGets = [];
    this.holdQueries = [];
    this.recheckQueries = [];
    this.restrictionReads = [];
    this.contactCalls = [];
    this.created = [];
    this.createOptions = [];
    this.payingCalls = [];
    this.payingOptions = [];
    this.payingSeq = [];
    this.fallbackSignals = [];
    this.fallbackLogs = [];
    this.configErrors = [];
    this.createGate = undefined;
    this.payingFailedSignals = 0;
    this.payingFailedLogs = [];
  }

  readonly sessions: OrderSessions = {
    get: async (sessionId) => {
      this.calls.push('sessions.get');
      this.sessionGets.push(sessionId);
      if (this.session instanceof Error) throw this.session;
      return this.session;
    },
    markPaying: async (sessionId, o) => {
      this.calls.push('sessions.markPaying');
      this.payingCalls.push(sessionId);
      this.payingOptions.push(o);
      const answer = this.payingSeq.length > 0 ? this.payingSeq.shift()! : this.paying;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  readonly writes: OrderWrites = {
    findCommitted: async (once) => {
      this.calls.push('writes.findCommitted');
      this.committedQueries.push(once);
      if (this.committed instanceof Error) throw this.committed;
      return this.committed;
    },
    create: async (once, order, o) => {
      this.calls.push('writes.create');
      this.created.push({ once, order });
      this.createOptions.push(o);
      if (this.createGate) await this.createGate;
      if (this.outcome instanceof Error) throw this.outcome;
      return this.outcome ?? { status: 'CREATED', order: viewOf(order) };
    },
  };

  readonly saleConfigs: SaleConfigs = {
    get: async (eventId) => {
      this.calls.push('saleConfigs.get');
      this.saleGets.push(eventId);
      return this.sale;
    },
  };

  readonly holds: OrderHolds = {
    check: async (q) => {
      this.calls.push('holds.check');
      this.holdQueries.push(q);
      return this.hold;
    },
    limit: async () => undefined,
  };

  readonly priorityGrants: PriorityGrants = {
    find: async (grantId) => {
      this.calls.push('priorityGrants.find');
      return this.priorityGrant?.grantId === grantId ? this.priorityGrant : undefined;
    },
  };

  readonly identity: IdentityRecheck = {
    check: async (q) => {
      this.calls.push('identity.check');
      this.recheckQueries.push(q);
      return this.recheck;
    },
  };

  readonly restrictions: BookingRestrictions = {
    read: async (accountId) => {
      this.calls.push('restrictions.read');
      this.restrictionReads.push(accountId);
      if (this.restriction instanceof Error) throw this.restriction;
      return this.restriction;
    },
  };

  readonly contactRefs: ContactRefs = {
    compute: async (phoneE164, deadlineMs) => {
      this.calls.push('contactRefs.compute');
      this.contactCalls.push({ phoneE164, deadlineMs });
      return this.contactRef;
    },
  };

  readonly signals: OrderSignals = {
    historyMismatch: () => {},
    identityFallback: (reason) => {
      this.fallbackSignals.push(reason);
    },
    payingMarkFailed: () => {
      this.payingFailedSignals += 1;
    },
  };

  readonly log: OrderLog = {
    identityFallback: (e) => {
      this.fallbackLogs.push(e);
    },
    configError: (e) => {
      this.configErrors.push(e);
    },
    payingMarkFailed: (e) => {
      this.payingFailedLogs.push(e);
    },
  };

  /** 포트 아홉(CreateOrderDeps·BookingModuleDeps에 그대로 펼친다) */
  ports() {
    return {
      sessions: this.sessions,
      writes: this.writes,
      holds: this.holds,
      saleConfigs: this.saleConfigs,
      identity: this.identity,
      contactRefs: this.contactRefs,
      restrictions: this.restrictions,
      priorityGrants: this.priorityGrants,
      signals: this.signals,
      log: this.log,
    };
  }

  /** 마지막으로 만든 새 주문 */
  lastOrder(): NewOrder {
    const c = this.created.at(-1);
    if (!c) throw new Error('writes.create를 부르지 않았다');
    return c.order;
  }
}
