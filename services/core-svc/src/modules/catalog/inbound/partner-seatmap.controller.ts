// 받는 층: 좌석맵 불러오기·저장(openapi getPartnerProductionSeatmap·putPartnerProductionSeatmap, ADR-0260, BUILD_ORDER HOT-240).
// 파트너 관리자·실무자. 테넌트는 플랫폼 인증 가드가 identity에서 받은 값만 쓴다(본문에 소유·판·승인 상태 칸이 없다, seat-hold ASVS 8.2.3·15.3.3).
// 저장 본문은 계약 SeatMapLayoutInput(닫힘, 정의 밖 칸 400)이고 12MiB [가정]까지 받는다. 요청 하나의 힙이 커서 좌석맵 저장만의 칸막이(파드당 2 [가정],
// 이미지 올리기·좌석맵 가져오기 칸막이와 따로)를 본문을 읽기 전에 잡고 처리기가 끝날 때까지 쥔다(ADR-0260 결정 11, 리뷰 C3·C4). 두 경로의 응답은 성공·오류 모두
// Cache-Control: no-store다(모듈의 미들웨어가 단다).
// 응답은 프레임워크의 JSON 직렬화기로만 만든다.
import { Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';
import { CreatePartnerProductionSeatmapBody, CreatePartnerProductionSeatmapResponse } from '@peaket/contracts/openapi/partner';
import { SeatMapLayoutInput } from '@peaket/contracts/openapi/model';
import { BodyLimit, ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles, RouteDeadline } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SeatmapLayouts } from '../application/seatmap-layouts.js';
import { SeatmapTemplates } from '../application/seatmap-templates.js';
import { LAYOUT_ROUTE_DEADLINE_MS, LAYOUT_SAVE_BULKHEAD, LAYOUT_SAVE_MAX_BYTES, type LayoutInput, layoutEtag, type SeatMapLayoutView } from '../domain/seatmap-layout.js';
import { ProductionParams, tenantOf } from './partner-production.controller.js';

/** 계약 getPartnerProductionSeatmap 쿼리(fromTemplate 하나, 정의 밖 쿼리는 400) */
export const SeatmapQuery = z.object({ fromTemplate: z.string().max(64).optional() }).strict();

@Controller('v1/partner/productions')
export class PartnerSeatmapController {
  constructor(
    private readonly layouts: SeatmapLayouts,
    private readonly templates: SeatmapTemplates,
  ) {}

  @Get(':productionId/seatmap')
  @Roles(['partner_admin', 'partner_member'])
  async load(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @ContractQuery(SeatmapQuery) query: z.output<typeof SeatmapQuery>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SeatMapLayoutView> {
    const out = await this.layouts.load({
      productionId: params.productionId.toLowerCase(),
      who: { tenantId: tenantOf(me), accountId: me.accountId },
      ...(query.fromTemplate !== undefined ? { fromTemplate: query.fromTemplate.toLowerCase() } : {}),
    });
    void reply.header('etag', layoutEtag(out.layoutVersion));
    return out;
  }

  @Post(':productionId/seatmap')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: CreatePartnerProductionSeatmapResponse } })
  @Roles(['partner_admin', 'partner_member'])
  @RouteDeadline(LAYOUT_ROUTE_DEADLINE_MS)
  async create(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @ContractBody(CreatePartnerProductionSeatmapBody) body: z.output<typeof CreatePartnerProductionSeatmapBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SeatMapLayoutView> {
    const out = await this.templates.create({
      productionId: params.productionId.toLowerCase(),
      who: { tenantId: tenantOf(me), accountId: me.accountId },
      role: me.role ?? '',
      templateId: body.templateId.toLowerCase(),
      targetCapacity: body.targetCapacity,
      ...(body.variant !== undefined ? { variant: body.variant as Record<string, unknown> } : {}),
      replace: body.replace,
    });
    void reply.header('etag', layoutEtag(out.layoutVersion));
    return out;
  }

  @Put(':productionId/seatmap')
  @Roles(['partner_admin', 'partner_member'])
  @RouteDeadline(LAYOUT_ROUTE_DEADLINE_MS)
  @BodyLimit(LAYOUT_SAVE_MAX_BYTES, { bulkhead: LAYOUT_SAVE_BULKHEAD })
  async save(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @ContractBody(SeatMapLayoutInput) body: z.output<typeof SeatMapLayoutInput>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SeatMapLayoutView> {
    const ifMatch = request.headers['if-match'];
    const out = await this.layouts.save({
      productionId: params.productionId.toLowerCase(),
      who: { tenantId: tenantOf(me), accountId: me.accountId },
      role: me.role ?? '',
      ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
      body: body as unknown as LayoutInput,
    });
    void reply.header('etag', layoutEtag(out.layoutVersion));
    return out;
  }
}
