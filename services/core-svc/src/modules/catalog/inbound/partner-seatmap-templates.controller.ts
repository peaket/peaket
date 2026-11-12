// 받는 층: 좌석맵 템플릿 목록·하나(openapi getPartnerSeatmapTemplates·getPartnerSeatmapTemplate, ADR-0066).
// 파트너 소속 계정이면 관리자·실무자 모두 읽는다. 템플릿은 배포 때 넣은 정적 파일이고, 공개되지 않은 틀·배치본 ID는 404다.
import { Controller, Get, Param } from '@nestjs/common';
import { GetPartnerSeatmapTemplateResponse, GetPartnerSeatmapTemplatesResponse } from '@peaket/contracts/openapi/partner';
import { ContractRouteSchema, Roles } from '@peaket/platform';
import { SeatmapTemplates } from '../application/seatmap-templates.js';

@Controller('v1/partner/seatmap-templates')
export class PartnerSeatmapTemplatesController {
  constructor(private readonly templates: SeatmapTemplates) {}

  @Get()
  @ContractRouteSchema({ responses: { 200: GetPartnerSeatmapTemplatesResponse } })
  @Roles(['partner_admin', 'partner_member'])
  list(): { items: unknown[] } {
    return this.templates.list();
  }

  @Get(':templateId')
  @ContractRouteSchema({ responses: { 200: GetPartnerSeatmapTemplateResponse } })
  @Roles(['partner_admin', 'partner_member'])
  one(@Param('templateId') templateId: string): unknown {
    return this.templates.get(templateId.toLowerCase());
  }
}
