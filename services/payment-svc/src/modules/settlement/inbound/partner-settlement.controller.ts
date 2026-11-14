// 받는 층: 파트너 정산서·이의·정산 계좌(openapi getPartnerEventSettlements·listPartnerProductSettlements·
// createPartnerSettlementDispute·putPartnerPayoutAccount, FR-062, POL-039, ADR-0047·0062).
import { Controller, Get, Headers, HttpCode, Post, Put, Res } from '@nestjs/common';
import {
  CreatePartnerSettlementDisputeBody,
  CreatePartnerSettlementDisputeParams,
  GetPartnerEventSettlementsParams,
  GetPartnerEventSettlementsResponse,
  ListPartnerProductSettlementsQueryParams,
  ListPartnerProductSettlementsResponse,
  PutPartnerPayoutAccountBody,
  PutPartnerPayoutAccountResponse,
} from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, idempotencyKeyInvalid, parseIdempotencyKey, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Settlements } from '../application/settlements.js';

const NoBody = z.null();

type Reply = { header(name: string, value: string): unknown };
type EventParams = { eventId: string };
type ProductQuery = { from?: string | undefined; to?: string | undefined; pgStore?: 'STANDARD' | 'ESCROW' | undefined; cursor?: string | undefined; limit?: number | undefined };
type DisputeParams = { statementId: string };
type DisputeBody = { reasonCode: 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER'; detail?: string | undefined };
type PayoutAccountBody = { bankCode: string; accountNumber: string; holderName: string };

export function tenantOf(me: Principal): string {
  if (!me.tenantId) throw new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다' });
  return me.tenantId;
}

@Controller('v1/partner')
export class PartnerSettlementController {
  constructor(private readonly settlements: Settlements) {}

  @Get('events/:eventId/settlements')
  @ContractRouteSchema({ responses: { 200: GetPartnerEventSettlementsResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async eventSettlements(@ContractParams(GetPartnerEventSettlementsParams) params: EventParams, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.listEvent(tenantOf(me), params.eventId.toLowerCase());
  }

  @Get('product-settlements')
  @ContractRouteSchema({ responses: { 200: ListPartnerProductSettlementsResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async productSettlements(@ContractQuery(ListPartnerProductSettlementsQueryParams) q: ProductQuery, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.listProduct(tenantOf(me), {
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.pgStore !== undefined ? { pgStore: q.pgStore } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit ?? 20,
    });
  }

  @Post('settlements/:statementId/disputes')
  @HttpCode(202)
  @ContractRouteSchema({ responses: { 202: NoBody } })
  @Roles(['partner_admin'])
  async dispute(
    @ContractParams(CreatePartnerSettlementDisputeParams) params: DisputeParams,
    @ContractBody(CreatePartnerSettlementDisputeBody) body: DisputeBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: Reply,
  ) {
    if (!parseIdempotencyKey(idempotencyKey)) throw idempotencyKeyInvalid();
    void reply.header('cache-control', 'no-store');
    await this.settlements.dispute(tenantOf(me), me.accountId, params.statementId.toLowerCase(), body);
  }

  @Put('payout-account')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: PutPartnerPayoutAccountResponse } })
  @Roles(['partner_admin'])
  async payoutAccount(
    @ContractBody(PutPartnerPayoutAccountBody) body: PayoutAccountBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: Reply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.putPayoutAccount(tenantOf(me), me.sessionId, body, ifMatch, reauthToken);
  }
}
