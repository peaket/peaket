// 주문 승인 근거 내부 HTTP(F-06-3 IR-03). 내부 토큰 뒤에서 ops-svc·identity-svc가 읽는다.
import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { ApprovalBasisOrders } from '../application/approval-basis.js';

@Controller('internal/v1/orders')
@UseGuards(InternalTokenGuard)
export class InternalApprovalBasisController {
  constructor(private readonly basis: ApprovalBasisOrders) {}

  @Get(':orderId/approval-basis')
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async approvalBasis(@Param('orderId') orderId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    const out = await this.basis.basis(orderId);
    if (!out) throw new ProblemError({ type: 'not-found', status: 404, title: '주문을 찾지 못했습니다' });
    return out;
  }

  @Get(':orderId/minor-contract-basis')
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async minorContractBasis(@Param('orderId') orderId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    const out = await this.basis.minorContractBasis(orderId);
    if (!out) throw new ProblemError({ type: 'not-found', status: 404, title: '주문을 찾지 못했습니다' });
    return out;
  }
}
