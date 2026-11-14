// purchase-svc 내부 HTTP: ops-svc가 우선 구매 권리를 발급·회수한다(GAT-135, 정본 gRPC PriorityPurchaseService의 첫 내부 경로).
// 클러스터 안에서만 열고 InternalTokenGuard로 서비스 사이 토큰을 본다(비어 있으면 local·ci처럼 통과).
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { GrantPriorityPurchase, PriorityGrantNotFound, PriorityStoreUnavailable } from '../application/grant-priority-purchase.js';
import { WithdrawPriorityGrant } from '../application/withdraw-priority-grant.js';

const GrantBody = z
  .object({
    fraudCaseId: z.uuid(),
    eventId: z.uuid(),
    accountId: z.uuid(),
    cancelledTicketId: z.uuid(),
    actedBy: z.string().min(1),
  })
  .strict();
const GrantView = z.object({
  result: z.enum(['SAME_SEAT', 'SAME_TIER', 'NO_SEAT', 'ENTRY_STARTED']),
  grantId: z.uuid().optional(),
  seatId: z.uuid().optional(),
  price: z.number().int().optional(),
  expiresAt: z.string().optional(),
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

const viewOf = (g: { grantId: string; seatId: string; price: number; expiresAtMs: number; version: number }) => ({
  grantId: g.grantId,
  seatId: g.seatId,
  price: g.price,
  expiresAt: new Date(g.expiresAtMs).toISOString(),
  version: g.version,
});

const fail = (err: unknown): never => {
  if (err instanceof PriorityGrantNotFound) throw new ProblemError({ type: 'priority-grant-not-found', status: 404, title: '쓸 수 있는 우선 구매 권리가 없습니다' });
  if (err instanceof PriorityStoreUnavailable) throw new ProblemError({ type: 'seat-store-unavailable', status: 503, title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: 2 });
  throw err;
};

@Controller('internal/v1/priority-grants')
@UseGuards(InternalTokenGuard)
export class PriorityGrantController {
  constructor(
    private readonly grant: GrantPriorityPurchase,
    private readonly withdraw: WithdrawPriorityGrant,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles(['public'])
  @ContractRouteSchema({ body: GrantBody, responses: { 201: GrantView } })
  async create(@Body() body: z.output<typeof GrantBody>): Promise<z.output<typeof GrantView>> {
    try {
      const r = await this.grant.run(body);
      return { result: r.result, ...(r.grant ? viewOf(r.grant) : {}) };
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':grantId/withdrawals')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: WithdrawView } })
  async revoke(@Param('grantId') grantId: string): Promise<z.output<typeof WithdrawView>> {
    try {
      const g = await this.withdraw.run(grantId);
      return { grantId: g.grantId, eventId: g.eventId, accountId: g.accountId, status: g.status, expiresAt: new Date(g.expiresAtMs).toISOString(), version: g.version };
    } catch (err) {
      return fail(err);
    }
  }
}
