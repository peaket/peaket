// 받는 층: 지연 환급 계좌 입력 화면(SCR-060)이 읽는 취소 상세(F-07-15 I-03, openapi getCancellation).
// 결제자 본인만 읽고, 남의 취소·없는 취소는 같은 404다. Cache-Control: private, no-store.
import { Controller, Get, Header } from '@nestjs/common';
import { ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { GetCancellationDetail } from '../application/get-cancellation-detail.js';

const Params = z.object({ cancellationId: z.uuid() }).strict();
const Response = z
  .object({
    cancellationId: z.string(),
    orderId: z.string(),
    eventId: z.string(),
    refundAmount: z.int().min(0),
    deductionAmount: z.int().min(0),
    deductionBp: z.int().min(0).max(10_000),
    reason: z.string(),
    status: z.enum(['REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED']),
    refundAccountRequired: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

@Controller('v1/cancellations')
export class CancellationDetailController {
  constructor(private readonly detail: GetCancellationDetail) {}

  @Get(':cancellationId')
  @Header('Cache-Control', 'private, no-store')
  @Roles(['fan'])
  @ContractRouteSchema({ params: Params, responses: { 200: Response } })
  async get(@ContractParams(Params) params: z.output<typeof Params>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof Response>> {
    return (await this.detail.run({ cancellationId: params.cancellationId, accountId: me.accountId })) as z.output<typeof Response>;
  }
}
