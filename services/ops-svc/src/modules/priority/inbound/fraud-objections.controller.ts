// 내부 HTTP: 소명 인정·기각 결과를 받아 우선 구매 권리 발급·회수를 자동 호출한다(GAT-135, POL-046 ⑦).
// ops 사건 화면·작업 워커가 부르는 클러스터 안 경로다(InternalTokenGuard).
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ResolveFraudObjection } from '../application/resolve-fraud-objection.js';

const DecisionBody = z
  .object({
    accountId: z.uuid(),
    eventId: z.uuid(),
    cancelledTicketIds: z.array(z.uuid()).max(10),
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    grantId: z.uuid().optional(),
    actedBy: z.string().min(1),
  })
  .strict();
const View = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  grants: z.array(
    z.object({
      result: z.enum(['SAME_SEAT', 'SAME_TIER', 'NO_SEAT', 'ENTRY_STARTED']),
      grantId: z.uuid().optional(),
      seatId: z.uuid().optional(),
      price: z.number().int().optional(),
      expiresAt: z.string().optional(),
      version: z.number().int().optional(),
    }),
  ),
  withdrawnGrantId: z.uuid().optional(),
});

@Controller('internal/v1/fraud-objections')
@UseGuards(InternalTokenGuard)
export class FraudObjectionsController {
  constructor(private readonly resolve: ResolveFraudObjection) {}

  @Post(':caseId/decisions')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ body: DecisionBody, responses: { 200: View } })
  async decide(@Param('caseId') caseId: string, @Body() body: z.output<typeof DecisionBody>): Promise<z.output<typeof View>> {
    const r = await this.resolve.run({ ...body, caseId });
    return { ...r, grants: [...r.grants] };
  }
}
