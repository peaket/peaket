// core-svc support 내부 문의 API(F-06-5). ops-svc만 내부 토큰으로 부르고, 문의에 CS 건 ID를 되적는다.
import { Body, Controller, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Inquiries } from '../application/inquiries.js';
import { InternalToken401Guard } from './internal-token-401.guard.js';

const CaseBody = z.object({ caseId: z.string().min(1).max(64) }).strict();

@Controller('internal/v1/inquiries')
@UseGuards(InternalToken401Guard)
export class InternalInquiriesController {
  constructor(private readonly inquiries: Inquiries) {}

  @Post(':inquiryId/case')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: z.object({ changed: z.boolean() }) } })
  async setCase(@Param('inquiryId') inquiryId: string, @Body() raw: unknown) {
    const parsed = CaseBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    return this.inquiries.setCaseId(inquiryId, parsed.data.caseId);
  }
}
