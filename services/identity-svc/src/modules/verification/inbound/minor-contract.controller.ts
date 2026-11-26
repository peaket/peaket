// 미성년자 계약 취소 확인 경로(F-06-3, openapi createIdentityMinorContractCheck, identity §5).
// 확인 POST가 준 resultToken과 동의·주문 ID를 받아 만 나이를 계산한다. 생년월일·연계정보·토큰은 응답·로그에 싣지 않는다.
import { Controller, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, ProblemError, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { MinorContractCheck, MinorContractProblem } from '../application/minor-contract-check.js';

const CheckBody = z
  .object({
    orderIds: z.array(z.string().min(1).max(64)).min(1).max(20),
    consent: z.boolean(),
    verificationResultToken: z.string().min(1),
  })
  .strict();

@Controller('v1/identity')
export class MinorContractController {
  constructor(private readonly check: MinorContractCheck) {}

  @Post('minor-contract-checks')
  @HttpCode(200)
  @Roles(['fan'])
  @ContractRouteSchema({ responses: { 200: z.object({ under19AtContract: z.boolean() }) } })
  async run(@ContractBody(CheckBody) body: z.output<typeof CheckBody>, @CurrentPrincipal() me: Principal) {
    try {
      return await this.check.run(me.accountId, body);
    } catch (e) {
      if (e instanceof MinorContractProblem) throw new ProblemError({ type: e.code, status: e.status, title: e.message });
      throw e;
    }
  }
}
