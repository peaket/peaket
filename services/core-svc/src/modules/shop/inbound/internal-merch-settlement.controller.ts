// 받는 층: 상품 정산서 원천(payment-svc 내부 호출, settlement §4.5). 같은 PEAKET_INTERNAL_TOKEN을 쓴다.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { MerchSettlements } from '../application/merch-settlements.js';

const ItemSchema = z
  .object({
    itemId: z.string(),
    orderId: z.string(),
    promoterId: z.string(),
    eventId: z.string().nullable(),
    pg: z.enum(['TOSS', 'PORTONE']),
    pgStore: z.enum(['STANDARD', 'ESCROW']),
    productId: z.string(),
    productName: z.string(),
    quantity: z.number(),
    grossAmount: z.number(),
    refundedAmount: z.number(),
    commissionRateBp: z.number(),
    basisDate: z.string(),
    returnStatus: z.string(),
    eventEndsAt: z.string().nullable(),
  })
  .passthrough();
const ProductSettlementResponse = z.object({ from: z.string(), to: z.string(), items: z.array(ItemSchema) });

@Controller('internal/v1/shop')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class InternalMerchSettlementController {
  constructor(private readonly settlements: MerchSettlements) {}

  @Get('product-settlement-items')
  @ContractRouteSchema({ responses: { 200: ProductSettlementResponse } })
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
    }
    try {
      return await this.settlements.list({ from, to });
    } catch (e) {
      if (e instanceof Error && e.name === 'MerchProblem') {
        const p = e as Error & { type: string; status: number; title: string };
        throw new ProblemError({ type: p.type, status: p.status, title: p.title });
      }
      throw e;
    }
  }
}
