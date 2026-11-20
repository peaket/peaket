// 받는 층: 지급 묶음 승인 업무·정산서·미수금(openapi ops payout-batches·settlements·receivables). 승인함 경로는 approvals 모듈이 맡는다.
import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { PayoutApprovals, type OpsActor } from '../application/payout-approvals.js';
import { PAYOUT_PAYMENT_CLIENT, type PayoutPaymentClient } from '../domain/ports.js';

const BatchBody = z
  .object({
    pg: z.enum(['TOSS', 'PORTONE']),
    pgStore: z.enum(['STANDARD', 'ESCROW']).optional(),
    payoutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    portoneBalance: z.object({ amount: z.number().int().min(0), observedAt: z.string() }).optional(),
  })
  .strict();
const BatchParams = z.object({ batchId: z.string().min(1) });
const PortoneBody = z.object({ bulkPayoutId: z.string().min(1) });

const BatchView = z
  .object({
    batchId: z.string(),
    pg: z.enum(['TOSS', 'PORTONE']),
    pgStore: z.enum(['STANDARD', 'ESCROW']),
    payoutDate: z.string(),
    totalAmount: z.number(),
    statementCount: z.number(),
    status: z.string(),
    approvalId: z.string().optional(),
    portoneBulkPayoutId: z.string().optional(),
  })
  .passthrough();
const BatchPage = z.object({ items: z.array(BatchView), nextCursor: z.string().nullable() });
const UnknownPage = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });

const actorOf = (me: Principal): OpsActor => ({ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' });
const bad = (title: string): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title });
};
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) bad('limit이 맞지 않습니다');
  return n;
};

@Controller('v1/ops')
export class PayoutsController {
  constructor(
    private readonly approvals: PayoutApprovals,
    @Inject(PAYOUT_PAYMENT_CLIENT) private readonly payments: PayoutPaymentClient,
  ) {}

  @Post('payout-batches')
  @HttpCode(202)
  @Roles(['operator'])
  @ContractRouteSchema({ body: BatchBody, responses: { 202: BatchView } })
  async createBatch(@ContractBody(BatchBody) body: z.output<typeof BatchBody>, @CurrentPrincipal() me: Principal) {
    const out = await this.approvals.request(body, actorOf(me));
    return out.batch;
  }

  @Get('payout-batches')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: BatchPage } })
  async listBatches(@Query() q: Record<string, string | undefined>) {
    return {
      items: await this.approvals.listBatches({
        ...(q.payoutDate ? { payoutDate: q.payoutDate } : {}),
        ...(q.pg ? { pg: q.pg } : {}),
        ...(q.pgStore ? { pgStore: q.pgStore } : {}),
        ...(q.status ? { status: q.status.split(',') } : {}),
        limit: num(q.limit, 50),
      }),
      nextCursor: null,
    };
  }

  @Post('payout-batches/:batchId/portone-execution')
  @HttpCode(200)
  @Roles(['operator'])
  @ContractRouteSchema({ params: BatchParams, body: PortoneBody, responses: { 200: BatchView } })
  async portoneExecution(@ContractParams(BatchParams) params: z.output<typeof BatchParams>, @ContractBody(PortoneBody) body: z.output<typeof PortoneBody>, @CurrentPrincipal() me: Principal) {
    return this.approvals.recordPortoneExecution(params.batchId, body.bulkPayoutId, me.accountId);
  }

  @Get('settlements')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: UnknownPage } })
  async listSettlements(@Query() q: Record<string, string | undefined>) {
    return { items: await this.approvals.listStatements({ ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}), ...(q.pg ? { pg: q.pg } : {}), ...(q.pgStore ? { pgStore: q.pgStore } : {}), ...(q.payoutDate ? { payoutDate: q.payoutDate } : {}), limit: num(q.limit, 50) }), nextCursor: null };
  }

  @Get('receivables')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: UnknownPage } })
  async listReceivables(@Query() q: Record<string, string | undefined>) {
    return { items: await this.approvals.listReceivables({ limit: num(q.limit, 50) }), nextCursor: null };
  }

  @Get('pg-circuits')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: z.object({ items: z.array(z.object({ pg: z.enum(['TOSS', 'PORTONE', 'SIMULATOR']), state: z.enum(['closed', 'half_open', 'open']) })) }) } })
  async listPgCircuits() {
    return this.payments.listCircuits();
  }
}
