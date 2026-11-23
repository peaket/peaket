// 받는 층: 관제 파트너사·계약(openapi /v1/ops/promoters*, BAT-615 LCH-070, ADR-0320).
// 목록·상세·계약 이력은 operator·commander·cs_agent·cs_lead가 읽고(viewer 403), 등록·변경 요청은 operator·commander만 한다.
// 응답은 no-store이고 정산 계좌·결제사 내부 ID 원문을 싣지 않는다.
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, type IdempotencyRequest as IdempotencyRequestValue, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Promoters } from '../application/promoters.js';

const GuaranteeKind = z.enum(['DEPOSIT', 'PERFORMANCE_BOND']);
const PromoterParams = z.object({ promoterId: z.string().min(1).max(64) });
export const PromoterCreateBodySchema = z
  .object({
    legalName: z.string().min(1).max(100),
    commissionRateBp: z.number().int().min(0).max(10_000),
    guaranteeRateBp: z.number().int().min(0).max(10_000),
    guaranteeKind: GuaranteeKind,
  })
  .strict();
export const PromoterChangeBodySchema = z
  .object({
    commissionRateBp: z.number().int().min(0).max(10_000).optional(),
    guaranteeRateBp: z.number().int().min(0).max(10_000).optional(),
    guaranteeKind: GuaranteeKind.optional(),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

const ContractView = z
  .object({
    commissionRateBp: z.number(),
    guaranteeRateBp: z.number(),
    guaranteeKind: GuaranteeKind,
    validFrom: z.string(),
    validUntil: z.string().nullable(),
    approvalId: z.string().nullable(),
  })
  .passthrough();
const PromoterDetailView = z
  .object({
    promoterId: z.string(),
    legalName: z.string(),
    contract: ContractView,
    pendingContractApprovalId: z.string().nullable(),
    seller: z.record(z.string(), z.unknown()).nullable(),
    verifiedAt: z.string().nullable(),
    payoutAccount: z.object({ bankCode: z.string(), last4: z.string(), holdUntil: z.string().nullable(), holderVerified: z.boolean() }).strict().nullable(),
    pgRegistration: z
      .object({
        tossEnabled: z.boolean(),
        portoneEnabled: z.boolean(),
        tossSellers: z.array(z.object({ pgStore: z.enum(['STANDARD', 'ESCROW']), status: z.string().nullable() }).strict()),
        portonePartnerRegistered: z.boolean(),
      })
      .strict(),
  })
  .passthrough();
const PromoterPageView = z
  .object({
    items: z.array(z.object({ promoterId: z.string(), legalName: z.string(), commissionRateBp: z.number(), guaranteeRateBp: z.number(), contractChangePending: z.boolean() })),
    nextCursor: z.string().nullable(),
  })
  .passthrough();
const ContractPageView = z.object({ items: z.array(ContractView), nextCursor: z.string().nullable() }).passthrough();
const ApprovalView = z.record(z.string(), z.unknown());

const actorOf = (me: Principal) => ({ accountId: me.accountId, role: me.role ?? 'operator' });

@Controller('v1/ops/promoters')
export class OpsPromoterController {
  constructor(private readonly promoters: Promoters) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: PromoterPageView } })
  async list(@Query() q: Record<string, string | undefined>) {
    return this.promoters.list({
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
  }

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @Idempotent({ operation: 'CREATE_OPS_PROMOTER' })
  @ContractRouteSchema({ body: PromoterCreateBodySchema, responses: { 201: PromoterDetailView } })
  async create(@ContractBody(PromoterCreateBodySchema) body: z.output<typeof PromoterCreateBodySchema>, @CurrentPrincipal() me: Principal, @IdempotencyRequest() once: IdempotencyRequestValue) {
    return this.promoters.create(body, actorOf(me), once);
  }

  @Get(':promoterId')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: PromoterParams, responses: { 200: PromoterDetailView } })
  async detail(@ContractParams(PromoterParams) params: z.output<typeof PromoterParams>, @CurrentPrincipal() me: Principal) {
    return this.promoters.detail(params.promoterId, me.role);
  }

  @Get(':promoterId/contract-terms')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ params: PromoterParams, responses: { 200: ContractPageView } })
  async terms(@ContractParams(PromoterParams) params: z.output<typeof PromoterParams>, @Query() q: Record<string, string | undefined>) {
    return this.promoters.terms(params.promoterId, {
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
  }

  @Post(':promoterId/contract-term-changes')
  @HttpCode(202)
  @Roles(['operator', 'commander'])
  @Idempotent({ operation: 'CREATE_OPS_PROMOTER_CONTRACT_CHANGE' })
  @ContractRouteSchema({ params: PromoterParams, body: PromoterChangeBodySchema, responses: { 202: ApprovalView } })
  async change(
    @ContractParams(PromoterParams) params: z.output<typeof PromoterParams>,
    @ContractBody(PromoterChangeBodySchema) body: z.output<typeof PromoterChangeBodySchema>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequestValue,
  ) {
    return this.promoters.requestChange(params.promoterId, body, actorOf(me), once);
  }
}
