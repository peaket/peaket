// 받는 층: 주문 생성(openapi POST /v1/orders, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161). 팬 경로라 게이트웨이가 넘긴 신원(계정)과
// 구매 권한(ticket:buy)을 쓰고, 계정은 플랫폼 인증 가드의 신원으로만 정한다. 응답은 캐시하지 않는다(Cache-Control: no-store, 오류 응답도).
// 검사 차례(플랫폼 인증 가드): 신원 → 역할·스코프 → 멱등 키 형식(400 idempotency-key-invalid) → 구매 요청 서명(401) → 경로 스키마(400) → 처리기.
// 좌석 홀드(inventory holds.controller.ts)와 같은 장식자 묶음이다. 경로 스키마(@ContractRouteSchema, 미리 만든 Ajv 검사기)로 보고 Zod 파이프를 함께 달지 않는다(ADR-0176 결정 4).
import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
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

@Controller('v1/orders')
export class OrdersController {
  constructor(@Inject(CreateOrder) private readonly createOrder: CreateOrder) {}

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
}
