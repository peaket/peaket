// 받는 층: 팬 굿즈 주문(openapi shop 태그 createShopOrder·listShopOrders·getShopOrder·createShopOrderPayment·createShopOrderPaymentAcceptance·getShopOrderPaymentStatus,
// BUILD_ORDER LCH-010, ADR-0300). 팬 쿠키의 계정으로만 처리하고, 남의 주문과 없는 주문은 같은 404다. 쓰기 셋은 Idempotency-Key를 플랫폼 멱등 모듈로 다룬다.
import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
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
import { MerchCancel, type CancellationView } from '../application/merch-cancel.js';
import { MerchOrdersRead, type PaymentStatusView } from '../application/merch-orders-read.js';
import { MerchPayment, type PaymentAttemptView } from '../application/merch-payment.js';
import { MerchReturn } from '../application/merch-return.js';
import type { AcceptBody } from '../domain/merch-order.js';
import { shopGuard } from '../application/shop-problems.js';

const NoBody = z.null();

@Controller('v1/shop/orders')
export class ShopOrderController {
  constructor(
    private readonly orders: CreateMerchOrder,
    private readonly payment: MerchPayment,
    private readonly read: MerchOrdersRead,
    private readonly cancelOrder: MerchCancel,
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
    return shopGuard(() => this.cancelOrder.run(me.accountId, me.sessionId, p.orderId, { itemIds: body.itemIds, refundAccount: body.refundAccount }, once, token));
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
