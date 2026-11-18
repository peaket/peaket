// 굿즈·티켓 연동 부가 상품 주문의 규칙(BUILD_ORDER LCH-010·LCH-020, BAT-600, ADR-0300·ADR-0301, docs/planning/03 §2.13 O1~O7·I1~I18).
// 주문 검사 차례·금액 계산·전이 판정·미수령 대상 판정을 맡는 순수 함수와 형, 상수다. 저장·Redis·gRPC는 포트(merch-ports.ts) 뒤에 있다.
import { commonAttributesOf, optionsMatch } from '@peaket/validation/product-types';
import { nextBusinessDay, kstDateOf } from './business-day.js';
import type { MerchItemStatus, MerchPgStore } from './merch.js';
import { statusOf, type Fulfillment, type ProductRecord } from './product.js';

/** 재고 예약 시간 15분 [가정](ADR-0107 결정 4, ADR-0300 결정 4) */
export const STOCK_RESERVATION_MS = 15 * 60 * 1000;
/** 승인 기한: 인증(결제 접수) + 10분(ADR-0300 결정 5) */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
/** 주문마다 결제 시도 상한 3회 [가정](ADR-0300 결정 5) */
export const MAX_PAYMENT_ATTEMPTS = 3;
/** 접수한 주문의 예약 원소를 만료 작업이 다시 읽기까지 미루는 시간 60초 [가정](ADR-0300 결정 7) */
export const ACCEPTED_EXPIRY_DEFER_MS = 60 * 1000;
/** 재고 키 수명: 판매 종료 + 1일 [가정], 판매 종료가 없으면 30일 [가정](ADR-0300 결정 3) */
export const STOCK_KEY_AFTER_SALE_MS = 24 * 60 * 60 * 1000;
export const STOCK_KEY_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;
/** 승인 명령 데드라인 200ms(ADR-0300 결정 5) */
export const CONFIRM_DEADLINE_MS = 200;
/** 승인 명령 다시 보내기 간격: 1초부터 두 배씩 30초 [가정]까지(ADR-0300 결정 5) */
export const CONFIRM_RETRY_BASE_MS = 1_000;
export const CONFIRM_RETRY_MAX_MS = 30_000;
/** 결과 당기기 다음 시각(ADR-0300 결정 6): 아직 2초 [가정], 결과 모름 30초, 입금 대기 60초, payment-svc가 답하지 못하면 묶음을 5초 [가정] 미룸 */
export const PULL_PENDING_MS = 2_000;
export const PULL_UNKNOWN_MS = 30_000;
export const PULL_DEPOSIT_MS = 60_000;
export const PULL_FAILURE_DEFER_MS = 5_000;
/** 결과 당기기 한 번에 잡는 작업 100건 [가정] */
export const PULL_BATCH = 100;
/** 만료 작업이 상품마다 읽는 예약 원소 100개 [가정] */
export const EXPIRY_BATCH = 100;
/** 결제 상태 long polling 최대 25초 [가정], DB를 1초 [가정]마다 다시 읽음(ADR-0300 결정 8) */
export const PAYMENT_STATUS_WAIT_MS = 25_000;
export const PAYMENT_STATUS_POLL_MS = 1_000;
/** 환급 다시 부르기 10분 [가정], 3일 [가정] 넘으면 SEV2(ADR-0301 결정 5) */
export const REFUND_RETRY_MS = 10 * 60 * 1000;
export const REFUND_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;
/** 미수령 자동 취소 시각 10:00 KST [가정](분) */
export const UNCLAIMED_RUN_MINUTE_KST = 10 * 60;
/** 미수령 취소 사유 */
export const UNCLAIMED_REASON = 'UNCLAIMED';

export type ShopOrderStatus = 'CREATED' | 'AWAITING_DEPOSIT' | 'PAID' | 'EXPIRED' | 'FAILED';
export type ShopPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
export type AttemptStatus = 'READY' | 'ACCEPTED' | 'SUPERSEDED' | 'EXPIRED' | 'FAILED';

export interface ShopOrder {
  orderId: string;
  accountId: string;
  promoterId: string;
  /** 현장 수령은 시간대의 회차, 부가 상품은 연결 회차. 택배는 null */
  eventId: string | null;
  fulfillment: Fulfillment;
  status: ShopOrderStatus;
  /** 결제 금액(원). 상품 가격 × 수량 합과 택배 배송비 한 번 */
  amount: number;
  shippingFee: number;
  pgStore: MerchPgStore;
  pg: ShopPg | null;
  paymentId: string | null;
  stockReservedUntil: Date;
  consentVersion: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  deliveryAddress: string | null;
  pickupSlotId: string | null;
  escrow: boolean;
  orderedAt: Date;
  paidAt: Date | null;
  purchaseConfirmedAt: Date | null;
}

export interface ShopOrderItem {
  itemId: string;
  orderId: string;
  promoterId: string;
  eventId: string | null;
  productId: string;
  productName: string;
  quantity: number;
  /** 주문 때 가격(원) */
  unitAmount: number;
  commissionRateBp: number;
  status: MerchItemStatus;
  fulfillment: Fulfillment;
  ticketLinked: boolean;
  /** 한정 상품이면 true(재고 예약·차감 대상) */
  limited: boolean;
  /** 고른 옵션과 상품 이름·유형·스키마 판(ADR-0101 결정 7) */
  optionSnapshot: { options: Record<string, string>; name: string; type: string; schemaVersion: number };
  linkedTicketId: string | null;
  cancelReason: string | null;
  refundedAmount: number;
  pickedUpAt: Date | null;
  eventEndsAt: Date | null;
}

export interface MerchAttempt {
  attemptId: string;
  orderId: string;
  attemptNo: number;
  pg: ShopPg;
  payMethod: string | null;
  status: AttemptStatus;
  createdAt: Date;
  acceptedAt: Date | null;
}

/** 한정 상품 한 줄(예약·되돌림 대상) */
export interface LimitedLine {
  productId: string;
  quantity: number;
}

/** 주문 하나와 그 항목·활성 시도·수령 시간대 */
export interface ShopOrderDetail {
  order: ShopOrder;
  items: ShopOrderItem[];
  /** READY 또는 ACCEPTED 시도(있으면 하나). ACCEPTED가 먼저다 */
  activeAttempt: MerchAttempt | undefined;
  /** 만든 시도 수(대체·만료 포함) */
  attemptCount: number;
  pickupWindow: { startsAt: Date; endsAt: Date } | null;
}

/** 주문 상태 한 줄(만료 작업·같은 상품의 새 주문이 본다) */
export interface OrderState {
  orderId: string;
  accountId: string;
  status: ShopOrderStatus;
  /** 결제를 접수했는가(ACCEPTED 시도가 있음) */
  accepted: boolean;
  stockReservedUntilMs: number;
  limited: LimitedLine[];
}

/** 조건부 전이로 바뀐 주문과 Redis에서 풀 한정 상품 */
export interface ReleasedOrder {
  orderId: string;
  /** 주문 계정(unpaid 칸을 지울 때 쓴다) */
  accountId: string;
  limited: LimitedLine[];
}

/** 주문 만들기에 쓰는 상품(core_app으로 읽은 상품 행과 스키마 판) */
export interface OrderableProduct extends ProductRecord {
  schemaVersion: number;
}

export interface PickupSlotRecord {
  slotId: string;
  productId: string;
  eventId: string;
  startsAt: Date;
  endsAt: Date;
  ticketHoldersOnly: boolean;
}

/** 멱등 요청 값(플랫폼 IdempotencyRequest와 같은 모양) */
export interface IdempotencyRef {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}

export interface OrderLineInput {
  productId: string;
  quantity: number;
  options?: Record<string, string> | undefined;
}

/**
 * 굿즈 주문의 업무 거절(도메인 층은 프레임워크를 모른다). 받는 층이 Problem 응답으로 바꾼다(application/shop-problems.ts).
 * status 400은 이름 없는 요청 오류(about:blank)이고 type은 까닭이다
 */
export class ShopProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = 'ShopProblem';
  }
}

const unprocessable = (type: string, title: string) => new ShopProblem(type, 422, title);
const conflict = (type: string, title: string) => new ShopProblem(type, 409, title);

export const merchOrderMixed = () => unprocessable('merch-order-mixed', '한 주문에는 한 판매자·한 수령 방식의 상품만 담습니다');
export const merchProductUnavailable = () => unprocessable('merch-product-unavailable', '지금 주문할 수 없는 상품입니다');
export const merchOptionsInvalid = () => unprocessable('merch-options-invalid', '고른 옵션이 상품에 맞지 않습니다');
export const merchQuantityLimitExceeded = () => unprocessable('merch-quantity-limit-exceeded', '계정당 살 수 있는 수량을 넘었습니다');
export const pickupSlotUnavailable = () => unprocessable('pickup-slot-unavailable', '고를 수 없는 수령 시간대입니다');
export const consentRequired = () => unprocessable('consent-required', '배송 정보 판매자 제공 동의가 필요합니다');
export const consentVersionOutdated = () => unprocessable('consent-version-outdated', '동의 문안이 바뀌었습니다. 다시 동의해 주세요');
export const merchSoldOut = () => conflict('merch-sold-out', '품절된 상품이 있습니다');
export const merchOrderInProgress = () => new ShopProblem('merch-order-in-progress', 409, '같은 상품의 다른 주문을 만드는 중입니다', 1);
export const orderExpired = () => conflict('order-expired', '결제하지 않아 주문이 만료되었습니다');
export const paymentAlreadyAccepted = () => conflict('payment-already-accepted', '이미 결제를 접수한 주문입니다');
export const paymentAttemptsExceeded = () => conflict('payment-attempts-exceeded', '결제 시도 횟수를 넘었습니다');
export const paymentAttemptMismatch = () => conflict('payment-attempt-mismatch', '결제 시도가 맞지 않습니다');
export const paymentNotAccepted = () => conflict('payment-not-accepted', '아직 결제를 접수하지 않은 주문입니다');
export const pgUnavailable = (retryAfterSeconds = 2) => new ShopProblem('pg-unavailable', 503, '결제사를 잠시 쓸 수 없습니다', retryAfterSeconds);
export const dependencyUnavailable = (retryAfterSeconds = 1) => new ShopProblem('dependency-unavailable', 503, '잠시 뒤 다시 시도해 주세요', retryAfterSeconds);
/** 금액 불일치는 이름 없는 400(about:blank)이다(티켓 결제 접수와 같다) */
export const amountMismatch = () => new ShopProblem('amount_mismatch', 400, '결제 금액이 주문 금액과 다릅니다');
/** 이름 없는 400(요청 오류) */
export const badRequest = (reason: string) => new ShopProblem(reason, 400, '요청이 올바르지 않습니다');
export const orderNotFound = () => new ShopProblem('not-found', 404, '찾을 수 없습니다');

/** 주문 경로(일반 굿즈·부가 상품) */
export type OrderPath = 'shop' | 'addon';

/**
 * 주문 항목 검사(ADR-0300 결정 4, ADR-0301 결정 2). 차례: 상품 있음·판매 중·수령 방식·티켓 연동(⑥) → 한 판매자·한 수령 방식(①) → 옵션(⑤).
 * 계정당 한도(④)는 저장된 주문 수량이 필요해 checkPerAccountLimit이 따로 본다.
 * @throws ShopProblem 422 merch-product-unavailable·merch-order-mixed·merch-options-invalid
 */
export function checkOrderLines(path: OrderPath, fulfillment: Fulfillment, lines: readonly OrderLineInput[], products: ReadonlyMap<string, OrderableProduct>, nowMs: number): void {
  const now = new Date(nowMs);
  for (const line of lines) {
    const p = products.get(line.productId);
    if (!p) throw merchProductUnavailable();
    if (p.status !== 'PUBLISHED') throw merchProductUnavailable();
    const view = statusOf(p, now);
    // 품절(SOLD_OUT)은 재고 예약이 409로 가른다. 판매 전·판매 끝은 422다
    if (view !== 'ON_SALE' && view !== 'SOLD_OUT') throw merchProductUnavailable();
    if (!p.fulfillments.includes(fulfillment)) throw merchProductUnavailable();
    if (path === 'shop' && p.ticketLinked) throw merchProductUnavailable();
    if (path === 'addon' && (!p.ticketLinked || p.linkedEventId === null)) throw merchProductUnavailable();
  }
  const sellers = new Set(lines.map((l) => products.get(l.productId)!.promoterId));
  if (sellers.size !== 1) throw merchOrderMixed();
  for (const line of lines) {
    const p = products.get(line.productId)!;
    if (!optionsMatch(commonAttributesOf(p.attributes).options, line.options)) throw merchOptionsInvalid();
  }
}

/** 상품 ID마다 모든 줄의 수량 합(같은 상품을 옵션·수량만 다른 여러 줄로 보내도 한 상품으로 센다, ADR-0300 결정 4) */
export function quantitiesByProduct(lines: readonly OrderLineInput[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.productId, (out.get(l.productId) ?? 0) + l.quantity);
  return out;
}

/**
 * 계정당 한도: 이 주문의 그 상품 수량(모든 줄의 합) + 그 계정의 PAID·결제 접수한 주문 수량 ≤ perAccountLimit(ADR-0300 결정 4). 한도가 없으면(null) 보지 않는다.
 * @throws ShopProblem 422 merch-quantity-limit-exceeded
 */
export function checkPerAccountLimit(lines: readonly OrderLineInput[], products: ReadonlyMap<string, OrderableProduct>, committed: ReadonlyMap<string, number>): void {
  for (const [productId, quantity] of quantitiesByProduct(lines)) {
    const limit = commonAttributesOf(products.get(productId)!.attributes).perAccountLimit;
    if (limit === null) continue;
    if (quantity + (committed.get(productId) ?? 0) > limit) throw merchQuantityLimitExceeded();
  }
}

/** 주문 금액: 항목마다 상품 가격 × 수량, 택배면 배송비 한 번(같은 판매자라 상품 가운데 가장 큰 배송비 [정함]) */
export function orderAmount(fulfillment: Fulfillment, lines: readonly OrderLineInput[], products: ReadonlyMap<string, OrderableProduct>): { amount: number; shippingFee: number } {
  const goods = lines.reduce((s, l) => s + products.get(l.productId)!.price * l.quantity, 0);
  const shippingFee = fulfillment === 'DELIVERY' ? Math.max(0, ...lines.map((l) => products.get(l.productId)!.shippingFee ?? 0)) : 0;
  return { amount: goods + shippingFee, shippingFee };
}

/** 재고 키 수명(초): 판매 종료 + 1일 [가정], 판매 종료가 없으면 30일 [가정]. 이미 지났으면 1일 */
export function stockKeyTtlSeconds(saleEndsAt: Date | null, nowMs: number): number {
  const until = saleEndsAt ? saleEndsAt.getTime() + STOCK_KEY_AFTER_SALE_MS : nowMs + STOCK_KEY_DEFAULT_MS;
  return Math.max(Math.ceil((until - nowMs) / 1000), Math.ceil(STOCK_KEY_AFTER_SALE_MS / 1000));
}

/** 결제 접수 뒤 예약 시각: 지금 값과 인증(접수) 시각 + 10분 가운데 늦은 쪽(ADR-0300 결정 5) */
export function reservedUntilAfterAccept(current: Date, authenticatedAtMs: number): Date {
  return new Date(Math.max(current.getTime(), authenticatedAtMs + CONFIRM_WINDOW_MS));
}

/** 결제 시도 시작을 막는 까닭(없으면 undefined). 차례: 상태 → 만료 → 접수함 → 시도 수 */
export function attemptStartBlocker(d: Pick<ShopOrderDetail, 'order' | 'activeAttempt' | 'attemptCount'>, nowMs: number): ShopProblem | undefined {
  if (d.activeAttempt?.status === 'ACCEPTED' || d.order.status === 'PAID' || d.order.status === 'AWAITING_DEPOSIT') return paymentAlreadyAccepted();
  if (d.order.status !== 'CREATED' || d.order.stockReservedUntil.getTime() <= nowMs) return orderExpired();
  if (d.attemptCount >= MAX_PAYMENT_ATTEMPTS) return paymentAttemptsExceeded();
  return undefined;
}

/** 결제 접수 본문 */
export type AcceptBody =
  | { pg: 'TOSS' | 'SIMULATOR'; paymentKey: string; amount: number; attemptId?: string | undefined }
  | { pg: 'PORTONE'; paymentId: string; paymentToken: string; txId: string; attemptId?: string | undefined };

/** 결제 참조(승인 명령 작업에 넣는 값. 로그에 싣지 않는다) */
export type PaymentRef = { kind: 'toss'; paymentKey: string } | { kind: 'portone'; paymentId: string; txId: string; paymentToken: string };

/** 결제 참조 글자 규칙: 1~200자 [가정]의 보이는 ASCII(openapi PaymentAcceptToss·PaymentAcceptPortone) */
const VISIBLE_ASCII = /^[\x21-\x7e]{1,200}$/;

/** 포트원 결제 ID(결제 시도 응답의 paymentId와 같은 꼴) */
export const portonePaymentIdOf = (orderId: string): string => `pay-${orderId}`;

/**
 * 결제 접수를 막는 까닭(없으면 undefined). 차례: 상태·접수함 → 만료 → READY 시도·결제사·attemptId → 금액(토스)·paymentId(포트원).
 * 만료면 결제사를 부르지 않는다(ADR-0300 결정 5)
 */
export function acceptBlocker(d: Pick<ShopOrderDetail, 'order' | 'activeAttempt'>, body: AcceptBody, nowMs: number): ShopProblem | undefined {
  if (d.activeAttempt?.status === 'ACCEPTED' || d.order.status === 'PAID' || d.order.status === 'AWAITING_DEPOSIT') return paymentAlreadyAccepted();
  if (d.order.status !== 'CREATED' || d.order.stockReservedUntil.getTime() <= nowMs) return orderExpired();
  const a = d.activeAttempt;
  if (!a || a.status !== 'READY') return paymentAttemptMismatch();
  if (body.attemptId !== undefined && body.attemptId.toLowerCase() !== a.attemptId) return paymentAttemptMismatch();
  const bodyPg = body.pg;
  if (bodyPg !== a.pg) return paymentAttemptMismatch();
  if (body.pg === 'PORTONE') {
    if (body.paymentId !== portonePaymentIdOf(d.order.orderId)) return paymentAttemptMismatch();
  } else if (body.amount !== d.order.amount) return amountMismatch();
  return undefined;
}

/** 결제 참조 글자 검사(400). 맞으면 참조를, 틀리면 undefined */
export function paymentRefOf(body: AcceptBody): PaymentRef | undefined {
  if (body.pg === 'PORTONE') {
    if (![body.paymentId, body.txId, body.paymentToken].every((v) => VISIBLE_ASCII.test(v))) return undefined;
    return { kind: 'portone', paymentId: body.paymentId, txId: body.txId, paymentToken: body.paymentToken };
  }
  return VISIBLE_ASCII.test(body.paymentKey) ? { kind: 'toss', paymentKey: body.paymentKey } : undefined;
}

/** 승인 명령 다시 보내기 간격: 1초부터 두 배씩 30초 [가정]까지(tries는 이미 보낸 횟수, 1부터) */
export function confirmRetryDelayMs(tries: number): number {
  return Math.min(CONFIRM_RETRY_MAX_MS, CONFIRM_RETRY_BASE_MS * 2 ** Math.max(0, tries - 1));
}

/** 주문번호 [가정]: 주문 ID의 앞 12자리 16진수를 대문자로(예매번호와 같은 꼴은 정해지지 않았다, openapi MerchOrderSummary.orderNumber) */
export const orderNumberOf = (orderId: string): string => `M${orderId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;

/**
 * 미수령 취소 대상인가(ADR-0301 결정 5): 그 상품·그 회차의 마지막 시간대가 끝난 KST 날짜 D에 대해, 오늘이 D 다음 영업일이거나 그 뒤면 참.
 * 날짜는 글자(YYYY-MM-DD)로 견준다(같은 꼴이라 글자 차례가 날짜 차례다)
 */
export function unclaimedDue(lastSlotEndsAtMs: number, nowMs: number): boolean {
  if (lastSlotEndsAtMs > nowMs) return false;
  return kstDateOf(nowMs) >= nextBusinessDay(kstDateOf(lastSlotEndsAtMs));
}
