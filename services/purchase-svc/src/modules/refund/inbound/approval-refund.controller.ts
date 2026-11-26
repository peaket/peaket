// 승인된 예외 환불 내부 HTTP(F-06-3). ops-svc만, 서비스 사이 토큰 뒤에서 부른다.
// 승인 ID가 멱등키이고 같은 ID·같은 본문은 처음 답을 그대로 준다.
import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApprovalRefunds } from '../application/approval-refund.js';
import { ApprovalCancellationVoid } from '../application/approval-cancellation-void.js';

const InputBody = z
  .object({
    kind: z.enum(['SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'MINOR_CONTRACT_CANCEL']),
    orderId: z.string().min(1).max(64),
    /** 같은 승인에 묶인 다른 주문(재량 면제의 relatedOrderIds). 없으면 orderId 하나다 */
    orderIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    amount: z.number().int().min(0),
    reasonText: z.string().max(2_000).optional(),
  })
  .strict();
const Result = z.object({ status: z.enum(['REFUNDED', 'REFUND_PENDING', 'REQUESTED']), cancellationId: z.string(), refundAmount: z.number().int() });

@Controller('internal/v1/approval-refunds')
@UseGuards(InternalTokenGuard)
export class ApprovalRefundController {
  constructor(private readonly refunds: ApprovalRefunds) {}

  @Post(':approvalId')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: Result } })
  async execute(@Param('approvalId') approvalId: string, @ContractBody(InputBody) body: z.output<typeof InputBody>, @Req() request: FastifyRequest) {
    if (request.headers['x-peaket-caller'] !== 'ops-svc') throw new ProblemError({ type: 'forbidden', status: 403, title: 'ops-svc만 부를 수 있습니다' });
    if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 64) throw new ProblemError({ type: 'invalid-query', status: 400, title: '승인 ID가 맞지 않습니다' });
    return this.refunds.execute(approvalId, body);
  }
}

const VoidResult = z.object({ voided: z.boolean() });

/** FLAGGED 취소 무효(IR-30). ops-svc만. 이미 끝난 취소도 같은 답이다(멱등) */
@Controller('internal/v1/cancellations')
@UseGuards(InternalTokenGuard)
export class ApprovalCancellationVoidController {
  constructor(@Inject(ApprovalCancellationVoid) private readonly voidCancellation: ApprovalCancellationVoid) {}

  @Post(':cancellationId/void')
  @HttpCode(200)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: VoidResult } })
  async execute(@Param('cancellationId') cancellationId: string, @Req() request: FastifyRequest) {
    if (request.headers['x-peaket-caller'] !== 'ops-svc') throw new ProblemError({ type: 'forbidden', status: 403, title: 'ops-svc만 부를 수 있습니다' });
    const voided = await this.voidCancellation.execute(cancellationId);
    return { voided };
  }
}
