// 받는 층: 팬 굿즈 주문(openapi shop 태그 createShopOrder·listShopOrders·getShopOrder·createShopOrderPayment·createShopOrderPaymentAcceptance·getShopOrderPaymentStatus,
// BUILD_ORDER LCH-010, ADR-0300). 팬 쿠키의 계정으로만 처리하고, 남의 주문과 없는 주문은 같은 404다. 쓰기 셋은 Idempotency-Key를 플랫폼 멱등 모듈로 다룬다.
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateShopOrderBody,
  CreateShopOrderPaymentAcceptanceBody,
  CreateShopOrderPaymentAcceptanceParams,
  CreateShopOrderPaymentBody,
  CreateShopOrderPaymentParams,
  CreateShopOrderPaymentResponse,
  CreateShopOrderResponse,
  GetShopOrderParams,
  GetShopOrderPaymentStatusParams,
  GetShopOrderPaymentStatusResponse,
  GetShopOrderResponse,
  ListShopOrdersQueryParams,
  ListShopOrdersResponse,
} from '@peaket/contracts/openapi/shop';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { CreateMerchOrder, type CreatedOrderView, type CreateShopOrderInput } from '../application/create-merch-order.js';
import { MerchOrdersRead, type PaymentStatusView } from '../application/merch-orders-read.js';
import { MerchPayment, type PaymentAttemptView } from '../application/merch-payment.js';
import type { AcceptBody } from '../domain/merch-order.js';
import { shopGuard } from '../application/shop-problems.js';

const NoBody = z.null();

@Controller('v1/shop/orders')
export class ShopOrderController {
  constructor(
    private readonly orders: CreateMerchOrder,
    private readonly payment: MerchPayment,
    private readonly read: MerchOrdersRead,
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
}
