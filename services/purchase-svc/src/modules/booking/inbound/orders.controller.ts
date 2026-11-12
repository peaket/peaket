// 받는 층: 주문 생성(openapi POST /v1/orders, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161), 결제 접수(PRF-162),
// 결제 결과 long polling(GET /v1/orders/{orderId}/payment-status, PRF-166). 팬 경로라 게이트웨이가 넘긴 신원(계정)과
// 구매 권한(ticket:buy)을 쓰고, 계정은 플랫폼 인증 가드의 신원으로만 정한다. 응답은 캐시하지 않는다(Cache-Control: no-store, 오류 응답도).
// 검사 차례(플랫폼 인증 가드): 신원 → 역할·스코프 → 멱등 키 형식(400 idempotency-key-invalid) → 구매 요청 서명(401) → 경로 스키마(400) → 처리기.
// 좌석 홀드(inventory holds.controller.ts)와 같은 장식자 묶음이다. 경로 스키마(@ContractRouteSchema, 미리 만든 Ajv 검사기)로 보고 Zod 파이프를 함께 달지 않는다(ADR-0176 결정 4).
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post, Res } from '@nestjs/common';
import {
  Bulkhead,
  ContractRouteSchema,
  COOKIE_CHALLENGE,
  CurrentPrincipal,
  CurrentPurchaseSession,
  IdempotencyRequest,
  Idempotent,
  type Principal,
  ProblemError,
  PurchaseSigned,
  LogPolicy,
  RequestValidationError,
  Roles,
  RouteDeadline,
  requestContext,
} from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ACCEPT_PAYMENT_OPERATION, AcceptPayment, type AcceptPaymentRejection } from '../application/accept-payment.js';
import { CREATE_ORDER_OPERATION, CreateOrder, type CreateOrderRejection } from '../application/create-order.js';
import { GetPaymentStatus } from '../application/get-payment-status.js';
import { START_PAYMENT_OPERATION, type StartedPayment, StartPayment, type StartPaymentRejection } from '../application/start-payment.js';
import { ORDER_STATUSES } from '../domain/order.js';
import { START_PAY_METHODS } from '../domain/payment-attempt.js';
import { PAYMENT_STATUS_MAX_DEADLINE_MS, PAYMENT_STATUS_VALUES, type PaymentStatusProblem } from '../domain/payment-status.js';
import type { CheckoutValues, OrderView } from '../domain/ports.js';
import { WRITE_BULKHEAD } from '../../../write-bulkhead.js';

// openapi 모양을 여기 둔다(좌석 홀드·queue-svc와 같은 방식). 요청 본문은 계약처럼 모든 층을 닫는다(.strict(), docs/api/guidelines.md §1 '요청은 닫고 응답은 연다').

/** 계약 머리. 세 칸 모두 플랫폼 모듈이 보고(멱등 키·구매 요청 서명) 경로 스키마에서는 빠진다. 여기 두는 것은 시작 확인(@Idempotent·@PurchaseSigned 요구)을 걸기 위해서다 */
export const OrderHeaders = z.object({
  'Idempotency-Key': z.uuid(),
  'X-Purchase-Seq': z.int().min(1),
  'X-Purchase-Mac': z.string(),
});

/** 고지 문안의 판 모양(openapi CreateOrderBody.consents.consentVersion.pattern) */
export const CONSENT_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;

/**
 * 본문 CreateOrderBody. buyer의 두 칸과 consents는 계약에서 선택 칸이라 여기서는 모양만 본다:
 * 예매자 누락·길이·번호 형식(400)과 동의 누락·판(422)은 쓰임새가 검사 차례대로 가린다(payment §2 '검사 차례')
 */
export const CreateOrderRequest = z
  .object({
    holdId: z.string(),
    buyer: z.object({ name: z.string().optional(), phone: z.string().optional() }).strict(),
    consents: z
      .object({
        provisionToSeller: z.boolean().optional(),
        salesTerms: z.boolean().optional(),
        consentVersion: z.string().regex(CONSENT_VERSION_PATTERN).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CreateOrderRequest = z.output<typeof CreateOrderRequest>;

/**
 * 201 응답 Order(직렬화 스키마. 스키마에 없는 칸은 내보내지 않는다). 계약의 items는 칸을 정하지 않은 객체 배열이라
 * 주문 사건 items와 같은 칸(seatId·tierId·sectionId·price)으로 정했다(추천 적용 대상, PRF-161 뼈대)
 */
export const OrderResponseBody = z.object({
  orderId: z.string(),
  amount: z.int(),
  status: z.enum(ORDER_STATUSES),
  items: z.array(z.object({ seatId: z.string(), tierId: z.string(), sectionId: z.string(), price: z.int() })),
});
export type OrderResponse = z.output<typeof OrderResponseBody>;

/** 대응표 한 줄. type이 'about:blank'이면 이름 없는 HTTP 오류(요청 검사 오류·500)로 낸다 */
export interface OrderProblemSpec {
  status: number;
  type: string;
  title: string;
  /** Retry-After 머리(초) */
  retryAfterSeconds?: number;
  /** 업무상 정상 분기로 센다(오류가 아니라 businessRejections) */
  normalBranch?: boolean;
}

/** 좌석 Redis를 부르기 전 남은 시간이 5ms [가정] 미만이라 부르지 않은 504(openapi deadline-exceeded, guidelines §5, 리뷰 고침 L4). 주문 생성·결제 접수가 함께 쓴다 */
const DEADLINE_EXCEEDED_PROBLEM: OrderProblemSpec = { status: 504, type: 'deadline-exceeded', title: '남은 처리 시간이 모자라 요청을 끝내지 못했습니다' };

/**
 * 거절 → HTTP 문제 상세 대응표(openapi POST /v1/orders 응답 설명과 x-peaket-problem-types의 status·title).
 * SESSION_NOT_FOUND는 플랫폼 구매 요청 확인의 no_session 거절(platform purchase-auth.ts PURCHASE_REJECTION_PROBLEMS, 공개 면에 없어 다시 적는다)과 같은 본문이다. BUYER_INVALID는 요청 검사 실패와 같은 400(about:blank),
 * PRICE_MISSING은 이름 없는 500이다. 503 둘의 Retry-After는 2초 [가정]이다
 */
export const ORDER_PROBLEMS: Readonly<Record<CreateOrderRejection, OrderProblemSpec>> = {
  SESSION_NOT_FOUND: { status: 401, type: 'purchase-session-ended', title: '예매 시간이 끝났습니다' },
  IDEM_REUSED: { status: 422, type: 'idempotency-key-reused', title: '같은 멱등 키를 다른 요청에 썼습니다' },
  HOLD_NOT_FOUND: { status: 404, type: 'not-found', title: '찾을 수 없습니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  SEAT_STORE_UNAVAILABLE: { status: 503, type: 'seat-store-unavailable', title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 },
  CONSENT_REQUIRED: { status: 422, type: 'consent-required', title: '동의가 필요합니다' },
  CONSENT_VERSION_OUTDATED: { status: 422, type: 'consent-version-outdated', title: '동의 문안이 바뀌었습니다. 다시 확인해 주세요' },
  BUYER_INVALID: { status: 400, type: 'about:blank', title: 'Bad Request' },
  IDENTITY_DENIED: { status: 403, type: 'identity-verification-required', title: '휴대폰 본인확인을 먼저 해 주세요' },
  IDENTITY_MISCONFIGURED: { status: 503, type: 'dependency-unavailable', title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 },
  BOOKING_RESTRICTED: { status: 403, type: 'booking-restricted', title: '예매가 제한된 계정입니다' },
  PRICE_MISSING: { status: 500, type: 'about:blank', title: 'Internal Server Error' },
  // 여러 탭이 같은 홀드로 주문을 겹쳐 보낸 경합이라 정상 분기로 센다(좌석 경합 seat-already-held와 같은 셈)
  HOLD_ALREADY_ORDERED: { status: 409, type: 'hold-already-ordered', title: '이 좌석으로 만든 주문이 이미 있습니다', normalBranch: true },
  // 좌석 Redis를 부르기 전 남은 시간이 모자랐다(Retry-After 없음, 좌석 홀드 504와 같다, 리뷰 고침 L4)
  DEADLINE_EXCEEDED: DEADLINE_EXCEEDED_PROBLEM,
};

/** OrderView → 201 본문(items의 unitPrice는 price로) */
export function orderResponseOf(order: OrderView): OrderResponse {
  return {
    orderId: order.orderId,
    amount: order.amount,
    status: order.status,
    items: order.items.map((i) => ({ seatId: i.seatId, tierId: i.tierId, sectionId: i.sectionId, price: i.unitPrice })),
  };
}

/**
 * 거절을 대응표대로 HTTP 오류로 바꿔 던진다(돌아오지 않는다).
 * - 이름 있는 줄: ProblemError(type·status·title·retryAfterSeconds·normalBranch).
 * - SESSION_NOT_FOUND: reply에 WWW-Authenticate: Cookie realm="peaket"(platform COOKIE_CHALLENGE)을 달고 401 purchase-session-ended ProblemError.
 * - BUYER_INVALID: 플랫폼 RequestValidationError(400 about:blank). 어느 칸이 틀렸는지는 싣지 않는다.
 * - PRICE_MISSING: 이름 없는 500(Error. 등급 ID는 응답에 싣지 않는다).
 * 응답의 Cache-Control은 처리기가 이미 no-store로 달았다
 */
export function throwOrderProblem(reason: CreateOrderRejection, reply: { header(name: string, value: string): unknown }, extensions?: Record<string, unknown>): never {
  switch (reason) {
    case 'BUYER_INVALID':
      // 어느 칸이 틀렸는지·받은 값은 싣지 않는다(이유 글도 칸 이름 없이)
      throw new RequestValidationError('예매자 성명·번호가 규칙에 맞지 않는다');
    case 'PRICE_MISSING':
      // 이름 없는 500. 등급 ID는 응답·오류 글에 싣지 않는다(설정 오류 로그가 회차·등급을 남겼다)
      throw new Error('가격이 없는 등급이 있어 주문을 만들지 않았다(설정 오류)');
    case 'SESSION_NOT_FOUND':
      reply.header('www-authenticate', COOKIE_CHALLENGE);
      break;
    default:
      break;
  }
  const spec = ORDER_PROBLEMS[reason];
  throw new ProblemError({
    type: spec.type,
    status: spec.status,
    title: spec.title,
    ...(extensions ? { extensions } : {}),
    ...(spec.retryAfterSeconds !== undefined ? { retryAfterSeconds: spec.retryAfterSeconds } : {}),
    ...(spec.normalBranch ? { normalBranch: true } : {}),
  });
}

// ---- 결제 접수 POST /v1/orders/{orderId}/payment-acceptance(docs/features/payment.md §2 '결제 접수의 첫 구현', BUILD_ORDER PRF-162) ----

/** 경로 값. 계약은 글 칸 하나라 모양은 보지 않는다(소문자 UUID가 아니면 쓰임새가 없는 주문과 같은 404로 답한다) */
export const AcceptParams = z.object({ orderId: z.string() }).strict();

/** 결제 참조 칸(paymentKey·paymentId·paymentToken·txId)의 길이 상한 200자 [가정](리뷰 고침 M1 2026-11-05) */
export const PAYMENT_REF_MAX = 200;
/** 결제 참조 칸의 모양: 보이는 ASCII(0x21~0x7E)만. 공백·제어 문자·ASCII 밖 글자는 받지 않는다 */
export const PAYMENT_REF_PATTERN = /^[\x21-\x7e]+$/;
/** 결제 참조 칸 하나(1~200자의 보이는 ASCII). 틀리면 경로 스키마가 400(about:blank)으로 막아 쓰임새·어댑터까지 가지 않는다 */
const paymentRef = () => z.string().min(1).max(PAYMENT_REF_MAX).regex(PAYMENT_REF_PATTERN);

/**
 * 본문 PaymentAccept(openapi, pg로 갈리는 oneOf. 갈래마다 허용 밖 칸은 400, packages/contracts CreateOrderPaymentAcceptanceBody와 같은 모양).
 * 결제 참조 칸은 계약의 글 칸보다 좁게 1~200자의 보이는 ASCII만 받는다(리뷰 고침 M1. 계약 스키마는 넓은 그대로 두고 설명 글로 적는다).
 * 선택 칸 attemptId는 결제창을 연 시도의 ID(UUID, 리뷰 고침 M2 2026-11-09)이고 있으면 쓰임새가 지금 READY 시도와 대조한다.
 * 금액 대조(400)·시도 대조(409)는 쓰임새가 검사 차례대로 가린다
 */
export const PaymentAcceptRequest = z.union([
  z.object({ pg: z.enum(['TOSS', 'SIMULATOR']), paymentKey: paymentRef(), amount: z.int(), attemptId: z.uuid().optional() }).strict(),
  z.object({ pg: z.enum(['PORTONE']), paymentId: paymentRef(), paymentToken: paymentRef(), txId: paymentRef(), attemptId: z.uuid().optional() }).strict(),
]);
export type PaymentAcceptRequest = z.output<typeof PaymentAcceptRequest>;

/**
 * 거절 → HTTP 문제 상세 대응표(openapi POST /v1/orders/{orderId}/payment-acceptance 응답 설명과 x-peaket-problem-types의 status·title).
 * SESSION_ENDED는 주문 생성의 SESSION_NOT_FOUND와 같은 본문(WWW-Authenticate 머리 포함), AMOUNT_MISMATCH는 요청 검사 실패와 같은 400(about:blank)이다.
 * 두 탭 경합(ALREADY_ACCEPTED)은 정상 분기로 센다. ATTEMPT_MISMATCH는 보안 사건이라 세지 않는다(쓰임새가 보안 로그를 남겼다). 503의 Retry-After는 2초 [가정]이다
 */
export const ACCEPT_PROBLEMS: Readonly<Record<AcceptPaymentRejection, OrderProblemSpec>> = {
  SESSION_ENDED: { status: 401, type: 'purchase-session-ended', title: '예매 시간이 끝났습니다' },
  IDEM_REUSED: { status: 422, type: 'idempotency-key-reused', title: '같은 멱등 키를 다른 요청에 썼습니다' },
  NOT_FOUND: { status: 404, type: 'not-found', title: '찾을 수 없습니다' },
  ORDER_EXPIRED: { status: 409, type: 'order-expired', title: '결제하지 않아 끝난 주문입니다' },
  ALREADY_ACCEPTED: { status: 409, type: 'payment-already-accepted', title: '이 주문의 결제를 이미 접수했습니다', normalBranch: true },
  ATTEMPT_MISMATCH: { status: 409, type: 'payment-attempt-mismatch', title: '결제 시도와 맞지 않습니다. 결제를 다시 시작해 주세요' },
  AMOUNT_MISMATCH: { status: 400, type: 'about:blank', title: 'Bad Request' },
  SALE_PAUSED: { status: 423, type: 'sale-paused', title: '판매가 잠시 멈췄습니다' },
  SEAT_STORE_UNAVAILABLE: { status: 503, type: 'seat-store-unavailable', title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 },
  DEADLINE_EXCEEDED: DEADLINE_EXCEEDED_PROBLEM,
};

/**
 * 결제 접수 거절을 대응표대로 HTTP 오류로 바꿔 던진다(돌아오지 않는다).
 * - 이름 있는 줄: ProblemError(type·status·title·retryAfterSeconds·normalBranch).
 * - SESSION_ENDED: reply에 WWW-Authenticate: Cookie realm="peaket"(platform COOKIE_CHALLENGE)을 달고 401 purchase-session-ended.
 * - AMOUNT_MISMATCH: 플랫폼 RequestValidationError(400 about:blank). 받은 금액·주문 금액은 싣지 않는다.
 * 응답의 Cache-Control은 처리기가 이미 no-store로 달았다
 */
export function throwAcceptProblem(reason: AcceptPaymentRejection, reply: { header(name: string, value: string): unknown }): never {
  switch (reason) {
    case 'AMOUNT_MISMATCH':
      // 받은 금액·주문 금액은 응답·오류 글에 싣지 않는다(쓰임새가 보안 로그 amount_mismatch를 남겼다)
      throw new RequestValidationError('결제 금액이 주문 금액과 맞지 않는다');
    case 'SESSION_ENDED':
      reply.header('www-authenticate', COOKIE_CHALLENGE);
      break;
    default:
      break;
  }
  const spec = ACCEPT_PROBLEMS[reason];
  throw new ProblemError({
    type: spec.type,
    status: spec.status,
    title: spec.title,
    ...(spec.retryAfterSeconds !== undefined ? { retryAfterSeconds: spec.retryAfterSeconds } : {}),
    ...(spec.normalBranch ? { normalBranch: true } : {}),
  });
}

// ---- 결제 시도 시작 POST /v1/orders/{orderId}/payments(docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER PRF-191) ----

/** 경로 값(결제 접수와 같다. 모양은 보지 않는다) */
export const StartPaymentParams = z.object({ orderId: z.string() }).strict();

/** 행동 요약(openapi BehaviorSummary. 요약값만이고 허용 밖 칸은 400이다) */
const BehaviorSummaryBody = z
  .object({
    v: z.literal(1),
    windowMs: z.int().min(0).max(3_600_000),
    pointerMoves: z.int().min(0).optional(),
    pointerEntropy: z.number().min(0).optional(),
    inputIntervalMeanMs: z.number().min(0).optional(),
    inputIntervalStdMs: z.number().min(0).optional(),
    scrollEvents: z.int().min(0).optional(),
    scrollDistancePx: z.int().min(0).optional(),
  })
  .strict();

/** 본문(openapi createOrderPayment. payMethod는 계약의 글 칸보다 좁게 허용 목록만 받는다, 틀리면 400) */
export const StartPaymentRequest = z.object({ payMethod: z.enum(START_PAY_METHODS).optional(), behavior: BehaviorSummaryBody.optional() }).strict();
export type StartPaymentRequest = z.output<typeof StartPaymentRequest>;

/** 응답의 토스·시뮬레이터 결제창 값(openapi TossCheckout) */
const TossCheckoutBody = z.object({
  clientKey: z.string(),
  customerKey: z.string(),
  orderId: z.string(),
  orderName: z.string(),
  amount: z.int(),
  successUrl: z.string(),
  failUrl: z.string(),
});

/** 응답의 포트원 결제창 값(openapi PortoneCheckout) */
const PortoneCheckoutBody = z.object({
  storeId: z.string(),
  channelKey: z.string(),
  paymentId: z.string(),
  orderName: z.string(),
  totalAmount: z.int(),
  currency: z.string(),
  redirectUrl: z.string(),
  customData: z.object({ orderId: z.string() }),
});

/** 201 응답 PaymentAttempt(직렬화 스키마. 스키마에 없는 칸은 내보내지 않는다) */
export const PaymentAttemptBody = z.object({
  attemptId: z.string(),
  pg: z.enum(['TOSS', 'PORTONE', 'SIMULATOR']),
  switched: z.boolean(),
  holdExpiresAt: z.iso.datetime({ offset: true }).optional(),
  allowedPayMethods: z.array(z.string()),
  depositDueAt: z.iso.datetime({ offset: true }).optional(),
  checkout: z.union([TossCheckoutBody, PortoneCheckoutBody]),
});
export type PaymentAttemptResponse = z.output<typeof PaymentAttemptBody>;

/**
 * 거절 → HTTP 문제 상세 대응표(openapi POST /v1/orders/{orderId}/payments 응답 설명과 x-peaket-problem-types의 status·title).
 * 503의 Retry-After는 2초 [가정]이고 새 결제 일시 정지만 5초 [가정]이다(BUILD_ORDER PRF-201). PAY_METHOD_INVALID는 요청 검사 실패와 같은 400(about:blank)이다
 */
export const START_PAYMENT_PROBLEMS: Readonly<Record<StartPaymentRejection, OrderProblemSpec>> = {
  SESSION_ENDED: { status: 401, type: 'purchase-session-ended', title: '예매 시간이 끝났습니다' },
  IDEM_REUSED: { status: 422, type: 'idempotency-key-reused', title: '같은 멱등 키를 다른 요청에 썼습니다' },
  NOT_FOUND: { status: 404, type: 'not-found', title: '찾을 수 없습니다' },
  ORDER_EXPIRED: { status: 409, type: 'order-expired', title: '결제하지 않아 끝난 주문입니다' },
  ALREADY_ACCEPTED: { status: 409, type: 'payment-already-accepted', title: '이 주문의 결제를 이미 접수했습니다', normalBranch: true },
  ATTEMPTS_EXCEEDED: { status: 409, type: 'payment-attempts-exceeded', title: '결제 시도 횟수를 넘었습니다' },
  SALE_PAUSED: { status: 423, type: 'sale-paused', title: '판매가 잠시 멈췄습니다' },
  SEAT_STORE_UNAVAILABLE: { status: 503, type: 'seat-store-unavailable', title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 },
  PG_UNAVAILABLE: { status: 503, type: 'pg-unavailable', title: '결제를 잠시 시작할 수 없습니다', retryAfterSeconds: 2 },
  NEW_PAYMENT_PAUSED: { status: 503, type: 'new-payment-paused', title: '새 결제를 잠시 멈췄습니다', retryAfterSeconds: 5 },
  CHECKOUT_MISCONFIGURED: { status: 503, type: 'dependency-unavailable', title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 },
  PAY_METHOD_INVALID: { status: 400, type: 'about:blank', title: 'Bad Request' },
  DEADLINE_EXCEEDED: DEADLINE_EXCEEDED_PROBLEM,
};

/**
 * 결제 시도 시작 거절을 대응표대로 HTTP 오류로 바꿔 던진다(돌아오지 않는다).
 * - SESSION_ENDED: reply에 WWW-Authenticate: Cookie realm="peaket"을 단다.
 * - PAY_METHOD_INVALID: 플랫폼 RequestValidationError(400 about:blank). 받은 값은 싣지 않는다
 */
export function throwStartPaymentProblem(reason: StartPaymentRejection, reply: { header(name: string, value: string): unknown }, o: { readonly holdRemainingSeconds?: number } = {}): never {
  if (reason === 'PAY_METHOD_INVALID') throw new RequestValidationError('이 회차에서 쓸 수 없는 결제수단이다');
  if (reason === 'SESSION_ENDED') reply.header('www-authenticate', COOKIE_CHALLENGE);
  const spec = START_PAYMENT_PROBLEMS[reason];
  throw new ProblemError({
    type: spec.type,
    status: spec.status,
    title: spec.title,
    ...(spec.retryAfterSeconds !== undefined ? { retryAfterSeconds: spec.retryAfterSeconds } : {}),
    ...(spec.normalBranch ? { normalBranch: true } : {}),
    ...(o.holdRemainingSeconds !== undefined ? { extensions: { holdRemainingSeconds: o.holdRemainingSeconds } } : {}),
  });
}

/** 결제창 값 → 응답 칸. 칸을 하나씩 골라 싣는다(받은 객체를 펼치지 않아 계약 밖 칸이 섞여 들지 않게, ASVS 15.3.1) */
function checkoutBodyOf(c: CheckoutValues): PaymentAttemptResponse['checkout'] {
  if (c.shape === 'TOSS') return { clientKey: c.clientKey, customerKey: c.customerKey, orderId: c.orderId, orderName: c.orderName, amount: c.amount, successUrl: c.successUrl, failUrl: c.failUrl };
  return { storeId: c.storeId, channelKey: c.channelKey, paymentId: c.paymentId, orderName: c.orderName, totalAmount: c.totalAmount, currency: c.currency, redirectUrl: c.redirectUrl, customData: { orderId: c.customData.orderId } };
}

/** 쓰임새의 결과 → 201 본문. 시각은 ISO 8601(UTC, 밀리초) */
export function paymentAttemptResponseOf(a: StartedPayment): PaymentAttemptResponse {
  return {
    attemptId: a.attemptId,
    pg: a.pg,
    switched: a.switched,
    ...(a.holdExpiresAtMs !== undefined ? { holdExpiresAt: new Date(a.holdExpiresAtMs).toISOString() } : {}),
    allowedPayMethods: [...a.allowedPayMethods],
    ...(a.depositDueAtMs !== undefined ? { depositDueAt: new Date(a.depositDueAtMs).toISOString() } : {}),
    checkout: checkoutBodyOf(a.checkout),
  };
}

// ---- 결제 결과 long polling GET /v1/orders/{orderId}/payment-status(docs/features/payment.md §2 '결제 결과 long polling의 첫 구현', BUILD_ORDER PRF-166) ----

/** 경로 값(결제 접수와 같다. 모양은 보지 않는다: 소문자 UUID가 아니면 쓰임새가 없는 주문과 같은 404로 답한다) */
export const PaymentStatusParams = z.object({ orderId: z.string() }).strict();

/**
 * 200 응답 PaymentStatus(직렬화 스키마. 스키마에 없는 칸은 내보내지 않는다, packages/contracts GetOrderPaymentStatusResponse와 같은 모양).
 * 계약은 모든 칸이 선택이지만 서버는 status·issueDelayed를 늘 싣는다(domain PaymentStatusBody)
 */
export const PaymentStatusResponseBody = z.object({
  status: z.enum(PAYMENT_STATUS_VALUES),
  issueDelayed: z.boolean().optional(),
  virtualAccount: z.object({ bank: z.string().optional(), accountNumber: z.string().optional(), dueAt: z.iso.datetime({ offset: true }).optional() }).optional(),
  reason: z.string().optional(),
  pg: z.enum(['TOSS', 'PORTONE', 'SIMULATOR']).optional(),
});
export type PaymentStatusResponse = z.output<typeof PaymentStatusResponseBody>;

/** long polling 거절(쓰임새 결과 404·409를 한 이름으로) */
export type PaymentStatusRejection = 'NOT_FOUND' | PaymentStatusProblem;

/**
 * 거절 → HTTP 문제 상세 대응표(openapi GET /v1/orders/{orderId}/payment-status 응답 설명과 x-peaket-problem-types의 status·title).
 * 남의 주문과 없는 주문은 같은 404 not-found다. [정함] 409 둘은 정상 분기로 세지 않는다(결제 접수의 order-expired와 같다)
 */
export const PAYMENT_STATUS_PROBLEMS: Readonly<Record<PaymentStatusRejection, OrderProblemSpec>> = {
  NOT_FOUND: { status: 404, type: 'not-found', title: '찾을 수 없습니다' },
  NOT_ACCEPTED: { status: 409, type: 'payment-not-accepted', title: '아직 결제를 접수하지 않은 주문입니다' },
  ORDER_EXPIRED: { status: 409, type: 'order-expired', title: '결제하지 않아 끝난 주문입니다' },
};

/** long polling 거절을 대응표대로 ProblemError로 바꿔 던진다(돌아오지 않는다). 응답의 Cache-Control은 처리기가 이미 no-store로 달았다 */
export function throwPaymentStatusProblem(reason: PaymentStatusRejection): never {
  const spec = PAYMENT_STATUS_PROBLEMS[reason];
  throw new ProblemError({ type: spec.type, status: spec.status, title: spec.title });
}

/**
 * 이 경로의 정규 로그 SLO 26초 [가정](@LogPolicy sloLatencyMs, 리뷰 고침 M5). 서비스 기본 SLO로 재면 기다렸다 답한 응답이 모두 'SLO 초과'로 남는다.
 * 기다림 상한 25초 + 답 몫 1초다
 */
export const PAYMENT_STATUS_LOG_SLO_MS = 26_000;

/** clientGoneSignal이 보는 응답 모양(FastifyReply의 일부) */
export interface ClientGoneReply {
  readonly raw: { readonly destroyed?: boolean; once(event: 'close', listener: () => void): unknown };
  readonly request?: { readonly raw: { readonly socket?: { readonly destroyed?: boolean } | null } };
}

/**
 * 브라우저가 연결을 닫으면 끊기는 신호(응답 객체 reply.raw의 close. 응답을 다 보낸 뒤의 close는 상관없다).
 * 만들 때 이미 응답 객체나 요청 소켓이 부서졌으면(destroyed) 곧바로 끊긴 신호다(close를 놓쳤을 수 있다, 리뷰 고침 L2).
 * 쓰임새가 기다림을 곧바로 그만두는 데 쓴다(기다리는 표에 끊긴 요청이 남지 않게)
 */
export function clientGoneSignal(reply: ClientGoneReply): AbortSignal {
  const ac = new AbortController();
  if (reply.raw.destroyed === true || reply.request?.raw.socket?.destroyed === true) {
    ac.abort();
    return ac.signal;
  }
  // 응답을 다 보낸 뒤에도 close가 오지만, 그때는 기다림이 이미 끝나 아무 일도 없다
  reply.raw.once('close', () => ac.abort());
  return ac.signal;
}

@Controller('v1/orders')
export class OrdersController {
  constructor(
    @Inject(CreateOrder) private readonly createOrder: CreateOrder,
    @Inject(AcceptPayment) private readonly acceptPayment: AcceptPayment,
    /** 결제 결과 long polling(PRF-166). BookingModuleDeps.paymentStatus가 없으면 조립하지 않아 undefined다 */
    @Optional() @Inject(GetPaymentStatus) private readonly getPaymentStatus?: GetPaymentStatus,
    /** 결제 시도 시작(PRF-191). BookingModuleDeps.startPayment가 없으면 조립하지 않아 undefined다 */
    @Optional() @Inject(StartPayment) private readonly startPayment?: StartPayment,
  ) {}

  /**
   * 결제 시도 시작(201 PaymentAttempt). 처리는 StartPayment.execute 하나다.
   * [정함] 쓰임새가 조립되지 않았으면(this.startPayment 없음) 404 not-found로 답한다(결제 결과 long polling과 같다)
   */
  @Post(':orderId/payments')
  @HttpCode(201)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Idempotent({ operation: START_PAYMENT_OPERATION })
  @PurchaseSigned()
  @ContractRouteSchema({ params: StartPaymentParams, headers: OrderHeaders, body: StartPaymentRequest, responses: { 201: PaymentAttemptBody } })
  async start(
    @Param('orderId') orderId: string,
    @Body() body: StartPaymentRequest,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @CurrentPurchaseSession() purchaseSessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentAttemptResponse> {
    void reply.header('cache-control', 'no-store');
    if (!this.startPayment) throwStartPaymentProblem('NOT_FOUND', reply);
    const deadline = requestContext()?.deadline;
    const r = await this.startPayment.execute({
      accountId: me.accountId,
      ...(me.pid !== undefined ? { pid: me.pid } : {}),
      purchaseSessionId,
      orderId,
      idem,
      body,
      ...(deadline ? { deadline } : {}),
    });
    if (r.status === 201) return paymentAttemptResponseOf(r.attempt);
    throwStartPaymentProblem(r.reason, reply, r.holdRemainingSeconds === undefined ? {} : { holdRemainingSeconds: r.holdRemainingSeconds });
  }

  /**
   * 주문 생성. 처리는 CreateOrder.execute 하나다: 201이면 orderResponseOf(order), 거절이면 throwOrderProblem. 그 밖의 오류는 그대로(500·플랫폼 Problem).
   * execute에 넘기는 값: accountId·loginSessionId = me.accountId·me.sessionId, token = { pid: me.pid, scopes: me.scopes }, purchaseSessionId, idem,
   * body, deadline = requestContext()?.deadline(있을 때만). 응답 머리: Cache-Control: no-store(오류 응답도)
   */
  @Post()
  @HttpCode(201)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Idempotent({ operation: CREATE_ORDER_OPERATION })
  @PurchaseSigned()
  @ContractRouteSchema({ headers: OrderHeaders, body: CreateOrderRequest, responses: { 201: OrderResponseBody } })
  async create(
    @Body() body: CreateOrderRequest,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @CurrentPurchaseSession() purchaseSessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OrderResponse> {
    void reply.header('cache-control', 'no-store');
    const deadline = requestContext()?.deadline;
    const r = await this.createOrder.execute({
      accountId: me.accountId,
      loginSessionId: me.sessionId,
      token: { ...(me.pid !== undefined ? { pid: me.pid } : {}), scopes: me.scopes },
      purchaseSessionId,
      idem,
      body,
      ...(deadline ? { deadline } : {}),
    });
    if (r.status === 201) return orderResponseOf(r.order);
    throwOrderProblem(r.reason, reply, r.orderId !== undefined ? { orderId: r.orderId } : undefined);
  }

  /**
   * 결제 접수(202, 본문 없음). 처리는 AcceptPayment.execute 하나다: 202면 아무것도 돌려주지 않고, 거절이면 throwAcceptProblem. 그 밖의 오류는 그대로(500·플랫폼 Problem).
   * execute에 넘기는 값: accountId = me.accountId, purchaseSessionId, orderId(경로 값 그대로), idem, body, deadline = requestContext()?.deadline(있을 때만).
   * 응답 머리: Cache-Control: no-store(오류 응답도). 결제 참조·토큰은 응답·로그에 싣지 않는다
   */
  @Post(':orderId/payment-acceptance')
  @HttpCode(202)
  @Bulkhead(WRITE_BULKHEAD)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Idempotent({ operation: ACCEPT_PAYMENT_OPERATION })
  @PurchaseSigned()
  @ContractRouteSchema({ params: AcceptParams, headers: OrderHeaders, body: PaymentAcceptRequest })
  async accept(
    @Param('orderId') orderId: string,
    @Body() body: PaymentAcceptRequest,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @CurrentPurchaseSession() purchaseSessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    const deadline = requestContext()?.deadline;
    const r = await this.acceptPayment.execute({
      accountId: me.accountId,
      purchaseSessionId,
      orderId,
      idem,
      body,
      ...(deadline ? { deadline } : {}),
    });
    if (r.status === 202) return;
    throwAcceptProblem(r.reason, reply);
  }

  /**
   * 결제 결과 long polling(200 PaymentStatus). 처리는 GetPaymentStatus.execute 하나다: 200이면 body, 404면 throwPaymentStatusProblem('NOT_FOUND'),
   * 409면 throwPaymentStatusProblem(r.reason). 그 밖의 오류는 그대로(500·플랫폼 Problem).
   * execute에 넘기는 값: accountId = me.accountId, orderId(경로 값 그대로), deadline = requestContext()?.deadline(있을 때만.
   * 이 경로만 서비스 상한 27초 [가정], @RouteDeadline), signal = clientGoneSignal(reply).
   * 정규 로그 SLO는 26초 [가정](@LogPolicy, 기다린 응답이 SLO 초과로 전부 남지 않게, 리뷰 고침 M5).
   * 멱등 키·구매 세션 서명은 받지 않는다(GET이고, 결제창에서 돌아온 탭이 묻는다. 팬 쿠키만). 응답 머리: Cache-Control: no-store(오류 응답도).
   * [정함] 쓰임새가 조립되지 않았으면(this.getPaymentStatus 없음) 404 not-found로 답한다(경로가 없는 것과 같은 본문)
   */
  @Get(':orderId/payment-status')
  @Roles(['fan'])
  @RouteDeadline(PAYMENT_STATUS_MAX_DEADLINE_MS)
  @LogPolicy({ sloLatencyMs: PAYMENT_STATUS_LOG_SLO_MS })
  @ContractRouteSchema({ params: PaymentStatusParams, responses: { 200: PaymentStatusResponseBody } })
  async paymentStatus(
    @Param('orderId') orderId: string,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentStatusResponse> {
    void reply.header('cache-control', 'no-store');
    // [정함] 쓰임새를 조립하지 않은 앱은 경로가 없는 것과 같은 404다
    if (!this.getPaymentStatus) throwPaymentStatusProblem('NOT_FOUND');
    const deadline = requestContext()?.deadline;
    const r = await this.getPaymentStatus.execute({
      accountId: me.accountId,
      orderId,
      ...(deadline ? { deadline } : {}),
      signal: clientGoneSignal(reply),
    });
    if (r.status === 200) return r.body;
    throwPaymentStatusProblem(r.status === 404 ? 'NOT_FOUND' : r.reason);
  }
}
