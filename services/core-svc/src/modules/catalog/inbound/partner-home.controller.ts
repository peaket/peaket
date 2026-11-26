// 받는 층: F-07-12 파트너 홈·공연 목록·개요·판매자 정보 읽기(SCR-062·063, HOT-260).
// openapi `listPartnerProductions`·`getPartnerTodoSummary`·`getPartnerProduction`·`getPartnerSellerProfile`을 구현한다.
// partner_admin·partner_member만 읽고, 테넌트는 identity가 준 값만 쓴다(authz-matrix §3.3). 응답은 성공·오류 모두 no-store다.
import { Controller, Get, Header } from '@nestjs/common';
import { GetPartnerProductionResponse, GetPartnerSellerProfileResponse, GetPartnerTodoSummaryResponse, ListPartnerProductionsQueryParams, ListPartnerProductionsResponse } from '@peaket/contracts/openapi/partner';
import { ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { notFound } from '../application/problems.js';
import { PartnerHomeRead, type PartnerProductionDetail, type PartnerProductionPage, type PartnerSellerProfile, type PartnerTodoSummary } from '../application/partner-home.js';
import { tenantOf } from './partner-production.controller.js';

/** 계약의 공연 ID 경로 칸(문자열). 모양이 틀린 ID도 저장소가 없는 공연으로 답한다(같은 404). */
export const PartnerHomeParams = z.object({ productionId: z.string() }).strict();

@Controller('v1/partner')
export class PartnerHomeController {
  constructor(private readonly read: PartnerHomeRead) {}

  @Get('productions')
  @ContractRouteSchema({ responses: { 200: ListPartnerProductionsResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @Header('Cache-Control', 'no-store')
  async list(
    @ContractQuery(ListPartnerProductionsQueryParams.strict()) query: z.output<typeof ListPartnerProductionsQueryParams>,
    @CurrentPrincipal() me: Principal,
  ): Promise<PartnerProductionPage> {
    return this.read.list(tenantOf(me), {
      limit: query.limit ?? 20,
      ...(query.saleReview !== undefined ? { saleReview: query.saleReview } : {}),
      ...(query.hasApprovalHistory !== undefined ? { hasApprovalHistory: query.hasApprovalHistory } : {}),
      ...(query.saleStatus !== undefined ? { saleStatus: query.saleStatus } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
  }

  @Get('todo-summary')
  @ContractRouteSchema({ responses: { 200: GetPartnerTodoSummaryResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @Header('Cache-Control', 'no-store')
  todo(@CurrentPrincipal() me: Principal): Promise<PartnerTodoSummary> {
    return this.read.todo(tenantOf(me));
  }

  @Get('productions/:productionId')
  @ContractRouteSchema({ responses: { 200: GetPartnerProductionResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @Header('Cache-Control', 'no-store')
  async detail(@ContractParams(PartnerHomeParams) params: z.output<typeof PartnerHomeParams>, @CurrentPrincipal() me: Principal): Promise<PartnerProductionDetail> {
    const found = await this.read.detail(params.productionId, tenantOf(me));
    if (!found) throw notFound();
    return found;
  }

  @Get('seller-profile')
  @ContractRouteSchema({ responses: { 200: GetPartnerSellerProfileResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @Header('Cache-Control', 'no-store')
  async seller(@CurrentPrincipal() me: Principal): Promise<PartnerSellerProfile> {
    const found = await this.read.seller(tenantOf(me));
    if (!found) throw notFound();
    return found;
  }
}
