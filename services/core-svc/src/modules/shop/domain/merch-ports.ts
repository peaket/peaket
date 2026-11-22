// shop 주문·정산 원천·재고·결제 포트(BAT-610, BAT-600, BAT-605, ADR-0300·ADR-0301·ADR-0313~0315). 메모리(단위 시험)와 Drizzle·Redis·gRPC(운영)가 같은 모양을 쓴다.
import type { RefundAccountValue } from '@peaket/validation/refund-account';
import type { MerchOrderItemRecord, MerchOrderRecord, ProductSettlementItem } from './merch.js';
import type {
  AcceptBody,
  CancelStatus,
  EscrowLine,
  IdempotencyRef as IdempotencyRequest,
  LimitedLine,
  MerchAttempt,
  OrderableProduct,
  OrderState,
  PaymentRef,
  PickupSlotRecord,
  RefundAccountRetryTarget,
  RefundKind,
  ReleasedOrder,
  ReturnReason,
  ShopOrder,
  ShopOrderDetail,
  ShopOrderItem,
  ShopPaymentStore,
  ShopPg,
} from './merch-order.js';

// 명단 원천(listAttendees·countAttendees)은 이 포트에 두지 않는다. 운영은 purchase-svc 내부 HTTP(A2-03), 메모리 조립은 MemoryMerchOrderStore를 직접 쓴다(W7-audit A2-17)
export interface MerchOrderStore {
  /** 정산 기준일이 [from, to]에 든 항목(상품 정산서 원천). */
  listSettlementItems(from: string, to: string): Promise<ProductSettlementItem[]>;
  /** 시험·개발용 넣기(정산 원천 모양). 팬 주문은 ShopOrderStore.insertOrder로 만든다 */
  insertOrder(order: MerchOrderRecord, items: readonly MerchOrderItemRecord[]): Promise<void>;
}

export const MERCH_ORDER_STORE = Symbol.for('peaket.shop.merch-order-store');

// ---- 한정 재고(세션·캐시 Redis, ADR-0300 결정 3) ----

/** 예약 Lua(RESERVE)의 답 */
export type ReserveResult =
  | { kind: 'OK'; remaining: number }
  /** 그 계정의 다른 결제 전 주문이 이 상품을 예약하고 있다(아무것도 바꾸지 않음) */
  | { kind: 'PREV'; orderId: string }
  /** 카운터 키가 없다(수명 끝·재시작). 다시 만든 뒤 한 번 더 예약한다 */
  | { kind: 'NO_COUNTER' }
  | { kind: 'SOLD_OUT'; remaining: number };

export interface ReserveInput {
  productId: string;
  orderId: string;
  accountId: string;
  quantity: number;
  /** 예약 만료 시각(ms, 정렬 집합 점수) */
  untilMs: number;
  /** 네 키의 수명(초) */
  ttlSeconds: number;
}

/** 다시 만들 때 넣는 예약 한 줄(결제 접수 전이고 예약이 끝나지 않은 CREATED 주문) */
export interface RebuildReservation {
  orderId: string;
  accountId: string;
  quantity: number;
  untilMs: number;
}

/** 실패는 StockUnavailable로 던진다(호출 쪽이 503 dependency-unavailable로 답한다) */
export interface MerchStock {
  reserve(i: ReserveInput): Promise<ReserveResult>;
  /**
   * 원소를 지웠을 때만(ZREM 1) 수량 칸을 지우고 restore면 카운터를 돌린다(원소가 없으면 돌리지 않는다). accountId를 주고 unpaid가 그 주문을 가리키면 지운다.
   * 계정을 모르는 주문(DB에 없음)의 unpaid 칸은 원소가 없으므로 RESERVE가 풀린 칸으로 보고 덮어쓴다
   */
  release(productId: string, orderId: string, restore: boolean, accountId?: string): Promise<{ removed: boolean; restored: number }>;
  /** 원소가 있으면 점수를 max(지금, untilMs)로, unpaid에서 그 주문을 지운다. 원소가 없으면 false */
  extend(productId: string, orderId: string, untilMs: number, accountId?: string): Promise<boolean>;
  /** unpaid의 그 계정 칸이 그 주문을 가리킬 때만 지운다 */
  clearUnpaid(productId: string, accountId: string, orderId: string): Promise<boolean>;
  /** 카운터가 없을 때만 카운터 = stock − 예약 합으로 넣고 예약 원소를 없을 때만 넣는다(Lua 하나). 넣었으면 true */
  rebuild(productId: string, stock: number, reservations: readonly RebuildReservation[], ttlSeconds: number): Promise<boolean>;
  /** 점수가 nowMs 이하인 예약 원소(주문 ID) limit개까지 */
  due(productId: string, nowMs: number, limit: number): Promise<string[]>;
  /** 원소가 있으면 점수를 untilMs로 바꾼다 */
  defer(productId: string, orderId: string, untilMs: number): Promise<void>;
  /** 카운터 키만 지운다(한정 수량 고치기 뒤, 다음 주문이 다시 만든다) */
  clearCounter(productId: string): Promise<void>;
}

export class StockUnavailable extends Error {
  constructor(cause?: unknown) {
    super('재고 저장소를 쓸 수 없다', cause === undefined ? undefined : { cause });
    this.name = 'StockUnavailable';
  }
}

export const MERCH_STOCK = Symbol.for('peaket.shop.merch-stock');

// ---- 결제(payment-svc gRPC, ADR-0299) ----

export interface CheckoutQuery {
  orderId: string;
  attemptId: string;
  /** 티켓 연동 부가 상품·현장 수령의 회차. 없으면 null(플랫폼 행만 본다) */
  eventId: string | null;
  amount: number;
  orderName: string;
  payMethod?: string | undefined;
  /** 결제 상점(택배는 ESCROW, ADR-0313) */
  pgStore: ShopPaymentStore;
  /** 에스크로 상점의 주문 상품. 에스크로가 아니면 없다 */
  escrowProducts?: EscrowLine[] | undefined;
  /** 이 결제에서 가상계좌를 내도 되는가(굿즈는 늘 참, ADR-0314) */
  virtualAccountAllowed: boolean;
  /** 멱등 재생에서 그 시도의 결제사로 고정한다(ADR-0352). 값이 있으면 전환·지정을 보지 않고 이 결제사로 값을 만든다 */
  pinnedPg?: ShopPg | undefined;
}

/** 결제창 값(openapi PaymentAttempt.checkout 모양) */
export type CheckoutValues =
  | {
      clientKey: string;
      customerKey: string;
      orderId: string;
      orderName: string;
      amount: number;
      successUrl: string;
      failUrl: string;
      /** 에스크로 상점만. 결제창 주문 상품(openapi checkout escrowProducts, ADR-0313) */
      escrowProducts?: EscrowLine[];
    }
  | { storeId: string; channelKey: string; paymentId: string; orderName: string; totalAmount: number; currency: string; redirectUrl: string; customData?: { orderId: string } };

export interface CheckoutAnswer {
  pg: ShopPg;
  switched: boolean;
  checkout: CheckoutValues;
  allowedPayMethods: string[];
  /** 입금 기한. 가상계좌를 낼 수 있을 때만 있다(openapi PaymentAttempt.depositDueAt) */
  depositDueAtMs?: number;
}

/** 결제창 준비 실패: unavailable → 503 pg-unavailable, invalid → 400, paused → 503 new-payment-paused, error → 503 dependency-unavailable */
export class CheckoutFailed extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid' | 'paused' | 'error') {
    super(`결제창 준비 실패(${reason})`);
    this.name = 'CheckoutFailed';
  }
}

export interface ConfirmCommand {
  orderId: string;
  attemptId: string;
  attemptNo: number;
  pg: ShopPg;
  ref: PaymentRef;
  amount: number;
  authenticatedAtMs: number;
  /** 결제 상점. 원장 `payment.pg_store`에 적힌다(ADR-0313) */
  pgStore: ShopPaymentStore;
}

/** ACCEPTED: payment-svc가 받아 적음. RETRYABLE: 시간 초과·연결 실패(다시 보낸다). REJECTED: 그 밖의 gRPC 오류 */
export type ConfirmOutcome = { status: 'ACCEPTED' } | { status: 'RETRYABLE'; reason: string } | { status: 'REJECTED'; reason: string };

/** BatchGetPayments 답 한 줄 */
export interface PaymentState {
  orderId: string;
  paymentId: string;
  pg: ShopPg | undefined;
  status: 'ACCEPTED' | 'AWAITING_DEPOSIT' | 'APPROVED' | 'UNKNOWN' | 'FAILED' | 'PARTIAL_CANCELED' | 'CANCELED' | 'UNSPECIFIED';
  approvedAtMs: number | undefined;
  failureCategory: string | undefined;
  /** 입금 대기일 때만: 입금 기한(ms). core가 재고 예약을 기한 + 10분까지 늘린다(ADR-0314) */
  depositDueAtMs?: number | undefined;
}

/** GetPayment 답(입금 대기 화면과 가상계좌 결제 판정에 쓴다, ADR-0314·0315) */
export interface PaymentDetail {
  /** 결제 원장의 주문 ID. 요청 주문과 다르면 응답에 계좌를 싣지 않는다(RV-11) */
  orderId?: string | undefined;
  status: PaymentState['status'];
  pg?: ShopPg | undefined;
  depositDueAtMs?: number | undefined;
  /** 입금처 계좌(입금 대기일 때만). 로그·사건·지표에 싣지 않는다 */
  virtualAccount?: { bank?: string | undefined; accountNumber?: string | undefined; dueAtMs?: number | undefined } | undefined;
  /** 가상계좌로 받은 결제인가(payment-svc `virtual_account_paid`). 취소에 환불 계좌가 필요한지 정한다 */
  virtualAccountPaid?: boolean | undefined;
}

/** CancelPayment 결과. REFUND_ACCOUNT_REQUIRED는 가상계좌 결제에 계좌가 없거나 결제사가 계좌를 거절한 것이다 */
export type CancelOutcome = 'CANCELLED' | 'CANCEL_PENDING' | 'REFUND_ACCOUNT_REQUIRED' | 'REJECTED' | 'UNKNOWN';

/** 결제사 취소 입력. 계좌는 이 호출 안에서만 쓰고 저장하지 않는다(ADR-0050 결정 3) */
export interface CancelInput {
  paymentId: string;
  cancellationId: string;
  amount: number;
  reason: string;
  refundAccount?: RefundAccountValue | undefined;
  /** 계좌 다시 받기 시도 번호(0/없음 = 첫 시도, 1~3 [가정]). payment-svc가 멱등키를 가른다(ADR-0316) */
  refundAttempt?: number | undefined;
  /** 입금 전 취소만. 굿즈 구매자 취소는 결제 후 일반 취소라 쓰지 않는다 */
  scope?: 'DEPOSIT_ONLY' | undefined;
}

export interface MerchPayments {
  /** @throws CheckoutFailed */
  prepareCheckout(q: CheckoutQuery): Promise<CheckoutAnswer>;
  /** 던지지 않는다 */
  confirm(c: ConfirmCommand, deadlineMs: number): Promise<ConfirmOutcome>;
  /** 답에 없는 주문은 빠진다. @throws Error payment-svc가 답하지 못함 */
  batchGet(orderIds: readonly string[]): Promise<PaymentState[]>;
  /** 결제 원장 하나. 없으면 undefined. @throws Error payment-svc가 답하지 못함(호출 쪽이 503). 포트가 없는 조립(옛 시험 대역)은 부르지 않는다 */
  getPayment?(orderId: string, deadlineMs: number): Promise<PaymentDetail | undefined>;
  /** 호출 실패는 UNKNOWN(다시 부른다). 던지지 않는다 */
  cancel(c: CancelInput): Promise<CancelOutcome>;
}

export const MERCH_PAYMENTS = Symbol.for('peaket.shop.merch-payments');

// ---- 재인증(ADR-0293, ADR-0315, purchase-svc JwksFanReauthGate와 같은 꼴) ----

export type ShopReauthAct = 'FAN_HIGH_RISK';
export type ShopReauthOp = 'SHOP_CANCEL_REFUND_ACCOUNT';

/** 재인증 확인기·jti 저장소를 쓸 수 없다(받는 층이 503 reauth-unavailable) */
export class ReauthUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReauthUnavailable';
  }
}

/** false = 거절(403 reauth-required). 확인기를 쓸 수 없으면 ReauthUnavailable을 던진다(503) */
export interface ShopReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: ShopReauthAct; readonly op: ShopReauthOp }): Promise<boolean>;
}

export const SHOP_REAUTH_GATE = Symbol.for('peaket.shop.reauth-gate');

/** 확인기를 꽂지 않은 조립의 닫힌 기본값(늘 403). local·ci가 주소 없이 뜰 때 쓴다 */
export const closedShopReauthGate: ShopReauthGate = { verify: async () => false };

// ---- 티켓 보유(ticket-svc ListHeldTickets, ADR-0301 결정 1) ----

export interface HeldTicketsPort {
  /** 그 계정이 지금 가진 그 회차의 유효한 티켓 ID. @throws HeldTicketsUnavailable(→ 503) */
  held(accountId: string, eventId: string): Promise<string[]>;
}

export class HeldTicketsUnavailable extends Error {
  constructor(readonly code: string) {
    super(`티켓 보유를 확인하지 못했다(${code})`);
    this.name = 'HeldTicketsUnavailable';
  }
}

export const HELD_TICKETS = Symbol.for('peaket.shop.held-tickets');

// ---- 주문 저장(core_app, ADR-0300 결정 4~9, ADR-0301 결정 2~5) ----

export interface NewShopOrder {
  order: ShopOrder;
  items: ShopOrderItem[];
}

/** 새 결제 시도. 저장소는 `attemptId`를 멱등 기록의 결과 참조로 쓴다(결제창 값은 저장하지 않는다, ADR-0352) */
export interface NewAttempt {
  orderId: string;
  accountId: string;
  attemptId: string;
  pg: ShopPg;
  payMethod: string | null;
  nowMs: number;
}

/** 승인 명령 작업(merch_confirm_job) */
export interface ConfirmJob {
  orderId: string;
  attemptId: string;
  attemptNo: number;
  pg: ShopPg;
  /** 주문의 결제 상점(승인 명령 payment_store, ADR-0313) */
  pgStore: ShopPaymentStore;
  ref: PaymentRef;
  amount: number;
  authenticatedAtMs: number;
  /** payment-svc가 한 번이라도 받아 적었는가 */
  sent: boolean;
  /** 보낸 횟수 */
  tries: number;
}

/** 결제 접수 결과(커밋한 것) */
export type AcceptOutcome =
  | { kind: 'accepted'; job: ConfirmJob; limited: LimitedLine[]; reservedUntil: Date }
  /** 접수 때 PostgreSQL 남은 수가 모자라 주문을 FAILED로 끝냈다(커밋함). 호출 쪽이 예약을 풀고 409 merch-sold-out */
  | { kind: 'sold-out'; limited: LimitedLine[] }
  /** 같은 멱등 키의 다시 온 요청 */
  | { kind: 'replay'; resultRef: string };

export interface UnclaimedCandidate {
  orderId: string;
  paymentId: string | null;
  items: { itemId: string; productId: string; quantity: number; unitAmount: number; lastSlotEndsAtMs: number }[];
}

export interface RefundRow {
  refundId: string;
  orderId: string;
  paymentId: string | null;
  /** 이 환급이 덮는 항목 ID들. 계좌 다시 받기의 새 행이 같은 항목 자리를 다시 잡는다 */
  itemIds: string[];
  amount: number;
  reason: string;
  status: 'REQUESTED' | 'CANCEL_PENDING' | 'CANCELLED' | 'REJECTED';
  createdAtMs: number;
  alerted: boolean;
  /** 미수령(UNCLAIMED)·구매자 취소(USER_CANCEL)·반품(RETURN). 0030 이전 행은 UNCLAIMED다 */
  kind: RefundKind;
  /** 다시 부른 횟수(처음 요청 안의 호출은 세지 않는다) */
  attempts: number;
  /** 다음 호출 시각. 끝났거나 계좌를 기다리면 null */
  nextAtMs: number | null;
  /** 계좌를 기다리는 시각(있으면 자동 재시도를 멈춘다) */
  accountRequiredAtMs: number | null;
  /** 이 행을 대신한 새 환급 행의 ID(계좌 다시 받기, ADR-0316 결정 5). 옛 시험 대역은 비운다 */
  replacesRefundId?: string | null | undefined;
  /** 계좌 다시 받기 시도 번호(원래 행 0, `replaces_refund_id` 사슬의 깊이). 결제사 멱등키를 가른다 */
  refundAttempt?: number | undefined;
  /** 값 없는 실패 이름표(REFUND_ACCOUNT_REQUIRED·PG_REJECTED·RETRY_EXHAUSTED) */
  failReason?: string | null | undefined;
}

/** 구매자 취소 한 건의 응답 값(openapi Cancellation) */
export interface CancelRowView {
  cancellationId: string;
  /** 그 환급 행의 주문. 멱등 재생이 경로 주문과 견준다(ADR-0337 결정 6) */
  orderId: string;
  status: CancelStatus;
  refundAmount: number;
  refundAccountRequired: boolean;
  /** 환급 행의 지금 상태. 같은 키 다시 오기가 거절을 그대로 돌려주는 데 쓴다 */
  state: 'REQUESTED' | 'PENDING' | 'CANCELLED' | 'REJECTED';
}

/** 구매자 취소 만들기. 저장소가 주문·항목을 잠그고 자격을 다시 보고 금액을 계산한다 */
export interface NewCancellation {
  /** 환급 행 ID = 결제사 취소 ID(UUIDv7) */
  refundId: string;
  orderId: string;
  accountId: string;
  itemIds: string[];
  nowMs: number;
  /** 부가 상품의 연결 회차 입장 시작(ms). 모르면 없다 */
  entryOpensAtMs?: number | undefined;
}

/** 반품 요청 만들기. 결제사를 부르지 않고 계좌도 받지 않는다 */
export interface NewReturn {
  orderId: string;
  accountId: string;
  itemIds: string[];
  reason: ReturnReason;
  returnTrackingNo?: string | undefined;
  nowMs: number;
  entryOpensAtMs?: number | undefined;
}

/** 굿즈 지연 환급 계좌 다시 받기(새 행·새 자리). 계좌는 받지 않는다(저장하지 않는다, POL-014) */
export interface BeginRefundAccountRetry {
  /** 경로의 취소 ID. 옛 행이면 `replaces_refund_id` 사슬을 따라 끝 행을 다시 본다 */
  cancellationId: string;
  orderId: string;
  accountId: string;
  /** 새 환급 행 ID(새 결제사 취소 ID, UUIDv7) */
  refundId: string;
  nowMs: number;
}

export interface AddonItemRow {
  orderId: string;
  accountId: string;
  itemId: string;
  productId: string;
  name: string;
  quantity: number;
  status: ShopOrderItem['status'];
  eventId: string | null;
  transferable: boolean;
}

export interface ShopOrderStore {
  /** 주문에 쓰는 상품(core_app). 없는 ID는 빠진다 */
  products(ids: readonly string[]): Promise<OrderableProduct[]>;
  /** 그 계정의 PAID·결제 접수한(CREATED) 주문의 상품별 수량(취소·환급 항목 뺌) */
  committedQuantities(accountId: string, productIds: readonly string[]): Promise<Map<string, number>>;
  pickupSlot(slotId: string): Promise<PickupSlotRecord | undefined>;
  /** 회차 끝 시각(catalog event.ends_at, 부가 상품 정산 기준일). 없으면 null */
  eventEndsAt(eventId: string): Promise<Date | null>;
  /** 회차 입장 시작(event.entry_opens_at, 없으면 starts_at). 부가 상품 취소·반품 자격의 기준이다(ADR-0315) */
  eventEntryOpensAt(eventId: string): Promise<Date | null>;
  pickupSlotsOf(productIds: readonly string[]): Promise<PickupSlotRecord[]>;
  orderState(orderId: string): Promise<OrderState | undefined>;
  /** 다시 만들기 값: product_stock.stock과 결제 접수 전이고 예약이 끝나지 않은 CREATED 주문의 예약. 한정 상품이 아니면 undefined */
  rebuildSource(productId: string, nowMs: number): Promise<{ stock: number; reservations: RebuildReservation[] } | undefined>;
  /** 커밋한 멱등 기록의 결과 참조. 없으면 undefined. @throws 422 idempotency-key-reused(플랫폼 Problem)(다른 지문) */
  replayOf(once: IdempotencyRequest): Promise<string | undefined>;
  /** 주문·항목을 한 트랜잭션으로(멱등 기록 포함). 그사이 같은 키가 커밋됐으면 replay */
  insertOrder(once: IdempotencyRequest, o: NewShopOrder): Promise<{ kind: 'created' } | { kind: 'replay'; resultRef: string }>;
  /**
   * 주문 행을 잠그고 조건부로 EXPIRED(O7). 상태 CREATED이고 결제 접수 전이며, mode 'due'면 stock_reserved_until ≤ now일 때만.
   * 'superseded'(같은 상품의 새 주문)는 기한을 보지 않는다. READY 시도는 EXPIRED. 바뀐 주문만 돌려준다
   */
  expireUnpaid(orderId: string, nowMs: number, mode: 'due' | 'superseded'): Promise<ReleasedOrder | undefined>;
  /** 예약 기한이 지난 결제 전 CREATED 주문 ID(limit개까지, 기한 차례) */
  dueUnpaidOrders(nowMs: number, limit: number): Promise<string[]>;
  findOrder(orderId: string): Promise<ShopOrderDetail | undefined>;
  /** 결제 시도 하나(대체·만료 포함). 없거나 UUID 꼴이 아니면 undefined. 결제 시도 재생이 시도의 주문·결제사를 견준다(ADR-0337 결정 6) */
  paymentAttempt(attemptId: string): Promise<MerchAttempt | undefined>;
  /** 최근 순(EXPIRED·FAILED 뺌) */
  listOrders(accountId: string, limit: number, cursor?: string): Promise<{ items: ShopOrderDetail[]; nextCursor: string | null }>;
  /**
   * 결제 시도 넣기(멱등 기록 포함): 주문 행을 잠그고 시작 조건을 다시 본 뒤 이전 READY를 SUPERSEDED, 새 READY를 넣는다.
   * @throws ShopProblem 시작 조건(attemptStartBlocker)·없는 주문·남의 주문(404)
   */
  saveAttempt(once: IdempotencyRequest, a: NewAttempt): Promise<{ kind: 'saved' } | { kind: 'replay'; resultRef: string }>;
  /**
   * 결제 접수(멱등 기록 포함, 한 트랜잭션): 주문 행 FOR UPDATE → acceptBlocker → 한정 상품마다 상품 ID 차례로 product_stock을 stock ≥ quantity 조건부로 깎음
   * (하나라도 0행이면 깎은 것을 되돌리고 주문 FAILED·시도 FAILED를 커밋) → 시도 ACCEPTED·주문 pg·stock_reserved_until·승인 명령 작업.
   * @throws ShopProblem 접수 조건, 404
   */
  acceptPayment(once: IdempotencyRequest, i: { orderId: string; accountId: string; nowMs: number; body: AcceptBody; ref: PaymentRef }): Promise<AcceptOutcome>;
  /** 승인 명령을 payment-svc가 받아 적음: sent = true, 다음 당기기 시각 */
  markConfirmSent(orderId: string, nextAtMs: number): Promise<void>;
  /** 작업의 다음 시각만 바꾼다(tries를 주면 그 값으로, sent를 주면 그 값으로) */
  rescheduleJob(orderId: string, nextAtMs: number, o?: { tries?: number; sent?: boolean }): Promise<void>;
  /** 다음 시각이 된 작업 limit건을 FOR UPDATE SKIP LOCKED로 잡고 다음 시각을 leaseUntilMs로 미룬 뒤 돌려준다 */
  claimDueJobs(nowMs: number, limit: number, leaseUntilMs: number): Promise<ConfirmJob[]>;
  /** 한 트랜잭션: 주문 CREATED → PAID(O5, 조건부), 항목 READY, 결제 ID·결제사·승인 시각, 작업 지움. 바뀌었으면 한정 상품 목록 */
  applyPaid(orderId: string, r: { paymentId: string; pg: ShopPg | undefined; approvedAtMs: number }): Promise<ReleasedOrder | undefined>;
  /** 한 트랜잭션: 주문 CREATED → FAILED(O6, 조건부), 접수한 주문이면 한정 상품마다 product_stock + 수량, 시도 FAILED, 작업 지움 */
  applyFailed(orderId: string, nowMs: number): Promise<ReleasedOrder | undefined>;
  /** 한정 상품(limited_qty 있음, DRAFT 아님)과 판매 종료 */
  limitedProducts(): Promise<{ productId: string; saleEndsAt: Date | null }[]>;
  // ---- 부가 상품(ADR-0301 결정 3) ----
  /** linked_ticket_id가 그 티켓이고 주문이 PAID인 항목 */
  addonItems(ticketId: string): Promise<AddonItemRow[]>;
  // ---- 미수령(ADR-0301 결정 5) ----
  /** PAID 현장 수령 주문의 READY 항목과 그 상품·회차의 마지막 시간대 끝(끝이 nowMs 이전인 것만) */
  unclaimedCandidates(nowMs: number, limit: number): Promise<UnclaimedCandidate[]>;
  /** 한 트랜잭션: 항목 READY → CANCELLED(cancel_reason UNCLAIMED, 조건부)와 환급 행 REQUESTED. 바뀐 항목이 없으면 undefined */
  cancelUnclaimed(orderId: string, itemIds: readonly string[], refundId: string, nowMs: number): Promise<RefundRow | undefined>;
  /** 다음 시각이 된 REQUESTED·CANCEL_PENDING 환급(미수령 자동 취소 몫) */
  dueRefunds(nowMs: number, limit: number): Promise<RefundRow[]>;
  /**
   * 환급 결과 반영. 미수령은 항목이 이미 CANCELLED다. 구매자 취소·반품은 CANCELLED·CANCEL_PENDING·UNKNOWN이면 항목 READY → CANCELLED,
   * CANCELLED 결과면 → REFUNDED. 계좌 거절·거절은 항목을 바꾸지 않고 환급 행만 REJECTED로 끝낸다(ADR-0315)
   */
  refundResult(
    refundId: string,
    outcome: CancelOutcome,
    nowMs: number,
    o?: { alerted?: boolean; attempts?: number; nextAtMs?: number | null; failReason?: string; accountRequiredAtMs?: number },
  ): Promise<void>;
  // ---- 구매자 취소·반품(BAT-605, ADR-0315) ----
  /** 주문 행·항목을 잠그고 자격을 다시 본 뒤 환급 행(REQUESTED)·항목 환급 자리(merch_refund_item)·멱등 기록을 한 트랜잭션으로 쓴다. 항목 상태는 바꾸지 않는다 */
  createCancellation(once: IdempotencyRequest, i: NewCancellation): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }>;
  /** 멱등 다시 오기의 결과 참조 `cancel:{환급 ID}`를 응답으로 바꾼다. 없으면 undefined */
  cancelView(refundId: string): Promise<CancelRowView | undefined>;
  // ---- 굿즈 지연 환급 계좌 다시 받기(ADR-0316 결정 5, R-T43) ----
  /**
   * 그 주문(세션 계정 소유)의 환급 행을 읽어 경로의 취소 ID에서 `replaces_refund_id` 사슬 끝 행을 찾는다.
   * 없거나 남의 주문·다른 주문의 취소 ID면 undefined(받는 층이 같은 404). 자격·시도 상한은 `assertRefundAccountRetryable`이 본다
   */
  findRejectedAccountRequired(orderId: string, accountId: string, cancellationId: string): Promise<RefundAccountRetryTarget | undefined>;
  /**
   * 한 트랜잭션: 주문 행 잠금 → 소유·사슬 끝 행 자격·시도 상한 다시 보기 → 새 `merch_refund` 행(`replaces_refund_id` = 끝 행, 같은 kind·amount·사유)
   * 과 새 `merch_refund_item` 자리, 멱등 기록. 옛 행은 `REJECTED` 그대로 둔다. 항목 상태는 바꾸지 않는다.
   * @throws ShopProblem 404 not-found · MerchCancelNotAllowed(409, 자격·상한·자리 경합)
   */
  beginAccountRetry(once: IdempotencyRequest, i: BeginRefundAccountRetry): Promise<{ kind: 'created'; refund: RefundRow } | { kind: 'replay'; resultRef: string }>;
  /** 반품 요청: 주문 행·항목을 잠그고 자격을 다시 본 뒤 항목 RETURN_REQUESTED·사유·송장·기한과 멱등 기록을 한 트랜잭션으로 쓴다 */
  applyReturn(once: IdempotencyRequest, i: NewReturn): Promise<{ kind: 'created'; orderId: string } | { kind: 'replay'; resultRef: string }>;
  /** 다음 시각이 된 구매자 취소 환급(USER_CANCEL·RETURN, 계좌를 기다리지 않음) */
  dueUserRefunds(nowMs: number, limit: number): Promise<RefundRow[]>;
  /** 입금 대기로 바꾼다(CREATED일 때만). 재고 예약을 입금 기한 + 10분 [가정]까지 늘릴 값을 돌려준다(ADR-0314) */
  applyAwaitingDeposit(orderId: string, x: { paymentId: string; pg: ShopPg | undefined; depositDueAtMs: number | undefined; nowMs: number }): Promise<{ orderId: string; accountId: string; deadline: Date; limited: LimitedLine[] } | undefined>;
  /** 입금 기한 + 10분이 지난 AWAITING_DEPOSIT 주문(끝낼 대상) */
  dueDepositOrders(nowMs: number, limit: number): Promise<string[]>;
  /** 한 트랜잭션: AWAITING_DEPOSIT → EXPIRED(조건부), product_stock 복구, 시도 EXPIRED, 작업 지움 */
  expireDeposit(orderId: string, nowMs: number): Promise<ReleasedOrder | undefined>;
  // ---- 속성 검증 잡(ADR-0300 결정 2) ----
  productAttributesPage(afterId: string | undefined, limit: number): Promise<{ productId: string; type: string; schemaVersion: number; attributes: unknown }[]>;
}

export const SHOP_ORDER_STORE = Symbol.for('peaket.shop.order-store');

/** 상품 유형 표(product_type, core_app으로 읽는다) */
export interface ProductTypeDirectory {
  find(code: string): Promise<{ code: string; latestSchemaVersion: number; enabled: boolean } | undefined>;
}

export const PRODUCT_TYPE_DIRECTORY = Symbol.for('peaket.shop.product-type-directory');

/** 택배 주문의 동의 문안 판(환경 값 PEAKET_MERCH_CONSENT_VERSION) */
export const MERCH_CONSENT_VERSION = Symbol.for('peaket.shop.merch-consent-version');
