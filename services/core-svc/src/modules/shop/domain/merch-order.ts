// 굿즈·티켓 연동 부가 상품 주문의 규칙(BUILD_ORDER LCH-010·LCH-020, BAT-600, ADR-0300·ADR-0301, docs/planning/03 §2.13 O1~O7·I1~I18).
// 주문 검사 차례·금액 계산·전이 판정·미수령 대상 판정을 맡는 순수 함수와 형, 상수다. 저장·Redis·gRPC는 포트(merch-ports.ts) 뒤에 있다.
import { commonAttributesOf, optionsMatch } from '@peaket/validation/product-types';
import { nextBusinessDay, kstDateOf } from './business-day.js';
import type { MerchItemStatus, MerchPgStore } from './merch.js';
import type { RefundRow } from './merch-ports.js';
import { statusOf, type Fulfillment, type ProductRecord } from './product.js';

/** 재고 예약 시간 15분 [가정](ADR-0107 결정 4, ADR-0300 결정 4) */
export const STOCK_RESERVATION_MS = 15 * 60 * 1000;
/** 승인 기한: 인증(결제 접수) + 10분(ADR-0300 결정 5) */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
/** 입금 기한 + 10분 [가정]까지 재고를 쥐고, 그때까지 입금이 없으면 끝낸다(ADR-0314, P-T60) */
export const DEPOSIT_GRACE_MS = 10 * 60 * 1000;
/** 입금 기한을 읽지 못했을 때 재고를 쥐는 시간 1시간 [가정](payment §6 '입금 확인의 첫 구현') */
export const DEPOSIT_FALLBACK_MS = 60 * 60 * 1000;
/** 단순 변심 반품 기한: 받은 날부터 7일(POL-016 §1.4) */
export const RETURN_CHANGE_OF_MIND_MS = 7 * 24 * 60 * 60 * 1000;
/** 상품 이상·설명과 다름의 반품 기한: 받은 날부터 3개월(POL-016 §1.4) */
export const RETURN_DEFECT_MONTHS = 3;
/** 굿즈 취소·환급 다시 부르기 간격(분): 1 → 5 → 15 → 60 → 360, 5회 [가정](ADR-0315, P-T64) */
export const REFUND_RETRY_DELAYS_MIN = [1, 5, 15, 60, 360] as const;
export const REFUND_RETRY_MAX = REFUND_RETRY_DELAYS_MIN.length;
/** 결제 상태 조회(GetPayment) 데드라인 300ms [가정](payment §6, ADR-0314) */
export const GET_PAYMENT_DEADLINE_MS = 300;
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
/** 결제 상점. 택배만 에스크로 상점이다(ADR-0313, payment §6 '결제대금예치 선택권') */
export type ShopPaymentStore = MerchPgStore;
/** 에스크로 상점의 허용 수단: 간편결제·휴대폰은 토스 에스크로가 받지 않는다(ADR-0313) */
export const ESCROW_PAY_METHODS = ['CARD', 'TRANSFER', 'VIRTUAL_ACCOUNT'] as const;
/** 일반 상점의 허용 수단: 굿즈는 가상계좌도 받는다(ADR-0314) */
export const STANDARD_PAY_METHODS = ['CARD', 'EASY_PAY', 'TRANSFER', 'MOBILE', 'VIRTUAL_ACCOUNT'] as const;
export type CancelStatus = 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
export type ReturnReason = 'CHANGE_OF_MIND' | 'DEFECT_OR_MISMATCH';
export type RefundKind = 'UNCLAIMED' | 'USER_CANCEL' | 'RETURN';

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
  /** 판매자가 송장을 등록한 시각(I3). BAT-605가 읽는다 */
  shippedAt?: Date | null;
  /** 배송 완료 기록(I6). 반품 기한의 기준이다 */
  deliveredAt?: Date | null;
  /** 반품 요청(I7~I10) */
  returnRequestedAt?: Date | null;
  returnReason?: ReturnReason | string | null;
  returnTrackingNo?: string | null;
  returnReceivedAt?: Date | null;
  rejectReason?: string | null;
  /** 배송 송장(판매자 등록, I3). 읽기만 한다 */
  trackingNo?: string | null;
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

export const merchOrderMixed = () => unprocessable('merch-order-mixed', '판매자나 수령 방식이 다른 상품은 한 주문에 담을 수 없습니다');
export const merchProductUnavailable = () => unprocessable('merch-product-unavailable', '지금 이 방법으로 살 수 없는 상품입니다');
export const merchOptionsInvalid = () => unprocessable('merch-options-invalid', '고를 수 없는 옵션입니다');
export const merchQuantityLimitExceeded = () => unprocessable('merch-quantity-limit-exceeded', '한 계정이 살 수 있는 수량을 넘었습니다');
export const pickupSlotUnavailable = () => unprocessable('pickup-slot-unavailable', '고를 수 없는 수령 시간대입니다');
export const consentRequired = () => unprocessable('consent-required', '동의가 필요합니다');
export const consentVersionOutdated = () => unprocessable('consent-version-outdated', '동의 문안이 바뀌었습니다. 다시 확인해 주세요');
export const merchSoldOut = () => conflict('merch-sold-out', '품절된 상품입니다');
export const merchOrderInProgress = () => new ShopProblem('merch-order-in-progress', 409, '같은 상품의 다른 주문을 처리하고 있습니다. 잠시 뒤 다시 시도해 주세요', 1);
export const orderExpired = () => conflict('order-expired', '결제하지 않아 끝난 주문입니다');
export const paymentAlreadyAccepted = () => conflict('payment-already-accepted', '이 주문의 결제를 이미 접수했습니다');
export const paymentAttemptsExceeded = () => conflict('payment-attempts-exceeded', '결제 시도 횟수를 넘었습니다');
export const paymentAttemptMismatch = () => conflict('payment-attempt-mismatch', '결제 시도와 맞지 않습니다. 결제를 다시 시작해 주세요');
export const paymentNotAccepted = () => conflict('payment-not-accepted', '아직 결제를 접수하지 않은 주문입니다');
export const pgUnavailable = (retryAfterSeconds = 2) => new ShopProblem('pg-unavailable', 503, '결제를 잠시 시작할 수 없습니다', retryAfterSeconds);
export const dependencyUnavailable = (retryAfterSeconds = 1) => new ShopProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds);
/** 금액 불일치는 이름 없는 400(about:blank)이다(티켓 결제 접수와 같다) */
export const amountMismatch = () => new ShopProblem('amount_mismatch', 400, '결제 금액이 주문 금액과 다릅니다');
/** 이름 없는 400(요청 오류) */
export const badRequest = (reason: string) => new ShopProblem(reason, 400, '요청이 올바르지 않습니다');
export const orderNotFound = () => new ShopProblem('not-found', 404, '찾을 수 없습니다');
/** 굿즈 취소를 받을 수 없다(발송·수령 뒤, 결제 전 주문, 이미 취소된 항목, P-T61) */
export const merchCancelNotAllowed = () => conflict('merch-cancel-not-allowed', '지금은 취소할 수 없는 주문입니다');
/** 부가 상품의 연결 회차 입장이 시작됐다(I5, V-T35 ③) */
export const entryStarted = () => conflict('entry-started', '입장이 시작되어 취소할 수 없습니다');
/** 구매 확정 전 에스크로 주문은 주문 전체만 취소·반품한다(ADR-0313, P-T59 ④·P-T62 ③) */
export const escrowPartialNotAllowed = () => conflict('escrow-partial-not-allowed', '결제대금예치 주문은 구매 확정 전에 주문 전체만 취소할 수 있습니다');
/** 반품을 받을 수 없다(수령 전, 기한 경과, 상태 밖, P-T62) */
export const merchReturnNotAllowed = () => conflict('merch-return-not-allowed', '지금은 반품을 요청할 수 없는 항목입니다');
/** 가상계좌 결제인데 환불 계좌가 없다(ADR-0050 결정 3, P-T63 ①) */
export const refundAccountRequired = () => new ShopProblem('refund-account-required', 422, '환불받을 계좌를 입력해 주세요');
/** 계좌를 실어 다시 보낸 환급을 결제사가 업무상 거절했다(ADR-0315, R-T43 ③) */
export const refundRejected = () => new ShopProblem('refund-rejected', 422, '환급이 거절되었습니다');
/** 재인증 토큰이 없거나 틀렸다(ADR-0293, P-T63 ②) */
export const reauthRequired = () => new ShopProblem('reauth-required', 403, '다시 인증해 주세요');
/** 재인증 확인기·jti 저장소를 쓸 수 없다(Retry-After 5초 [가정]) */
export const reauthUnavailable = () => new ShopProblem('reauth-unavailable', 503, '재인증 검증기를 쓸 수 없습니다', 5);

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

// ---- 결제 상점·허용 수단(ADR-0313·ADR-0314, P-T59 ⑤) ----

/** 수령 방식 → 결제 상점: 택배만 에스크로 상점, 현장 수령·부가 상품은 일반 상점 */
export function pgStoreOf(fulfillment: Fulfillment): ShopPaymentStore {
  return fulfillment === 'DELIVERY' ? 'ESCROW' : 'STANDARD';
}

/** 그 결제 상점에서 낼 수 있는 결제수단(에스크로는 간편결제·휴대폰을 뺀다) */
export function payMethodsForStore(store: ShopPaymentStore): readonly string[] {
  return store === 'ESCROW' ? ESCROW_PAY_METHODS : STANDARD_PAY_METHODS;
}

/** 그 상점에서 고를 수 없는 수단인가(에스크로 주문에 EASY_PAY·MOBILE) */
export function payMethodBlockedByStore(store: ShopPaymentStore, payMethod: string | undefined): boolean {
  return payMethod !== undefined && payMethod !== '' && !payMethodsForStore(store).includes(payMethod);
}

// ---- 결제대금예치 상품·가상계좌(ADR-0313·ADR-0314) ----

/** 결제창에 싣는 에스크로 상품(토스 escrowProducts와 같은 모양) */
export interface EscrowLine {
  id: string;
  name: string;
  code: string;
  unitPrice: number;
  quantity: number;
}

/** 주문 항목 → 에스크로 상품 목록(상품 ID·이름·단가·수량, 상품 코드는 비운다) */
export function escrowLinesOf(items: readonly ShopOrderItem[]): EscrowLine[] {
  return items.map((i) => ({ id: i.productId, name: i.productName, code: '', unitPrice: i.unitAmount, quantity: i.quantity }));
}

/** 입금 기한 + 10분 [가정]. 기한을 모르면 지금 + 1시간 [가정] + 10분 */
export function depositDeadlineMs(depositDueAtMs: number | undefined, nowMs: number): number {
  return (depositDueAtMs ?? nowMs + DEPOSIT_FALLBACK_MS) + DEPOSIT_GRACE_MS;
}

/** 다음 날 23:59 KST(ms). 굿즈 가상계좌의 입금 기한 [가정](ADR-0314, docs/planning/03 §2.4) */
export function nextDay2359KstMs(nowMs: number): number {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const next = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 23, 59, 0, 0);
  return next - 9 * 60 * 60 * 1000;
}

// ---- 취소 자격·금액(ADR-0315, POL-016 §1.4, P-T59 ④·P-T61) ----

/** 취소할 항목 고르기 결과 */
export interface CancelSelection {
  items: ShopOrderItem[];
  /** 환급 금액(원). 주문 전체 취소면 처음 배송비 포함 */
  amount: number;
  /** 이 요청이 주문의 모든 항목을 취소하는가 */
  full: boolean;
}

/**
 * 구매자 취소의 항목·자격·금액(ADR-0315). 결제 완료(PAID) 주문의 READY 항목만 받는다.
 * 발송·수령 전 = READY, 부가 상품(WALLET)은 연결 회차 입장 시작 전이다. itemIds가 없으면 READY 항목 전부다.
 * 에스크로 주문은 구매 확정 전에 주문 전체만 받는다(부분이면 escrow-partial-not-allowed).
 * @throws ShopProblem 400 invalid-body(목록 모양) · 404 not-found(그 주문의 항목이 아님) · 409 merch-cancel-not-allowed·entry-started·escrow-partial-not-allowed
 */
export function resolveCancelItems(d: Pick<ShopOrderDetail, 'order' | 'items'>, itemIds: readonly string[] | undefined, entryOpensAtMs: number | undefined, nowMs: number): CancelSelection {
  if (d.order.status !== 'PAID') throw merchCancelNotAllowed();
  if (itemIds !== undefined && (itemIds.length < 1 || itemIds.length > 20 || new Set(itemIds).size !== itemIds.length)) throw badRequest('invalid-body');
  const byId = new Map(d.items.map((i) => [i.itemId, i]));
  let selected: ShopOrderItem[];
  if (itemIds !== undefined) {
    for (const id of itemIds) if (!byId.has(id)) throw orderNotFound();
    selected = itemIds.map((id) => byId.get(id)!);
  } else {
    selected = d.items.filter((i) => i.status === 'READY');
    if (selected.length === 0) throw merchCancelNotAllowed();
  }
  for (const item of selected) {
    if (item.status !== 'READY') throw merchCancelNotAllowed();
    if (item.fulfillment === 'WALLET' && entryOpensAtMs !== undefined && nowMs >= entryOpensAtMs) throw entryStarted();
  }
  const full = cancelCompletesOrder(d, selected);
  if (d.order.pgStore === 'ESCROW' && d.order.purchaseConfirmedAt === null && !full) throw escrowPartialNotAllowed();
  const goods = selected.reduce((s, i) => s + i.quantity * i.unitAmount, 0);
  // 처음 취소가 주문 전체면 주문 금액(처음 배송비 포함)을 쓴다. 앞서 항목을 나눠 취소했으면 이미 환급한 금액을 다시 세지 않고
  // 남은 항목 합 + 처음 배송비를 쓴다(RV-01).
  const anyAlreadyDone = d.items.some((i) => i.status === 'CANCELLED' || i.status === 'REFUNDED');
  const amount = full ? (anyAlreadyDone ? goods + (d.order.shippingFee ?? 0) : d.order.amount) : goods;
  return { items: selected, amount, full };
}

/** 이 요청이 주문의 남은 항목(이미 CANCELLED·REFUNDED가 아닌 항목)을 모두 덮는가(배송비 환급 판정, RV-01) */
export function cancelCompletesOrder(d: Pick<ShopOrderDetail, 'items'>, selected: readonly ShopOrderItem[]): boolean {
  const remaining = d.items.filter((i) => i.status !== 'CANCELLED' && i.status !== 'REFUNDED');
  if (remaining.length === 0) return false;
  const ids = new Set(selected.map((i) => i.itemId));
  return remaining.every((i) => ids.has(i.itemId));
}

/** 그 항목을 지금 취소할 수 있는가(openapi `ShopOrderItem.cancellable`, 최종 판정은 서버) */
export function cancellableOf(item: Pick<ShopOrderItem, 'status' | 'fulfillment'>, entryOpensAtMs: number | undefined, nowMs: number): boolean {
  if (item.status !== 'READY') return false;
  return item.fulfillment !== 'WALLET' || entryOpensAtMs === undefined || nowMs < entryOpensAtMs;
}

// ---- 반품 자격·기한(ADR-0315, POL-016 §1.4, P-T62·V-T35 ③) ----

/** KST 달력 기준으로 개월을 더한다(월말은 그 달 마지막 날로 자른다) */
export function addCalendarMonthsKst(ms: number, months: number): number {
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + months;
  const day = kst.getUTCDate();
  const firstOfTarget = Date.UTC(year, month, 1);
  const daysInTarget = new Date(Date.UTC(new Date(firstOfTarget).getUTCFullYear(), new Date(firstOfTarget).getUTCMonth() + 1, 0)).getUTCDate();
  const target = Date.UTC(new Date(firstOfTarget).getUTCFullYear(), new Date(firstOfTarget).getUTCMonth(), Math.min(day, daysInTarget));
  return target - 9 * 60 * 60 * 1000;
}

/** 반품 기한의 기준 시각: 배송 완료(DELIVERY)·수령 완료(PICKUP). 없으면 null(기한 안으로 받는다) */
export function returnBaseAtMs(item: Pick<ShopOrderItem, 'fulfillment' | 'deliveredAt' | 'pickedUpAt'>): number | null {
  if (item.fulfillment === 'DELIVERY') return item.deliveredAt?.getTime() ?? null;
  if (item.fulfillment === 'PICKUP') return item.pickedUpAt?.getTime() ?? null;
  return null;
}

/** 단순 변심 반품 기한(받은 날 + 7일). 기준 기록이 없으면 null */
export function returnDueAtMs(item: Pick<ShopOrderItem, 'fulfillment' | 'deliveredAt' | 'pickedUpAt'>): number | null {
  const base = returnBaseAtMs(item);
  return base === null ? null : base + RETURN_CHANGE_OF_MIND_MS;
}

/** 상품 이상·설명과 다름의 반품 기한(받은 날 + 3개월). 기준 기록이 없으면 null */
export function defectReturnDueAtMs(item: Pick<ShopOrderItem, 'fulfillment' | 'deliveredAt' | 'pickedUpAt'>): number | null {
  const base = returnBaseAtMs(item);
  return base === null ? null : addCalendarMonthsKst(base, RETURN_DEFECT_MONTHS);
}

/** 그 항목이 지금 반품을 요청할 수 있는 상태인가(기한 포함. 최종 판정은 resolveReturnItems) */
export function returnableOf(item: ShopOrderItem, eventEndsAt: Date | null | undefined, nowMs: number): boolean {
  if (item.fulfillment === 'WALLET') {
    if (item.status !== 'READY' && item.status !== 'LOCKED') return false;
    if (eventEndsAt !== undefined && eventEndsAt !== null && eventEndsAt.getTime() <= nowMs) return false;
    return true;
  }
  if (item.fulfillment === 'DELIVERY') {
    if (item.status === 'SHIPPED') return true;
    if (item.status !== 'DELIVERED') return false;
  } else if (item.status !== 'PICKED_UP') return false;
  const due = defectReturnDueAtMs(item);
  return due === null || nowMs <= due;
}

/**
 * 반품 요청의 항목·자격(ADR-0315). `itemIds`는 1~20개·중복 없음·그 주문의 항목이어야 한다.
 * DELIVERY는 SHIPPED(수취 거부)·DELIVERED, PICKUP은 PICKED_UP, WALLET은 READY·LOCKED이고 입장 시작 뒤에는 이상·다름만 받는다.
 * 단순 변심은 받은 날 + 7일, 이상·다름은 받은 날 + 3개월 안이다. 받은 날 기록이 없으면 기한 안으로 받는다.
 * 에스크로 주문은 구매 확정 전에 주문 전체 항목만 받는다.
 * @throws ShopProblem 400 invalid-body · 404 not-found · 409 merch-return-not-allowed·escrow-partial-not-allowed
 */
export function resolveReturnItems(
  d: Pick<ShopOrderDetail, 'order' | 'items'>,
  itemIds: readonly string[],
  reason: ReturnReason,
  entryOpensAtMs: number | undefined,
  nowMs: number,
): ShopOrderItem[] {
  if (d.order.status !== 'PAID') throw merchReturnNotAllowed();
  if (itemIds.length < 1 || itemIds.length > 20 || new Set(itemIds).size !== itemIds.length) throw badRequest('invalid-body');
  const byId = new Map(d.items.map((i) => [i.itemId, i]));
  for (const id of itemIds) if (!byId.has(id)) throw orderNotFound();
  const selected = itemIds.map((id) => byId.get(id)!);
  for (const item of selected) {
    if (item.fulfillment === 'WALLET') {
      const started = entryOpensAtMs !== undefined && nowMs >= entryOpensAtMs;
      if (item.status !== 'READY' && item.status !== 'LOCKED') throw merchReturnNotAllowed();
      if (started && reason !== 'DEFECT_OR_MISMATCH') throw merchReturnNotAllowed();
    } else if (item.fulfillment === 'DELIVERY') {
      if (item.status !== 'SHIPPED' && item.status !== 'DELIVERED') throw merchReturnNotAllowed();
    } else if (item.status !== 'PICKED_UP') throw merchReturnNotAllowed();
    const base = returnBaseAtMs(item);
    if (base === null) continue;
    if (reason === 'CHANGE_OF_MIND' && nowMs > base + RETURN_CHANGE_OF_MIND_MS) throw merchReturnNotAllowed();
    if (reason === 'DEFECT_OR_MISMATCH' && nowMs > addCalendarMonthsKst(base, RETURN_DEFECT_MONTHS)) throw merchReturnNotAllowed();
  }
  const full = selected.length === d.items.length;
  if (d.order.pgStore === 'ESCROW' && d.order.purchaseConfirmedAt === null && !full) throw escrowPartialNotAllowed();
  return selected;
}

/** 판매자·CS 전이 동작(I11~I15). HTTP는 BAT-610 잔여(7.2.1)가 연다 */
export type SellerReturnAction = 'RECEIVE' | 'REFUND' | 'REJECT' | 'CS_ACCEPT' | 'CS_DENY';

/**
 * 판매자·CS 전이의 도착 상태(I11~I15, planning/03 §2.13). 없으면 그 전이는 받지 않는다.
 * RETURN_REQUESTED에서 바로 REFUNDED로 가지 않고 도착 확인(I11)을 거치며, DISPUTED의 환급은 CS 인정(I14)뿐이다.
 */
export function sellerReturnTransition(from: MerchItemStatus, action: SellerReturnAction): MerchItemStatus | undefined {
  if (from === 'RETURN_REQUESTED' && action === 'RECEIVE') return 'RETURN_RECEIVED';
  if (from === 'RETURN_RECEIVED' && action === 'REFUND') return 'REFUNDED';
  if (from === 'RETURN_RECEIVED' && action === 'REJECT') return 'DISPUTED';
  if (from === 'DISPUTED' && action === 'CS_ACCEPT') return 'REFUNDED';
  if (from === 'DISPUTED' && action === 'CS_DENY') return 'DELIVERED';
  return undefined;
}

/** 굿즈 환급 다시 부르기 다음 간격(ms). attempts는 이미 부른 횟수(처음 요청 뒤 다시 부른 횟수)다. 5회면 null */
export function refundRetryNextDelayMs(attempts: number): number | null {
  if (attempts >= REFUND_RETRY_MAX) return null;
  return REFUND_RETRY_DELAYS_MIN[attempts]! * 60 * 1000;
}

// ---- 지연 환급 계좌 다시 받기(ADR-0316 결정 5, P-T63 ③, R-T43) ----

/** 굿즈 지연 환급 계좌 다시 받기 시도 상한 3회 [가정](ADR-0316 결정 5) */
export const REFUND_ACCOUNT_MAX_ATTEMPTS = 3;
/** 계좌를 다시 받은 시도의 첫 재시도 간격 1분 [가정](MerchCancel 첫 시도와 같다) */
export const REFUND_ACCOUNT_RETRY_MS = 60 * 1000;

/** 계좌를 다시 받을 수 없는 취소다(409 merch-cancel-not-allowed, R-T43 ①) */
export class MerchCancelNotAllowed extends Error {
  constructor(message = '지금은 환급 계좌를 다시 받을 수 없는 취소입니다') {
    super(message);
    this.name = 'MerchCancelNotAllowed';
  }
}

/** 재인증 토큰이 없거나 틀렸다(403 reauth-required, R-T43 ②) */
export class ReauthRequired extends Error {
  constructor(message = '다시 인증해 주세요') {
    super(message);
    this.name = 'ReauthRequired';
  }
}

/** 계좌 다시 받기 대상: 사슬의 끝 행과 그 행까지 새로 받은 횟수 */
export interface RefundAccountRetryTarget {
  /** 지금 다시 받아야 할 환급 행. 옛 행을 가리키면 그 사슬을 따라 앞으로 간 끝 행이다 */
  row: RefundRow;
  /** 원래 행이 0이고, 계좌를 다시 받을 때마다 1씩 는다(0~2가 다시 받을 수 있고 3은 상한) */
  attemptNo: number;
}

/**
 * 경로의 취소 ID(옛 행일 수 있다)에서 `replaces_refund_id` 사슬을 따라 지금 끝 행을 찾는다.
 * 없으면 undefined(404). 한 번의 다시 받기가 새 행을 만들면 그 뒤 같은 옛 ID로 온 요청은 새 행을 본다.
 * 사슬이 둘로 갈라지는 것은 부분 유일 인덱스가 막지만, 방어적으로 첫 앞 행만 따라가고 100단계에서 멈춘다.
 */
export function refundAccountRetryTarget(rows: readonly RefundRow[], cancellationId: string): RefundAccountRetryTarget | undefined {
  const byId = new Map(rows.map((r) => [r.refundId, r]));
  let row = byId.get(cancellationId);
  if (!row) return undefined;
  for (let i = 0; i < 100; i++) {
    const next = rows.find((r) => r.replacesRefundId === row!.refundId);
    if (!next) break;
    row = next;
  }
  let attemptNo = 0;
  let walk: RefundRow | undefined = row;
  while (walk?.replacesRefundId) {
    attemptNo++;
    walk = byId.get(walk.replacesRefundId);
    if (attemptNo > 100) break;
  }
  return { row, attemptNo };
}

/**
 * 계좌를 다시 받을 수 있는 상태인가(ADR-0316 결정 5, R-T43 ①): 결제사 계좌 거절로 끝난
 * `REJECTED`·`fail_reason = REFUND_ACCOUNT_REQUIRED`·`account_required_at` 있음이고 시도 상한 3회 [가정] 안이다.
 * @throws MerchCancelNotAllowed 409
 */
export function assertRefundAccountRetryable(t: RefundAccountRetryTarget): void {
  if (t.row.status !== 'REJECTED' || t.row.failReason !== 'REFUND_ACCOUNT_REQUIRED' || t.row.accountRequiredAtMs === null) throw new MerchCancelNotAllowed();
  if (t.attemptNo >= REFUND_ACCOUNT_MAX_ATTEMPTS) throw new MerchCancelNotAllowed();
}
