// 받는 층: 정산서 수기 조정 요청(openapi createOpsSettlementAdjustment, F-07-5 LCH-100, ADR-0368 결정 7, settlement §4.3).
// cs_lead만 부르고(그 밖 역할은 403), Idempotency-Key가 필요하다. 승인 업무(ApprovalRequest)를 202로 돌려준다.
// 판정(승인·반려)은 승인 업무 경로(/v1/ops/approval-requests/{approvalId}/approvals·rejections)가 라우터로 나눈다.
import { Controller, Header, Headers, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, idempotencyKeyInvalid, parseIdempotencyKey, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import type { OpsActor } from '../../payouts/index.js';
import { SettlementAdjustmentApprovals } from '../application/settlement-adjustment-approvals.js';

const StatementParams = z.object({ statementId: z.string().min(1).max(64) });
/** openapi 본문 그대로. 근거 메모 길이·이의 대조·금액 0은 payment-svc가 본다(422) */
const AdjustmentBody = z
  .object({
    amount: z.number().int(),
    reasonCode: z.enum(['GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER', 'LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION']),
    disputeId: z.string().optional(),
    evidenceNote: z.string().optional(),
  })
  .strict();
const ApprovalView = z.record(z.string(), z.unknown());

const actorOf = (me: Principal): OpsActor => ({ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'operator' });

@Controller('v1/ops/settlements')
export class SettlementAdjustmentsController {
  constructor(private readonly adjustments: SettlementAdjustmentApprovals) {}

  @Post(':statementId/adjustments')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles(['cs_lead'])
  @ContractRouteSchema({ params: StatementParams, body: AdjustmentBody, responses: { 202: ApprovalView } })
  async request(
    @ContractParams(StatementParams) params: z.output<typeof StatementParams>,
    @ContractBody(AdjustmentBody) body: z.output<typeof AdjustmentBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() me: Principal,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (!key) throw idempotencyKeyInvalid();
    return (await this.adjustments.request(
      params.statementId,
      { amount: body.amount, reasonCode: body.reasonCode, ...(body.disputeId !== undefined ? { disputeId: body.disputeId } : {}), ...(body.evidenceNote !== undefined ? { evidenceNote: body.evidenceNote } : {}) },
      key,
      actorOf(me),
    )) as unknown as Record<string, unknown>;
  }
}
