// 받는 층: 팬 굿즈 주문(openapi shop 태그 createShopOrder·listShopOrders·getShopOrder·createShopOrderPayment·createShopOrderPaymentAcceptance·getShopOrderPaymentStatus,
// BUILD_ORDER LCH-010, ADR-0300). 팬 쿠키의 계정으로만 처리하고, 남의 주문과 없는 주문은 같은 404다. 쓰기 셋은 Idempotency-Key를 플랫폼 멱등 모듈로 다룬다.
import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CreateShopCancellationAccountBody,
  CreateShopCancellationAccountParams,
  CreateShopCancellationAccountResponse,
  CreateShopOrderBody,
  CreateShopOrderCancellationBody,
  CreateShopOrderCancellationHeader,
  CreateShopOrderCancellationParams,
  CreateShopOrderCancellationResponse,
  CreateShopOrderPaymentAcceptanceBody,
  CreateShopOrderPaymentAcceptanceParams,
  CreateShopOrderPaymentBody,
  CreateShopOrderPaymentParams,
  CreateShopOrderPaymentResponse,
  CreateShopOrderResponse,
  CreateShopOrderReturnBody,
  CreateShopOrderReturnParams,
  CreateShopOrderReturnResponse,
  GetShopOrderParams,
  GetShopOrderPaymentStatusParams,
  GetShopOrderPaymentStatusResponse,
  GetShopOrderResponse,
  ListShopOrdersQueryParams,
  ListShopOrdersResponse,
} from '@peaket/contracts/openapi/shop';
import { ContractBody, ContractHeaders, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { CreateMerchOrder, type CreatedOrderView, type CreateShopOrderInput } from '../application/create-merch-order.js';
import { MerchCancel, RefundResultWriteFailed, type CancellationView } from '../application/merch-cancel.js';
import { MerchOrdersRead, type PaymentStatusView } from '../application/merch-orders-read.js';
import { MerchPayment, type PaymentAttemptView } from '../application/merch-payment.js';
import { MerchRefundAccount } from '../application/merch-refund-account.js';
import { MerchReturn } from '../application/merch-return.js';
import { MerchCancelNotAllowed, ReauthRequired, merchCancelNotAllowed, reauthRequired, reauthUnavailable, refundAccountRequired, refundRejected, type AcceptBody } from '../domain/merch-order.js';
import { ReauthUnavailable } from '../domain/merch-ports.js';
import { shopGuard, toPlatformProblem } from '../application/shop-problems.js';

const NoBody = z.null();
// 재인증 토큰은 없으면 403 reauth-required로 답해야 하므로 계약의 필수 머리 대신 선택 칸으로 받는다(사용 사례가 본다, R-T43 ②)
const ShopAccountHeaders = z.object({ 'Idempotency-Key': z.uuid(), 'X-Reauth-Token': z.string().optional() });

@Controller('v1/shop/orders')
export class ShopOrderController {
  constructor(
    private readonly orders: CreateMerchOrder,
    private readonly payment: MerchPayment,
    private readonly read: MerchOrdersRead,
    private readonly cancelOrder: MerchCancel,
    private readonly refundAccount: MerchRefundAccount,
    private readonly returnOrder: MerchReturn,
  ) {}

  @Post()
  @ContractRouteSchema({ responses: { 201: CreateShopOrderResponse } })
  @Roles(['fan'])
  @HttpCode(201)
  @Idempotent({ operation: 'CREATE_MERCH_ORDER' })
  async create(@ContractBody(CreateShopOrderBody) body: z.output<typeof CreateShopOrderBody>, @CurrentPrincipal() me: Principal, @IdempotencyRequest() once: IdempotencyRequest): Promise<CreatedOrderView> {
    return shopGuard(() => this.orders.shop(me.accountId, body as CreateShopOrderInput, once));
  }

  @Get()
  @ContractRouteSchema({ responses: { 200: ListShopOrdersResponse } })
  @Roles(['fan'])
  async list(@ContractQuery(ListShopOrdersQueryParams) q: z.output<typeof ListShopOrdersQueryParams>, @CurrentPrincipal() me: Principal) {
    return shopGuard(() => this.read.list(me.accountId, q.limit ?? 20, q.cursor));
  }

  @Get(':orderId')
  @ContractRouteSchema({ responses: { 200: GetShopOrderResponse } })
  @Roles(['fan'])
  async get(@ContractParams(GetShopOrderParams) p: z.output<typeof GetShopOrderParams>, @CurrentPrincipal() me: Principal) {
    return shopGuard(() => this.read.get(me.accountId, p.orderId));
  }

  @Post(':orderId/payments')
  @ContractRouteSchema({ responses: { 201: CreateShopOrderPaymentResponse } })
  @Roles(['fan'])
  @HttpCode(201)
  @Idempotent({ operation: 'START_MERCH_PAYMENT' })
  async startPayment(
    @ContractParams(CreateShopOrderPaymentParams) p: z.output<typeof CreateShopOrderPaymentParams>,
    @ContractBody(CreateShopOrderPaymentBody) body: z.output<typeof CreateShopOrderPaymentBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ): Promise<PaymentAttemptView> {
    return shopGuard(() => this.payment.start(me.accountId, p.orderId, { payMethod: body.payMethod }, once));
  }

  @Post(':orderId/payment-acceptance')
  @ContractRouteSchema({ responses: { 202: NoBody } })
  @Roles(['fan'])
  @HttpCode(202)
  @Idempotent({ operation: 'ACCEPT_MERCH_PAYMENT' })
  async accept(
    @ContractParams(CreateShopOrderPaymentAcceptanceParams) p: z.output<typeof CreateShopOrderPaymentAcceptanceParams>,
    @ContractBody(CreateShopOrderPaymentAcceptanceBody) body: z.output<typeof CreateShopOrderPaymentAcceptanceBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ): Promise<void> {
    await shopGuard(() => this.payment.accept(me.accountId, p.orderId, body as AcceptBody, once));
  }

  @Get(':orderId/payment-status')
  @ContractRouteSchema({ responses: { 200: GetShopOrderPaymentStatusResponse } })
  @Roles(['fan'])
  async status(@ContractParams(GetShopOrderPaymentStatusParams) p: z.output<typeof GetShopOrderPaymentStatusParams>, @CurrentPrincipal() me: Principal): Promise<PaymentStatusView> {
    return shopGuard(() => this.read.paymentStatus(me.accountId, p.orderId));
  }

  @Post(':orderId/cancellations')
  @ContractRouteSchema({ params: CreateShopOrderCancellationParams, headers: CreateShopOrderCancellationHeader, body: CreateShopOrderCancellationBody, responses: { 202: CreateShopOrderCancellationResponse } })
  @Roles(['fan'])
  @HttpCode(202)
  @Idempotent({ operation: 'CANCEL_MERCH_ORDER' })
  async cancel(
    @ContractParams(CreateShopOrderCancellationParams) p: z.output<typeof CreateShopOrderCancellationParams>,
    @ContractBody(CreateShopOrderCancellationBody) body: z.output<typeof CreateShopOrderCancellationBody>,
    @ContractHeaders(CreateShopOrderCancellationHeader) headers: z.output<typeof CreateShopOrderCancellationHeader>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
    @Req() request: FastifyRequest,
  ): Promise<CancellationView> {
    const token = typeof request.headers['x-reauth-token'] === 'string' ? request.headers['x-reauth-token'] : headers['X-Reauth-Token'];
    try {
      return await shopGuard(() => this.cancelOrder.run(me.accountId, me.sessionId, p.orderId, { itemIds: body.itemIds, refundAccount: body.refundAccount }, once, token));
    } catch (e) {
      // 계좌 필요·PG 거절 outcome의 DB 실패는 422로 답해 422를 숨기지 않는다(RV-35).
      // 결제사 취소 성공(CANCELLED·CANCEL_PENDING·UNKNOWN)의 DB 실패만 202 REFUND_PENDING이고 재시도가 끝낸다.
      if (e instanceof RefundResultWriteFailed) {
        if (e.outcome === 'REFUND_ACCOUNT_REQUIRED' || e.outcome === 'REJECTED') throw toPlatformProblem(refundAccountRequired());
        return { cancellationId: e.cancellationId, status: 'REFUND_PENDING', refundAmount: e.refundAmount };
      }
      throw e;
    }
  }

  @Post(':orderId/cancellations/:cancellationId/account')
  @ContractRouteSchema({
    params: CreateShopCancellationAccountParams,
    headers: ShopAccountHeaders,
    body: CreateShopCancellationAccountBody,
    responses: { 202: CreateShopCancellationAccountResponse },
  })
  @Roles(['fan'])
  @HttpCode(202)
  @Idempotent({ operation: 'SHOP_CANCEL_REFUND_ACCOUNT' })
  async retryCancellationAccount(
    @ContractParams(CreateShopCancellationAccountParams) p: z.output<typeof CreateShopCancellationAccountParams>,
    @ContractBody(CreateShopCancellationAccountBody) body: z.output<typeof CreateShopCancellationAccountBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
    @Req() request: FastifyRequest,
  ): Promise<CancellationView> {
    const token = typeof request.headers['x-reauth-token'] === 'string' ? request.headers['x-reauth-token'] : undefined;
    try {
      return await shopGuard(() =>
        this.refundAccount.run({
          accountId: me.accountId,
          sessionId: me.sessionId,
          orderId: p.orderId,
          cancellationId: p.cancellationId,
          account: { bankCode: body.bankCode, accountNumber: body.accountNumber, holderName: body.holderName },
          reauthToken: token,
          idempotencyKey: once.key,
          once,
        }),
      );
    } catch (e) {
      if (e instanceof MerchCancelNotAllowed) throw toPlatformProblem(merchCancelNotAllowed());
      if (e instanceof ReauthRequired) throw toPlatformProblem(reauthRequired());
      if (e instanceof ReauthUnavailable) throw toPlatformProblem(reauthUnavailable());
      // 계좌 필요·PG 거절 결과의 DB 실패는 422로 답해 422를 숨기지 않는다(결제사 취소가 나간 경우만 202 REFUND_PENDING)
      if (e instanceof RefundResultWriteFailed) {
        if (e.outcome === 'REFUND_ACCOUNT_REQUIRED') throw toPlatformProblem(refundAccountRequired());
        if (e.outcome === 'REJECTED') throw toPlatformProblem(refundRejected());
        return { cancellationId: e.cancellationId, status: 'REFUND_PENDING', refundAmount: e.refundAmount };
      }
      throw e;
    }
  }

  @Post(':orderId/returns')
  @ContractRouteSchema({ params: CreateShopOrderReturnParams, body: CreateShopOrderReturnBody, responses: { 200: CreateShopOrderReturnResponse } })
  @Roles(['fan'])
  @HttpCode(200)
  @Idempotent({ operation: 'RETURN_MERCH_ORDER' })
  async requestReturn(
    @ContractParams(CreateShopOrderReturnParams) p: z.output<typeof CreateShopOrderReturnParams>,
    @ContractBody(CreateShopOrderReturnBody) body: z.output<typeof CreateShopOrderReturnBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ) {
    return shopGuard(() => this.returnOrder.run(me.accountId, p.orderId, { itemIds: body.itemIds, reason: body.reason, returnTrackingNo: body.returnTrackingNo }, once));
  }
}
