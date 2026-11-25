// F-04-13 내부 이의 접수(core-svc support → ops-svc). 내부 토큰으로만 받고 관리자 지정을 요구하지 않는다.
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { FraudActions } from '../application/fraud-actions.js';

const BodySchema = z
  .object({
    appealId: z.string().min(1),
    accountId: z.string().min(1),
    party: z.enum(['PAYER', 'HOLDER']),
    submittedAt: z.string().min(1),
  })
  .strict();
const View = z.object({ result: z.string() });

@Controller('internal/v1/fraud-cases')
@UseGuards(InternalTokenGuard)
export class FraudAppealsController {
  constructor(private readonly fraud: FraudActions) {}

  @Post(':caseId/appeals')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ body: BodySchema, responses: { 200: View } })
  async receive(@Param('caseId') caseId: string, @Body() body: z.output<typeof BodySchema>): Promise<z.output<typeof View>> {
    return this.fraud.receiveObjection(caseId, body);
  }
}
