// 받는 층: 판매 자격 명단 목록·올리기·지우기(openapi listPartnerSaleEligibilityLists·createPartnerSaleEligibilityList·deletePartnerSaleEligibilityList,
// ADR-0261 결정 6, BUILD_ORDER HOT-250). 목록은 파트너 관리자·실무자, 올리기·지우기는 파트너 관리자만이다(실무자는 유스케이스가 403 partner-admin-required와
// 실패한 인가 기록을 낸다. 플랫폼 역할 가드의 이름 없는 403을 쓰지 않으려 두 역할을 받는다). 다른 검사보다 소속 확인(404)을 먼저 한다.
// 올리기 본문 상한은 8MiB + 봉투 64KB [가정]이고 넘으면 읽기 전에 413 sale-eligibility-upload-too-large다(플랫폼 @AcceptMultipart).
// 파트너 multipart 칸막이(동시 4 [가정], 이미지·좌석맵 가져오기와 함께 씀)가 차면 429다. 응답은 성공·오류 모두 Cache-Control: no-store다(모듈의 미들웨어).
import { Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { CreatePartnerSaleEligibilityListResponse, ListPartnerSaleEligibilityListsResponse } from '@peaket/contracts/openapi/partner';
import { AcceptMultipart, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles, RouteDeadline } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SaleEligibilityLists, type SaleEligibilityListView, type SaleEligibilityUploadResult } from '../application/sale-eligibility-lists.js';
import { saleEligibilityUploadTooLarge } from '../application/problems.js';
import { PARTNER_MULTIPART_BULKHEAD } from '../domain/production-image.js';
import { LIST_KEY, UPLOAD_ENVELOPE_BYTES, UPLOAD_MAX_BYTES, UPLOAD_ROUTE_DEADLINE_MS } from '../domain/sale-eligibility.js';
import { readUploadForm, requireXRequestedWith } from './multipart.js';
import { ProductionParams, tenantOf } from './partner-production.controller.js';

/** 지우기 204는 본문이 없다(계약 deletePartnerSaleEligibilityList '204': 지움). 응답 스키마 표시가 본문 없음을 적는다(ASVS 15.3.1) */
const NoBody = z.null();

/** 계약 deletePartnerSaleEligibilityList 경로 칸(명단 키 모양이 틀리면 400) */
export const ListParams = z.object({ productionId: z.string(), listKey: z.string().regex(LIST_KEY) }).strict();

@Controller('v1/partner/productions')
export class PartnerSaleEligibilityController {
  constructor(private readonly lists: SaleEligibilityLists) {}

  @Get(':productionId/sale-eligibility-lists')
  @ContractRouteSchema({ responses: { 200: ListPartnerSaleEligibilityListsResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async list(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @CurrentPrincipal() me: Principal): Promise<{ items: SaleEligibilityListView[] }> {
    return this.lists.list({ productionId: params.productionId.toLowerCase(), who: { tenantId: tenantOf(me), accountId: me.accountId } });
  }

  @Post(':productionId/sale-eligibility-lists')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: CreatePartnerSaleEligibilityListResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @RouteDeadline(UPLOAD_ROUTE_DEADLINE_MS)
  @AcceptMultipart({ maxBytes: UPLOAD_MAX_BYTES + UPLOAD_ENVELOPE_BYTES, tooLarge: saleEligibilityUploadTooLarge, bulkhead: PARTNER_MULTIPART_BULKHEAD })
  async upload(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @CurrentPrincipal() me: Principal, @Req() request: FastifyRequest): Promise<SaleEligibilityUploadResult> {
    const who = { tenantId: tenantOf(me), accountId: me.accountId };
    const productionId = params.productionId.toLowerCase();
    await this.lists.authorize(productionId, who, 'upload');
    requireXRequestedWith(request);
    return this.lists.upload({ productionId, who, role: me.role ?? '', form: await readUploadForm(request) });
  }

  @Delete(':productionId/sale-eligibility-lists/:listKey')
  @HttpCode(204)
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['partner_admin', 'partner_member'])
  async remove(@ContractParams(ListParams) params: z.output<typeof ListParams>, @CurrentPrincipal() me: Principal, @Req() request: FastifyRequest): Promise<void> {
    const who = { tenantId: tenantOf(me), accountId: me.accountId };
    const productionId = params.productionId.toLowerCase();
    await this.lists.authorize(productionId, who, 'delete');
    requireXRequestedWith(request);
    await this.lists.remove({ productionId, listKey: params.listKey, who, role: me.role ?? '' });
  }
}
