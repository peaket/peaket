// CS 처리함 내부 HTTP(BAT-425 GAT-130). purchase-svc의 환급 실패 통지를 받아 REFUND_FAILED 건을 연다.
// 공개 경로가 아니고, Kafka support.cases-requested 소비자 조립 전까지의 첫 연결이다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ReceiveCaseRequested } from '../application/receive-case-requested.js';
import { CS_CASE_KINDS } from '../domain/cs-case.js';

const CaseResponse = z.object({ accepted: z.boolean(), caseId: z.uuid().optional() });
const CaseRequestedBody = z
  .object({
    eventKey: z.string().min(1),
    kind: z.enum(CS_CASE_KINDS),
    sourceId: z.string().min(1),
    category: z.string(),
    followUp: z.boolean().optional(),
    hold: z.boolean().optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();

@Controller('internal/v1/cs-cases')
@UseGuards(InternalTokenGuard)
export class CasesController {
  constructor(
    private readonly receive: ReceiveCaseRequested,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(202)
  // 내부 클러스터 경로다(공개 게이트웨이에 노출하지 않는다). 서비스 사이 인증은 네트워크 정책·메시 몫이고, Kafka 소비자 조립 전의 첫 연결이다.
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: CaseResponse } })
  async create(@Body() body: unknown): Promise<z.output<typeof CaseResponse>> {
    const parsed = CaseRequestedBody.safeParse(body);
    if (!parsed.success) return { accepted: false };
    const r = await this.receive.handle(parsed.data, this.clock.now());
    return { accepted: r.accepted, ...(r.case ? { caseId: r.case.caseId } : {}) };
  }
}
