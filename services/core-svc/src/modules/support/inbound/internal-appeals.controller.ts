// core-svc support 내부 API(F-06-4). ops-svc만 내부 토큰으로 부른다. 소명 원본 읽기·결과 기록.
import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { InternalToken401Guard } from './internal-token-401.guard.js';
import { z } from 'zod';
import { Appeals } from '../application/appeals.js';

const ResultBody = z
  .object({
    status: z.enum(['DECIDED', 'INVALID']),
    result: z.enum(['LIFTED', 'KEPT', 'ACCEPTED', 'REJECTED']).optional(),
    resultNote: z.string().max(1_000).optional(),
    reason: z.string().max(200).optional(),
    caseId: z.string().max(64).optional(),
  })
  .strict();

/** 내부 읽기 응답. 본문은 ops만 읽는다 */
const InternalAppealView = z.object({
  appealId: z.string(),
  accountId: z.string(),
  kind: z.string(),
  targetId: z.string(),
  body: z.string(),
  submittedAt: z.string(),
  status: z.string(),
  caseId: z.string().nullable(),
});
/** 결과 기록 응답(팬 목록과 같은 모양) */
const AppealView = z.object({
  appealId: z.string(),
  kind: z.string(),
  targetId: z.string(),
  status: z.string(),
  result: z.string().nullable(),
  resultNote: z.string().nullable(),
  reasonCode: z.string().nullable(),
  dueAt: z.string().nullable(),
  resultDueAt: z.string().nullable(),
  submittedAt: z.string(),
  decidedAt: z.string().nullable(),
});

@Controller('internal/v1/appeals')
@UseGuards(InternalToken401Guard)
export class InternalAppealsController {
  constructor(private readonly appeals: Appeals) {}

  @Get(':appealId')
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @ContractRouteSchema({ responses: { 200: InternalAppealView } })
  async get(@Param('appealId') appealId: string) {
    return this.appeals.internalGet(appealId);
  }

  @Post(':appealId/result')
  @HttpCode(200)
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @ContractRouteSchema({ responses: { 200: AppealView } })
  async result(@Param('appealId') appealId: string, @Body() raw: unknown) {
    const parsed = ResultBody.safeParse(raw ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    return this.appeals.recordResult(appealId, parsed.data);
  }
}
