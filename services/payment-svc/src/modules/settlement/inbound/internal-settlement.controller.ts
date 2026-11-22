// 받는 층: payment-svc 정산·지급·미수금 내부 경로(ops-svc·core-svc 원천이 부른다).
// 같은 PEAKET_INTERNAL_TOKEN을 쓰고, 공개 경로가 아니다.
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Settlements } from '../application/settlements.js';
import type { Pg, PgStore, ReceivableRecord, StatementKind } from '../domain/settlement.js';

const PgBody = z.enum(['TOSS', 'PORTONE']);
const StoreBody = z.enum(['STANDARD', 'ESCROW']);
const BatchBody = z.object({
  pg: PgBody,
  pgStore: StoreBody,
  payoutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  portoneBalance: z.object({ amount: z.number().int().min(0), observedAt: z.string() }).optional(),
  actor: z.string().min(1),
});
const ProductBody = z.object({ periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const EventBody = z.object({
  promoterId: z.string().uuid(),
  eventId: z.string().uuid(),
  pg: PgBody,
  pgStore: StoreBody,
  /** 회차 종료 시각(ISO 날짜/시각). 지급일은 이 값 +5영업일이다(A1V-02). */
  eventEndsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), '회차 종료 시각이 맞지 않습니다'),
  commissionRateBp: z.number().int().min(0).max(10_000).optional(),
});
const ReconfirmBody = z
  .object({
    actor: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    evidence: z.object({ balanceConfirmed: z.boolean().optional(), saleResumed: z.boolean().optional(), accountReconciled: z.boolean().optional() }).strict().optional(),
  })
  .strict()
  .optional();
const DisputeResolutionBody = z.object({ result: z.enum(['ADJUSTED', 'DISMISSED']), actor: z.string().min(1) }).strict();
const ReceivableBody = z.object({ promoterId: z.string().uuid(), pg: PgBody, cause: z.enum(['REFUND_AFTER_PAYOUT', 'CHARGEBACK', 'COMPENSATION_ADVANCE', 'NEGATIVE_STATEMENT']), amount: z.number().int().positive() });
const GuaranteeBody = z
  .object({ actor: z.string().min(1), sessionId: z.string().min(1), reauthToken: z.string().min(1).optional(), idempotencyKey: z.string().min(1).max(128), reason: z.string().min(1).max(2_000) })
  .strict();

const StatementView = z
  .object({ statementId: z.string(), kind: z.enum(['EVENT', 'PRODUCT']), pg: z.enum(['TOSS', 'PORTONE']), pgStore: z.enum(['STANDARD', 'ESCROW']), status: z.string(), payoutAmount: z.number() })
  .passthrough();
const ProductCalculationResponse = z.object({ created: z.number(), items: z.array(StatementView) });
const StatementPage = z.object({ items: z.array(StatementView) });
const BatchView = z
  .object({ batchId: z.string(), pg: z.enum(['TOSS', 'PORTONE']), pgStore: z.enum(['STANDARD', 'ESCROW']), payoutDate: z.string(), totalAmount: z.number(), statementCount: z.number(), status: z.string() })
  .passthrough();
const BatchPage = z.object({ items: z.array(BatchView) });
const PayoutRecord = z.object({ payoutId: z.string(), batchId: z.string(), status: z.string() }).passthrough();
const Receivable = z.object({ receivableId: z.string(), promoterId: z.string(), pg: z.enum(['TOSS', 'PORTONE']), cause: z.string(), amount: z.number(), remaining: z.number(), status: z.string() }).passthrough();
const ReceivablePage = z.object({ items: z.array(Receivable) });

const bad = (title: string): never => {
  throw new ProblemError({ type: 'invalid-query', status: 422, title });
};
const one = <T>(s: z.ZodType<T>, body: unknown, title: string): T => {
  const p = s.safeParse(body);
  if (!p.success) bad(title);
  return p.data as T;
};

@Controller('internal/v1/settlements')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalSettlementController {
  constructor(private readonly settlements: Settlements) {}

  @Post('product-calculations')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: ProductCalculationResponse } })
  async calculateProduct(@Body() body: unknown) {
    const b = one(ProductBody, body, '상품 정산 기간이 맞지 않습니다');
    return this.settlements.calculateProduct(b);
  }

  @Post('event-calculations')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: StatementView } })
  async calculateEvent(@Body() body: unknown) {
    const b = one(EventBody, body, '회차 정산 본문이 맞지 않습니다');
    return this.settlements.calculateEvent(b);
  }

  @Post('statements/:statementId/reconfirm')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: StatementView } })
  async reconfirm(@Param('statementId') statementId: string, @Body() body: unknown) {
    const b = ReconfirmBody.safeParse(body);
    if (!b.success) bad('재확정 본문이 맞지 않습니다');
    return this.settlements.reconfirmStatement(statementId, b.data ?? {});
  }

  @Post('statements/:statementId/disputes/:disputeId/resolution')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: StatementView } })
  async resolveDispute(@Param('statementId') statementId: string, @Param('disputeId') disputeId: string, @Body() body: unknown) {
    const b = one(DisputeResolutionBody, body, '이의 결과 본문이 맞지 않습니다');
    return this.settlements.resolveDispute(statementId, disputeId, b.result, b.actor);
  }

  @Post('confirm-due')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.object({ confirmed: z.number(), items: z.array(StatementView) }) } })
  async confirmDue() {
    return this.settlements.confirmDueStatements();
  }

  @Get('statements')
  @ContractRouteSchema({ responses: { 200: StatementPage } })
  async listStatements(@Query() q: Record<string, string | undefined>) {
    const limit = Math.min(Number(q.limit ?? 100), 100);
    return {
      items: await this.settlements.listAll({
        ...(q.kind ? { kind: q.kind as StatementKind } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.pg ? { pg: q.pg as Pg } : {}),
        ...(q.pgStore ? { pgStore: q.pgStore as PgStore } : {}),
        ...(q.payoutDate ? { payoutDate: q.payoutDate } : {}),
        limit,
      }),
    };
  }

  @Post('payout-batches')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: BatchView } })
  async createBatch(@Body() body: unknown) {
    const b = one(BatchBody, body, '지급 묶음 본문이 맞지 않습니다');
    return this.settlements.createPayoutBatch(b);
  }

  @Get('payout-batches')
  @ContractRouteSchema({ responses: { 200: BatchPage } })
  async listBatches(@Query() q: Record<string, string | undefined>) {
    return { items: await this.settlements.listBatches({ ...(q.payoutDate ? { payoutDate: q.payoutDate } : {}), ...(q.pg ? { pg: q.pg as Pg } : {}), ...(q.pgStore ? { pgStore: q.pgStore as PgStore } : {}), ...(q.status ? { status: q.status.split(',') } : {}), limit: Math.min(Number(q.limit ?? 100), 100) }) };
  }

  @Get('payout-batches/:batchId')
  @ContractRouteSchema({ responses: { 200: z.object({ batch: BatchView, statements: z.array(StatementView), payouts: z.array(PayoutRecord), holds: z.array(StatementView), kycNotices: z.array(z.object({ promoterId: z.string(), sellerStatus: z.string(), from: z.string(), to: z.string(), amount: z.number(), threshold: z.number(), notice: z.boolean() })) }) } })
  async payoutBatchDetail(@Param('batchId') batchId: string) {
    return this.settlements.getPayoutBatchDetail(batchId);
  }

  @Post('receivables/:receivableId/guarantee-collections')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async collectGuarantee(@Param('receivableId') receivableId: string, @Body() body: unknown) {
    const b = one(GuaranteeBody, body, '보증 충당 본문이 맞지 않습니다');
    return this.settlements.collectGuarantee(receivableId, b);
  }

  @Post('payout-batches/:batchId/approvals')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: BatchView } })
  async approve(@Param('batchId') batchId: string, @Body() body: { approvalId?: unknown }) {
    const approvalId = body.approvalId;
    if (typeof approvalId !== 'string' || approvalId === '') bad('승인 업무 ID가 필요합니다');
    return this.settlements.approveBatch(batchId, approvalId as string);
  }

  @Post('payout-batches/:batchId/release')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.object({ released: z.literal(true) }) } })
  async release(@Param('batchId') batchId: string) {
    return this.settlements.releasePayoutBatch(batchId);
  }

  @Post('payout-batches/:batchId/execution')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: BatchView } })
  async execute(@Param('batchId') batchId: string) {
    return this.settlements.executeBatch(batchId);
  }

  @Post('payout-batches/:batchId/portone-execution')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: BatchView } })
  async portoneExecution(@Param('batchId') batchId: string, @Body() body: { bulkPayoutId?: unknown }) {
    const bulkPayoutId = body.bulkPayoutId;
    if (typeof bulkPayoutId !== 'string') bad('일괄 지급 ID가 필요합니다');
    return this.settlements.recordPortoneExecution(batchId, bulkPayoutId as string);
  }

  @Post('payouts/:payoutId/retries')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: PayoutRecord } })
  async retry(@Param('payoutId') payoutId: string) {
    return this.settlements.retryPayout(payoutId);
  }

  @Get('receivables')
  @ContractRouteSchema({ responses: { 200: ReceivablePage } })
  async listReceivables(@Query() q: Record<string, string | undefined>) {
    return {
      items: await this.settlements.listReceivables({
        ...(q.promoterId ? { promoterId: q.promoterId } : {}),
        ...(q.pg ? { pg: q.pg as Pg } : {}),
        ...(q.status ? { status: q.status.split(',') as ReceivableRecord['status'][] } : {}),
        limit: Math.min(Number(q.limit ?? 100), 100),
      }),
    };
  }

  @Post('receivables')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: Receivable } })
  async recordReceivable(@Body() body: unknown) {
    return this.settlements.recordReceivable(one(ReceivableBody, body, '미수금 본문이 맞지 않습니다'));
  }
}
