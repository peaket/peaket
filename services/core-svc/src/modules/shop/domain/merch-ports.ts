// shop 주문·정산 원천·재고·결제 포트(BAT-610, BAT-600, ADR-0300·ADR-0301). 메모리(단위 시험)와 Drizzle·Redis·gRPC(운영)가 같은 모양을 쓴다.
import type { MerchOrderItemRecord, MerchOrderRecord, ProductSettlementItem } from './merch.js';
import type { AcceptBody, IdempotencyRef as IdempotencyRequest, LimitedLine, OrderableProduct, OrderState, PaymentRef, PickupSlotRecord, ReleasedOrder, ShopOrder, ShopOrderDetail, ShopOrderItem, ShopPg } from './merch-order.js';

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
}

/** 결제창 값(openapi PaymentAttempt.checkout 모양) */
export type CheckoutValues =
  | { clientKey: string; customerKey: string; orderId: string; orderName: string; amount: number; successUrl: string; failUrl: string }
  | { storeId: string; channelKey: string; paymentId: string; orderName: string; totalAmount: number; currency: string; redirectUrl: string; customData?: { orderId: string } };

export interface CheckoutAnswer {
  pg: ShopPg;
  switched: boolean;
  checkout: CheckoutValues;
  allowedPayMethods: string[];
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
}

export type CancelOutcome = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';

export interface MerchPayments {
  /** @throws CheckoutFailed */
  prepareCheckout(q: CheckoutQuery): Promise<CheckoutAnswer>;
  /** 던지지 않는다 */
  confirm(c: ConfirmCommand, deadlineMs: number): Promise<ConfirmOutcome>;
  /** 답에 없는 주문은 빠진다. @throws Error payment-svc가 답하지 못함 */
  batchGet(orderIds: readonly string[]): Promise<PaymentState[]>;
  /** 호출 실패는 UNKNOWN(다시 부른다). 던지지 않는다 */
  cancel(c: { paymentId: string; cancellationId: string; amount: number; reason: string }): Promise<CancelOutcome>;
}

export const MERCH_PAYMENTS = Symbol.for('peaket.shop.merch-payments');

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

export interface NewAttempt {
  orderId: string;
  accountId: string;
  attemptId: string;
  pg: ShopPg;
  payMethod: string | null;
  nowMs: number;
  /** 다시 돌려줄 응답 본문(JSON). 멱등 기록의 결과 참조로 둔다 */
  responseJson: string;
}

/** 승인 명령 작업(merch_confirm_job) */
export interface ConfirmJob {
  orderId: string;
  attemptId: string;
  attemptNo: number;
  pg: ShopPg;
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
  amount: number;
  reason: string;
  status: 'REQUESTED' | 'CANCEL_PENDING' | 'CANCELLED' | 'REJECTED';
  createdAtMs: number;
  alerted: boolean;
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
  /** 다음 시각이 된 REQUESTED·CANCEL_PENDING 환급 */
  dueRefunds(nowMs: number, limit: number): Promise<RefundRow[]>;
  /** 환급 결과 반영. CANCELLED면 항목 CANCELLED → REFUNDED와 환급 금액. 그 밖은 상태와 다음 시각 */
  refundResult(refundId: string, outcome: CancelOutcome, nowMs: number, o?: { alerted?: boolean }): Promise<void>;
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
