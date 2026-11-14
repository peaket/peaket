// 우선 구매 권리 사본 쓰기 내부 HTTP(GAT-135). 정본은 queue.proto PriorityGrantService이고, ops-svc가 purchase-svc로 권리를 만든 뒤
// 같은 판 번호·만료를 이 경로로 queue-svc에 복사한다(클러스터 안에서만, InternalTokenGuard).
import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { PriorityGrantError, SetPriorityGrant } from '../application/set-priority-grant.js';
import { QueueStoreUnavailable } from '../../entry/index.js';

const SetBody = z
  .object({
    accountId: z.uuid(),
    eventId: z.uuid(),
    grantId: z.uuid(),
    state: z.enum(['OFFERED', 'WITHDRAWN']),
    expiresAt: z.iso.datetime(),
    version: z.number().int().min(0),
  })
  .strict();
const SetView = z.object({ changed: z.boolean() });

@Controller('internal/v1/priority-grants')
@UseGuards(InternalTokenGuard)
export class PriorityGrantInternalController {
  constructor(private readonly set: SetPriorityGrant) {}

  @Post()
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ body: SetBody, responses: { 200: SetView } })
  async create(@ContractBody(SetBody) body: z.output<typeof SetBody>): Promise<z.output<typeof SetView>> {
    try {
      return await this.set.run({
        accountId: body.accountId,
        eventId: body.eventId,
        grantId: body.grantId,
        state: body.state,
        expiresAtMs: Date.parse(body.expiresAt),
        version: body.version,
      });
    } catch (e) {
      if (e instanceof PriorityGrantError) throw new ProblemError({ type: 'invalid-priority-grant', status: 400, title: '우선 구매 권리 요청이 올바르지 않습니다' });
      if (e instanceof QueueStoreUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
      throw e;
    }
  }
}
