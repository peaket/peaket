// 내부 HTTP: 결제사 서킷 상태 노출(BAT-425 GAT-130 잔여). ops-svc 관제가 재개 조건을 보이는 데 쓴다.
// 회차 취소 재개 화면은 결제사 몫마다 서킷 상태와 최근 실패율을 본다(transfer-refund §5).
import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import type { PgCircuits } from '../domain/pg-circuit.js';

export const PG_CIRCUITS = Symbol.for('peaket.payment.pg-circuits');
export type PgCircuitsSource = () => PgCircuits | undefined;

const Response = z.object({
  items: z.array(z.object({ pg: z.enum(['TOSS', 'PORTONE', 'SIMULATOR']), state: z.enum(['closed', 'half_open', 'open']) })),
});

@Controller('internal/v1/circuits')
@UseGuards(InternalTokenGuard)
export class InternalCircuitsController {
  constructor(@Inject(PG_CIRCUITS) private readonly circuits: PgCircuitsSource) {}

  @Get()
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: Response } })
  async list(): Promise<z.output<typeof Response>> {
    const source = this.circuits();
    return { items: (['TOSS', 'PORTONE', 'SIMULATOR'] as const).map((pg) => ({ pg, state: source?.of(pg)?.state() ?? 'closed' })) };
  }
}
