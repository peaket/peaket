// 승인된 예외 환불 내부 HTTP(F-06-3). ops-svc만, 서비스 사이 토큰 뒤에서 부른다.
// 승인 ID가 멱등키이고 같은 ID·같은 본문은 처음 답을 그대로 준다.
import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApprovalRefunds } from '../application/approval-refund.js';

const InputBody = z
  .object({
    kind: z.enum(['SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'MINOR_CONTRACT_CANCEL']),
    orderId: z.string().min(1).max(64),
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
