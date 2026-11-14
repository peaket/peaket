// 받는 층: 파트너 웹훅 관리(openapi partner webhooks, SCR-025, FR-025, docs/features/notify.md §9).
import { Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import {
  CreatePartnerWebhookBody,
  CreatePartnerWebhookDeliveryRedeliveryParams,
  CreatePartnerWebhookDeliveryRedeliveryResponse,
  CreatePartnerWebhookResponse,
  CreatePartnerWebhookSecretRotationParams,
  CreatePartnerWebhookSecretRotationResponse,
  ListPartnerWebhookDeliveriesParams,
  ListPartnerWebhookDeliveriesQueryParams,
  ListPartnerWebhookDeliveriesResponse,
  ListPartnerWebhooksResponse,
  UpdatePartnerWebhookBody,
  UpdatePartnerWebhookParams,
  UpdatePartnerWebhookResponse,
} from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Webhooks } from '../application/webhooks.js';
import { tenantOf } from '../../catalog/index.js';

@Controller('v1/partner')
export class PartnerWebhookController {
  constructor(private readonly webhooks: Webhooks) {}

  @Post('webhooks')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: CreatePartnerWebhookResponse } })
  @Roles(['partner_admin'])
  async create(
    @ContractBody(CreatePartnerWebhookBody) body: z.output<typeof CreatePartnerWebhookBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.webhooks.create(tenantOf(me), body);
  }

  @Get('webhooks')
  @ContractRouteSchema({ responses: { 200: ListPartnerWebhooksResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async list(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return { items: await this.webhooks.list(tenantOf(me)), nextCursor: null };
  }

  @Patch('webhooks/:endpointId')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: UpdatePartnerWebhookResponse } })
  @Roles(['partner_admin'])
  async update(
    @ContractParams(UpdatePartnerWebhookParams) params: z.output<typeof UpdatePartnerWebhookParams>,
    @ContractBody(UpdatePartnerWebhookBody) body: z.output<typeof UpdatePartnerWebhookBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    const ifMatch = request.headers['if-match'];
    return this.webhooks.update(tenantOf(me), params.endpointId, body, typeof ifMatch === 'string' ? ifMatch : undefined);
  }

  @Post('webhooks/:endpointId/secret-rotations')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: CreatePartnerWebhookSecretRotationResponse } })
  @Roles(['partner_admin'])
  async rotate(
    @ContractParams(CreatePartnerWebhookSecretRotationParams) params: z.output<typeof CreatePartnerWebhookSecretRotationParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.webhooks.rotate(tenantOf(me), params.endpointId);
  }

  @Get('webhooks/:endpointId/deliveries')
  @ContractRouteSchema({ responses: { 200: ListPartnerWebhookDeliveriesResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async deliveries(
    @ContractParams(ListPartnerWebhookDeliveriesParams) params: z.output<typeof ListPartnerWebhookDeliveriesParams>,
    @ContractQuery(ListPartnerWebhookDeliveriesQueryParams) q: z.output<typeof ListPartnerWebhookDeliveriesQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.webhooks.deliveries(tenantOf(me), params.endpointId, q.status, q.limit ?? 20);
  }

  @Post('webhook-deliveries/:deliveryId/redeliveries')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: CreatePartnerWebhookDeliveryRedeliveryResponse } })
  @Roles(['partner_admin'])
  async redeliver(
    @ContractParams(CreatePartnerWebhookDeliveryRedeliveryParams) params: z.output<typeof CreatePartnerWebhookDeliveryRedeliveryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.webhooks.redeliver(tenantOf(me), params.deliveryId);
  }
}
