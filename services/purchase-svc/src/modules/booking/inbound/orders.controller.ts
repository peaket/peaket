// 받는 층: 주문 생성(openapi POST /v1/orders, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161). 팬 경로라 게이트웨이가 넘긴 신원(계정)과
// 구매 권한(ticket:buy)을 쓰고, 계정은 플랫폼 인증 가드의 신원으로만 정한다. 응답은 캐시하지 않는다(Cache-Control: no-store, 오류 응답도).
// 검사 차례(플랫폼 인증 가드): 신원 → 역할·스코프 → 멱등 키 형식(400 idempotency-key-invalid) → 구매 요청 서명(401) → 경로 스키마(400) → 처리기.
// 좌석 홀드(inventory holds.controller.ts)와 같은 장식자 묶음이다. 경로 스키마(@ContractRouteSchema, 미리 만든 Ajv 검사기)로 보고 Zod 파이프를 함께 달지 않는다(ADR-0176 결정 4).
import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import {
  ContractRouteSchema,
  COOKIE_CHALLENGE,
  CurrentPrincipal,
  CurrentPurchaseSession,
  IdempotencyRequest,
  Idempotent,
  type Principal,
  ProblemError,
  PurchaseSigned,
  RequestValidationError,
  Roles,
  requestContext,
} from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ACCEPT_PAYMENT_OPERATION, AcceptPayment, type AcceptPaymentRejection } from '../application/accept-payment.js';
import { CREATE_ORDER_OPERATION, CreateOrder, type CreateOrderRejection } from '../application/create-order.js';
import { ORDER_STATUSES } from '../domain/order.js';
import type { OrderView } from '../domain/ports.js';

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
export function throwOrderProblem(reason: CreateOrderRejection, reply: { header(name: string, value: string): unknown }): never {
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
 * 금액 대조(400)·시도 대조(409)는 쓰임새가 검사 차례대로 가린다
 */
export const PaymentAcceptRequest = z.union([
  z.object({ pg: z.enum(['TOSS', 'SIMULATOR']), paymentKey: paymentRef(), amount: z.int() }).strict(),
  z.object({ pg: z.enum(['PORTONE']), paymentId: paymentRef(), paymentToken: paymentRef(), txId: paymentRef() }).strict(),
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

@Controller('v1/orders')
export class OrdersController {
  constructor(
    @Inject(CreateOrder) private readonly createOrder: CreateOrder,
    @Inject(AcceptPayment) private readonly acceptPayment: AcceptPayment,
  ) {}

  /**
   * 주문 생성. 처리는 CreateOrder.execute 하나다: 201이면 orderResponseOf(order), 거절이면 throwOrderProblem. 그 밖의 오류는 그대로(500·플랫폼 Problem).
   * execute에 넘기는 값: accountId·loginSessionId = me.accountId·me.sessionId, token = { pid: me.pid, scopes: me.scopes }, purchaseSessionId, idem,
   * body, deadline = requestContext()?.deadline(있을 때만). 응답 머리: Cache-Control: no-store(오류 응답도)
   */
  @Post()
  @HttpCode(201)
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
    throwOrderProblem(r.reason, reply);
  }

  /**
   * 결제 접수(202, 본문 없음). 처리는 AcceptPayment.execute 하나다: 202면 아무것도 돌려주지 않고, 거절이면 throwAcceptProblem. 그 밖의 오류는 그대로(500·플랫폼 Problem).
   * execute에 넘기는 값: accountId = me.accountId, purchaseSessionId, orderId(경로 값 그대로), idem, body, deadline = requestContext()?.deadline(있을 때만).
   * 응답 머리: Cache-Control: no-store(오류 응답도). 결제 참조·토큰은 응답·로그에 싣지 않는다
   */
  @Post(':orderId/payment-acceptance')
  @HttpCode(202)
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
}
