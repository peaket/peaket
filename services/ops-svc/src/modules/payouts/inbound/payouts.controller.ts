// 받는 층: 지급 묶음 승인 업무·정산서·미수금(openapi ops payout-batches·settlements·receivables). 승인함 경로는 approvals 모듈이 맡는다.
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { PayoutApprovals, type OpsActor } from '../application/payout-approvals.js';
import { PayoutApprovalProblem } from '../domain/payout-approval.js';
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
const ReceivableParams = z.object({ receivableId: z.string().min(1) });
const ReceivableActionBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();
const ReceivableCollectionBody = z.object({ amount: z.number().int().positive(), reason: z.string().min(1).max(2_000) }).strict();
const ReceivableActionView = z.object({
  actionId: z.string(),
  kind: z.enum(['BILLED', 'COLLECTED', 'WRITE_OFF']),
  amount: z.number().int(),
  remainingAfter: z.number().int(),
  createdAt: z.string(),
  receivable: z.unknown(),
});

/** 새 수동 전이 응용은 PayoutApprovalProblem을 그대로 던진다(시험 대조). HTTP에서는 Problem으로 바꾼다 */
const asProblem = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PayoutApprovalProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
const GuaranteeBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();
const StatementParams = z.object({ statementId: z.string().min(1).max(64) });
/** openapi createOpsSettlementDisputeDismissal 본문. 길이(1~2,000자)는 유스케이스가 본다(400) */
const DismissalBody = z.object({ reason: z.string() }).strict();
/** 기각 응답: CS 처리함 건 상세 statementDispute와 같은 칸만(strict라 칸이 늘면 실패한다, 리뷰 RV-03) */
const StatementDisputeResponse = z
  .object({
    statementId: z.string(),
    kind: z.string(),
    eventId: z.string().nullable(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    grossAmount: z.number(),
    refundAmount: z.number(),
    commissionAmount: z.number(),
    commissionVat: z.number(),
    offsetAmount: z.number(),
    payoutAmount: z.number(),
    status: z.string(),
    disputeDueAt: z.string().nullable(),
  })
  .strict();
const BatchDetailView = z.record(z.string(), z.unknown());

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

  @Get('payout-batches/:batchId')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: BatchParams, responses: { 200: BatchDetailView } })
  async payoutBatchDetail(@ContractParams(BatchParams) params: z.output<typeof BatchParams>) {
    return this.approvals.getBatchDetail(params.batchId);
  }

  @Post('receivables/:receivableId/guarantee-collections')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: ReceivableParams, body: GuaranteeBody, responses: { 200: BatchDetailView } })
  async collectGuarantee(
    @ContractParams(ReceivableParams) params: z.output<typeof ReceivableParams>,
    @ContractBody(GuaranteeBody) body: z.output<typeof GuaranteeBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
    return this.approvals.collectGuarantee(params.receivableId, { actor: actorOf(me), reason: body.reason, idempotencyKey, reauthToken });
  }

  @Post('receivables/:receivableId/billing')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: ReceivableParams, body: ReceivableActionBody, responses: { 200: ReceivableActionView } })
  async billReceivable(
    @ContractParams(ReceivableParams) params: z.output<typeof ReceivableParams>,
    @ContractBody(ReceivableActionBody) body: z.output<typeof ReceivableActionBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
    return asProblem(() => this.approvals.billReceivable(params.receivableId, { actor: actorOf(me), reason: body.reason, idempotencyKey, reauthToken }));
  }

  @Post('receivables/:receivableId/collections')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: ReceivableParams, body: ReceivableCollectionBody, responses: { 200: ReceivableActionView } })
  async collectReceivable(
    @ContractParams(ReceivableParams) params: z.output<typeof ReceivableParams>,
    @ContractBody(ReceivableCollectionBody) body: z.output<typeof ReceivableCollectionBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
    return asProblem(() => this.approvals.collectReceivable(params.receivableId, { actor: actorOf(me), reason: body.reason, amount: body.amount, idempotencyKey, reauthToken }));
  }

  @Post('receivables/:receivableId/write-offs')
  @HttpCode(200)
  @Roles(['commander'])
  @ContractRouteSchema({ params: ReceivableParams, body: ReceivableActionBody, responses: { 200: ReceivableActionView } })
  async writeOffReceivable(
    @ContractParams(ReceivableParams) params: z.output<typeof ReceivableParams>,
    @ContractBody(ReceivableActionBody) body: z.output<typeof ReceivableActionBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentPrincipal() me: Principal,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
    return asProblem(() => this.approvals.writeOffReceivable(params.receivableId, { actor: actorOf(me), reason: body.reason, idempotencyKey, reauthToken }));
  }

  @Post('payout-batches/:batchId/portone-execution')
  @HttpCode(200)
  @Roles(['operator'])
  @ContractRouteSchema({ params: BatchParams, body: PortoneBody, responses: { 200: BatchView } })
  async portoneExecution(@ContractParams(BatchParams) params: z.output<typeof BatchParams>, @ContractBody(PortoneBody) body: z.output<typeof PortoneBody>, @CurrentPrincipal() me: Principal) {
    return this.approvals.recordPortoneExecution(params.batchId, body.bulkPayoutId, me.accountId);
  }

  /** 정산 이의 기각(cs_lead, CS 처리함 '정산 이의' 건에서, settlement §4.2·§9, ADR-0368 결정 6) */
  @Post('settlements/:statementId/dispute-dismissal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Roles(['cs_lead'])
  @ContractRouteSchema({ params: StatementParams, body: DismissalBody, responses: { 200: StatementDisputeResponse } })
  async dismissDispute(@ContractParams(StatementParams) params: z.output<typeof StatementParams>, @ContractBody(DismissalBody) body: z.output<typeof DismissalBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof StatementDisputeResponse>> {
    return this.approvals.dismissStatementDispute(params.statementId, body.reason, actorOf(me));
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
