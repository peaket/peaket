// 받는 층: 판매 정책 규칙 읽기·저장(openapi getPartnerSalePolicy·putPartnerSalePolicy, ADR-0261 결정 2·3, BUILD_ORDER HOT-250).
// 파트너 관리자·실무자. 테넌트는 플랫폼 인증 가드가 identity에서 받은 값만 쓴다. 본문은 계약 SalePolicyPut(닫힘, 깊이 3을 펼친 꼴, 정의 밖 칸 400)이고
// 본문 상한은 플랫폼 기본(1MiB)이다. 뜻 규칙은 유스케이스가 @peaket/validation/sale-policy로 본다(같은 검사를 겹쳐 지킨다).
// 응답은 성공·오류 모두 Cache-Control: no-store다(모듈의 미들웨어가 단다). ETag는 규칙의 판이다.
import { Controller, Get, Put, Req, Res } from '@nestjs/common';
import { PutPartnerSalePolicyBody } from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { SalePolicies, type SalePolicyView } from '../application/sale-policy.js';
import { layoutEtag } from '../domain/seatmap-layout.js';
import { ProductionParams, tenantOf } from './partner-production.controller.js';

@Controller('v1/partner/productions')
export class PartnerSalePolicyController {
  constructor(private readonly policies: SalePolicies) {}

  @Get(':productionId/sale-policy')
  @Roles(['partner_admin', 'partner_member'])
  async read(@ContractParams(ProductionParams) params: z.output<typeof ProductionParams>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<SalePolicyView> {
    const out = await this.policies.read({ productionId: params.productionId.toLowerCase(), who: { tenantId: tenantOf(me), accountId: me.accountId } });
    void reply.header('etag', layoutEtag(out.version));
    return out;
  }

  @Put(':productionId/sale-policy')
  @Roles(['partner_admin', 'partner_member'])
  async save(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @ContractBody(PutPartnerSalePolicyBody) body: z.output<typeof PutPartnerSalePolicyBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ version: number; pending: boolean }> {
    const ifMatch = request.headers['if-match'];
    const out = await this.policies.save({
      productionId: params.productionId.toLowerCase(),
      who: { tenantId: tenantOf(me), accountId: me.accountId },
      role: me.role ?? '',
      ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
      // 계약 검사(모양, 400)를 지난 본문의 원래 값을 평가 함수에 넘긴다. 계약은 깊이 4 이상을 객체로만 받아 걸러진 값이 아니라 원래 값이 칸 위치를 알린다(리뷰 A4)
      rules: (request.body as { rules?: unknown } | undefined)?.rules ?? body.rules,
    });
    void reply.header('etag', layoutEtag(out.version));
    return out;
  }
}
