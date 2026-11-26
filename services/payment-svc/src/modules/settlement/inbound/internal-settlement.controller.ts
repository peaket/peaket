// 받는 층: payment-svc 정산·지급·미수금 내부 경로(ops-svc·core-svc 원천이 부른다).
// 같은 PEAKET_INTERNAL_TOKEN을 쓰고, 공개 경로가 아니다.
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Settlements } from '../application/settlements.js';
import { SettlementProblem, type Pg, type PgStore, type ReceivableRecord, type StatementKind } from '../domain/settlement.js';

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
/** 기각 본문(ops-svc가 cs_lead 처리자와 함께 보낸다, ADR-0368 결정 6). 사유 원문은 payment에만 남는다 */
const DismissalBody = z.object({ reason: z.string(), actorId: z.string() }).strict();
/** 조정 행 등록 본문(ops-svc가 승인 업무 ID를 먼저 정해 보낸다, ADR-0368 결정 7). 코드·금액·메모 검사는 유스케이스가 한다 */
const AdjustmentBody = z
  .object({
    approvalId: z.string(),
    amount: z.number(),
    reasonCode: z.string(),
    disputeId: z.string().optional(),
    evidenceNote: z.string().optional(),
    requestedBy: z.string(),
  })
  .strict();
const ReceivableBody = z.object({ promoterId: z.string().uuid(), pg: PgBody, cause: z.enum(['REFUND_AFTER_PAYOUT', 'CHARGEBACK', 'COMPENSATION_ADVANCE', 'NEGATIVE_STATEMENT']), amount: z.number().int().positive() });
const GuaranteeBody = z
  .object({ actor: z.string().min(1), sessionId: z.string().min(1), reauthToken: z.string().min(1).optional(), idempotencyKey: z.string().min(1).max(128), reason: z.string().min(1).max(2_000) })
  .strict();
const ReceivableCollectionBody = GuaranteeBody.extend({ amount: z.number().int().positive() }).strict();

const StatementView = z
  .object({ statementId: z.string(), kind: z.enum(['EVENT', 'PRODUCT']), pg: z.enum(['TOSS', 'PORTONE']), pgStore: z.enum(['STANDARD', 'ESCROW']), status: z.string(), payoutAmount: z.number() })
  .passthrough();
const ProductCalculationResponse = z.object({ created: z.number(), items: z.array(StatementView) });
const AdjustmentView = z
  .object({ adjustmentId: z.string(), statementId: z.string(), approvalId: z.string(), reasonCode: z.string(), disputeId: z.string().nullable(), amount: z.number(), status: z.enum(['PENDING', 'APPLIED', 'VOID']), requestedAt: z.string(), appliedAt: z.string().nullable() })
  .passthrough();
const StatementPage = z.object({ items: z.array(StatementView) });
const BatchView = z
  .object({ batchId: z.string(), pg: z.enum(['TOSS', 'PORTONE']), pgStore: z.enum(['STANDARD', 'ESCROW']), payoutDate: z.string(), totalAmount: z.number(), statementCount: z.number(), status: z.string() })
  .passthrough();
const BatchPage = z.object({ items: z.array(BatchView) });
const PayoutRecord = z.object({ payoutId: z.string(), batchId: z.string(), status: z.string() }).passthrough();
const Receivable = z.object({ receivableId: z.string(), promoterId: z.string(), pg: z.enum(['TOSS', 'PORTONE']), cause: z.string(), amount: z.number(), remaining: z.number(), status: z.string() }).passthrough();
const ReceivablePage = z.object({ items: z.array(Receivable) });
/** 지급 재요청 본문(ADR-0369 결정 8). amount·pgStore는 바꾸지 않았는지 대조할 값이다 */
const RetryBody = z.object({ actorId: z.string().min(1).max(128), amount: z.number().int().positive().optional(), pgStore: StoreBody.optional() }).strict();
const TossSellersResponse = z.object({ bankCode: z.string(), accountLast4: z.string(), sellers: z.array(z.object({ pgStore: z.enum(['STANDARD', 'ESCROW']), status: z.string() })) });

const bad = (title: string): never => {
  throw new ProblemError({ type: 'invalid-query', status: 422, title });
};
const one = <T>(s: z.ZodType<T>, body: unknown, title: string): T => {
  const p = s.safeParse(body);
  if (!p.success) bad(title);
  return p.data as T;
};
/** 본문 모양이 틀리면 400(기각·조정 등록, guidelines §12의 '모양 틀림') */
const shaped = <T>(s: z.ZodType<T>, body: unknown, title: string): T => {
  const p = s.safeParse(body);
  if (!p.success) throw new ProblemError({ type: 'invalid-body', status: 400, title });
  return p.data as T;
};

/** 새 수동 전이 응용은 SettlementProblem을 그대로 던진다(시험 대조). HTTP에서는 Problem으로 바꾼다 */
const asHttpProblem = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SettlementProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
type Reply = { header(name: string, value: string): unknown };

// ---- F-07-7 지급대행 등록·등록 읽기·판매자 확인(부르는 쪽 core-svc, ADR-0370 결정 1·4) ----
const AgencyResult = z.enum(['REGISTERED', 'UPDATED', 'SKIPPED', 'FAILED']);
const Agencies = z.object({ PORTONE: AgencyResult, TOSS_STANDARD: AgencyResult, TOSS_ESCROW: AgencyResult });
const PayoutRegistrationBody = z.strictObject({
  promoterId: z.string().uuid(),
  seller: z.strictObject({
    legalName: z.string().min(1).max(100),
    representative: z.string().min(1).max(100),
    businessRegNo: z.string().regex(/^[0-9]{10}$/),
    businessType: z.enum(['INDIVIDUAL_BUSINESS', 'CORPORATE']),
    email: z.string().min(3).max(254),
    phone: z.string().min(1).max(20),
  }),
  account: z.strictObject({ bankCode: z.string().regex(/^[0-9]{2}$/), accountNumber: z.string().regex(/^[0-9]{6,20}$/), holderName: z.string().min(1).max(100) }),
});
const PayoutRegistrationResponse = z.object({ bankCode: z.string(), accountLast4: z.string(), holderChecked: z.boolean(), agencies: Agencies });
const PayoutRegistrationViewResponse = z.object({
  payoutAccount: z.object({ bankCode: z.string(), last4: z.string(), holdUntil: z.string().nullable(), holderVerified: z.boolean() }).nullable(),
  agencySyncPending: z.boolean(),
  tossEnabled: z.boolean(),
  portoneEnabled: z.boolean(),
  tossSellers: z.array(z.object({ pgStore: z.enum(['STANDARD', 'ESCROW']), status: z.string() })),
  portonePartnerRegistered: z.boolean(),
});
const SellerVerificationBody = z.strictObject({ legalName: z.string().min(1).max(100), representative: z.string().min(1).max(100), verifiedAt: z.iso.datetime() });
const SellerVerificationResponse = z.object({ status: z.literal('VERIFIED') });
const PromoterIdParam = z.string().uuid();
// 내부 경로의 모양 틀림은 다른 내부 경로처럼 422 invalid-query(SettlementProblem)다
const invalidQuery = (): ProblemError => {
  const p = new SettlementProblem('invalid-query', 422, '요청 모양이 맞지 않습니다');
  return new ProblemError({ type: p.type, status: p.status, title: p.title });
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
    try {
      return await this.settlements.reconfirmStatement(statementId, b.data ?? {});
    } catch (e) {
      // 다시 계산 대기(statement-recalculation-pending)는 유스케이스가 이름 그대로 던진다(F-07-8)
      if (e instanceof SettlementProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
      throw e;
    }
  }

  // 옛 이의 결과 경로(…/disputes/{disputeId}/resolution)는 없앴다. 이의 인정(ADJUSTED)은 수기 조정 적용으로만 된다(ADR-0368 결정 6)
  @Post('statements/:statementId/dispute-dismissal')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: StatementView } })
  async dismissDispute(@Param('statementId') statementId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const b = shaped(DismissalBody, body, '기각 본문이 맞지 않습니다');
    return this.settlements.dismissDispute(statementId, b);
  }

  @Post('statements/:statementId/adjustments')
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: AdjustmentView } })
  async requestAdjustment(@Param('statementId') statementId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const b = shaped(AdjustmentBody, body, '조정 본문이 맞지 않습니다');
    return (
      await this.settlements.requestAdjustment(statementId, {
        approvalId: b.approvalId,
        amount: b.amount,
        reasonCode: b.reasonCode,
        requestedBy: b.requestedBy,
        ...(b.disputeId !== undefined ? { disputeId: b.disputeId } : {}),
        ...(b.evidenceNote !== undefined ? { evidenceNote: b.evidenceNote } : {}),
      })
    ).adjustment;
  }

  @Post('adjustments/:approvalId/application')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.object({ adjustment: AdjustmentView, statement: StatementView }) } })
  async applyAdjustment(@Param('approvalId') approvalId: string, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.applyAdjustment(approvalId);
  }

  @Post('adjustments/:approvalId/void')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: AdjustmentView } })
  async voidAdjustment(@Param('approvalId') approvalId: string, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.voidAdjustment(approvalId);
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

  @Post('receivables/:receivableId/billing')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async billReceivable(@Param('receivableId') receivableId: string, @Body() body: unknown) {
    const b = one(GuaranteeBody, body, '청구 본문이 맞지 않습니다');
    return asHttpProblem(() => this.settlements.billReceivable(receivableId, b));
  }

  @Post('receivables/:receivableId/collections')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async collectReceivable(@Param('receivableId') receivableId: string, @Body() body: unknown) {
    const b = one(ReceivableCollectionBody, body, '회수 본문이 맞지 않습니다');
    return asHttpProblem(() => this.settlements.collectReceivable(receivableId, b));
  }

  @Post('receivables/:receivableId/write-offs')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async writeOffReceivable(@Param('receivableId') receivableId: string, @Body() body: unknown) {
    const b = one(GuaranteeBody, body, '손실 본문이 맞지 않습니다');
    return asHttpProblem(() => this.settlements.writeOffReceivable(receivableId, b));
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

  /** 사람의 지급 재요청(ADR-0369 결정 8). 행위자(관리 계정 ID)를 받고, 금액·상점을 바꾸면 409 payout-retry-approval-required다 */
  @Post('payouts/:payoutId/retries')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: PayoutRecord } })
  async retry(@Param('payoutId') payoutId: string, @Body() body: unknown) {
    const b = one(RetryBody, body ?? {}, '지급 재요청 본문이 맞지 않습니다');
    return this.settlements.retryPayout(payoutId, { actorId: b.actorId, ...(b.amount !== undefined ? { amount: b.amount } : {}), ...(b.pgStore !== undefined ? { pgStore: b.pgStore } : {}) });
  }

  /**
   * 토스 셀러 등록(F-07-6 ADR-0369 결정 3, 부르는 쪽은 F-07-7 core-svc). 응답은 은행 코드·끝 4자리와 상점별 상태뿐이고 계좌번호를 돌려주지 않는다.
   * 모양 틀림 422, 한 상점이라도 실패 502 toss-seller-registration-failed(failedStores), 설정 없음 503
   */
  /**
   * 지급대행 등록(판매 승인 요청, F-07-7 ADR-0370 결정 1·3). 계좌번호는 결제사 요청에만 넘기고 응답은 은행·끝 4자리·결제사별 결과다.
   * 모양 틀림 422 invalid-query, 불일치 422, 한 곳 실패 502(failedAgencies), 조회 실패·꺼진 등록 503
   */
  @Post('payout-registrations')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: PayoutRegistrationResponse } })
  async registerPayoutAgencies(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const parsed = PayoutRegistrationBody.safeParse(body);
    if (!parsed.success) throw invalidQuery();
    const { promoterId, seller, account } = parsed.data;
    return this.settlements.registerPayoutAgencies({
      promoterId,
      businessType: seller.businessType,
      company: { name: seller.legalName, representativeName: seller.representative, businessRegistrationNumber: seller.businessRegNo, email: seller.email, phone: seller.phone },
      account,
    });
  }

  /** 등록 읽기(판매 승인 조건·관제 상세, ADR-0370 결정 4). 셀러·파트너 ID 원문은 없다 */
  @Get('promoters/:promoterId/payout-registration')
  @ContractRouteSchema({ responses: { 200: PayoutRegistrationViewResponse } })
  async payoutRegistration(@Param('promoterId') promoterId: string, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    if (!PromoterIdParam.safeParse(promoterId).success) throw invalidQuery();
    return this.settlements.getPayoutRegistration(promoterId.toLowerCase());
  }

  /** 판매 승인 때 판매자 확인 쓰기(ADR-0370 결정 4). 같은 값이면 그대로 200 */
  @Put('promoters/:promoterId/seller-verification')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: SellerVerificationResponse } })
  async verifySeller(@Param('promoterId') promoterId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const parsed = SellerVerificationBody.safeParse(body);
    if (!PromoterIdParam.safeParse(promoterId).success || !parsed.success) throw invalidQuery();
    return this.settlements.verifySeller(promoterId.toLowerCase(), { legalName: parsed.data.legalName, representative: parsed.data.representative, verifiedAt: new Date(parsed.data.verifiedAt) });
  }

  @Post('toss-sellers')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: TossSellersResponse } })
  async registerTossSellers(@Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    return this.settlements.registerTossSellers(body as Parameters<Settlements['registerTossSellers']>[0]);
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
