// 받는 층: ops 우선 구매 권리 발급·회수(GAT-135, POL-046 ⑦, ADR-0171).
// 관제 역할(operator·commander)만 부른다. purchase-svc 원본과 queue-svc 사본을 함께 반영한다.
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles, CurrentPrincipal, type Principal } from '@peaket/platform';
import { z } from 'zod';
import { GrantPriority } from '../application/grant-priority.js';
import { WithdrawPriority } from '../application/withdraw-priority.js';
import { PriorityDependencyUnavailable } from '../domain/priority.js';

const GrantBody = z
  .object({
    fraudCaseId: z.uuid(),
    eventId: z.uuid(),
    accountId: z.uuid(),
    cancelledTicketId: z.uuid(),
  })
  .strict();
const GrantView = z.object({
  result: z.enum(['SAME_SEAT', 'SAME_TIER', 'NO_SEAT', 'ENTRY_STARTED']),
  grantId: z.uuid().optional(),
  seatId: z.uuid().optional(),
  price: z.number().int().optional(),
  expiresAt: z.iso.datetime().optional(),
  version: z.number().int().optional(),
});
const WithdrawView = z.object({
  grantId: z.uuid(),
  eventId: z.uuid(),
  accountId: z.uuid(),
  status: z.enum(['OFFERED', 'USED', 'EXPIRED', 'WITHDRAWN']),
  expiresAt: z.iso.datetime(),
  version: z.number().int(),
});
const GrantIdParams = z.object({ grantId: z.uuid() }).strict();

const fail = (e: unknown): never => {
  if (e instanceof PriorityDependencyUnavailable) {
    throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 2, cause: e });
  }
  throw e;
};

@Controller('v1/ops/priority-grants')
export class PriorityGrantsController {
  constructor(
    private readonly grantPriority: GrantPriority,
    private readonly withdrawPriority: WithdrawPriority,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ body: GrantBody, responses: { 201: GrantView } })
  async create(@Body() body: z.output<typeof GrantBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof GrantView>> {
    try {
      return await this.grantPriority.run({ ...body, actedBy: me.accountId });
    } catch (e) {
      return fail(e);
    }
  }

  @Post(':grantId/withdrawals')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ params: GrantIdParams, responses: { 200: WithdrawView } })
  async withdraw(@Param('grantId') grantId: string): Promise<z.output<typeof WithdrawView>> {
    try {
      return await this.withdrawPriority.run(grantId);
    } catch (e) {
      return fail(e);
    }
  }
}
