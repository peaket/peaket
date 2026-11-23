// CS 처리함 내부 HTTP(BAT-425 GAT-130, F-06-2 GAT-280). purchase-svc 등 생산자의 건 요청(asyncapi CaseRequested 모양)을 받아 건을 연다.
// 공개 경로가 아니다(공개 게이트웨이에 노출하지 않는다). Kafka support.cases-requested 소비자와 같은 처리기(ReceiveCaseRequested)를 부른다.
// 받지 않는 종류·칸이 빠진 본문은 202 accepted: false이고 건을 만들지 않는다(지표 결과 ignored, R-T48 ③). eventKey는 계약이 UUID이지만 옛 호출자의 글도 받는다.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { ReceiveCaseRequested } from '../application/receive-case-requested.js';
import { CASE_DETAIL_MAX, CS_CASE_KINDS, EVENT_KEY_MAX } from '../domain/cs-case.js';

const CaseResponse = z.object({ accepted: z.boolean(), caseId: z.uuid().optional() });
export const CaseRequestedBody = z
  .object({
    eventKey: z.string().min(1).max(EVENT_KEY_MAX),
    kind: z.enum(CS_CASE_KINDS),
    sourceId: z.string().min(1),
    category: z.string(),
    followUp: z.boolean().optional(),
    hold: z.boolean().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    dueBaseAt: z.iso.datetime({ offset: true }).optional(),
    // 건 본문 글(선택, 1~2,000자 코드 포인트, F-07-7 ADR-0370 결정 7). 어긋나면 다른 칸처럼 accepted: false다(R-T48 ③)
    detail: z
      .string()
      .refine((v) => {
        const n = [...v].length;
        return n >= 1 && n <= CASE_DETAIL_MAX;
      })
      .optional(),
  })
  .strict();

const kindOf = (body: unknown): string => {
  const k = typeof body === 'object' && body !== null ? (body as { kind?: unknown }).kind : undefined;
  return typeof k === 'string' && (CS_CASE_KINDS as readonly string[]).includes(k) ? k : 'UNKNOWN';
};

@Controller('internal/v1/cs-cases')
@UseGuards(InternalTokenGuard)
export class CasesController {
  constructor(
    private readonly receive: ReceiveCaseRequested,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(202)
  // 내부 클러스터 경로다(공개 게이트웨이에 노출하지 않는다). 서비스 사이 인증은 내부 토큰·네트워크 정책·메시 몫이다.
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 202: CaseResponse } })
  async create(@Body() body: unknown): Promise<z.output<typeof CaseResponse>> {
    const parsed = CaseRequestedBody.safeParse(body);
    if (!parsed.success) {
      this.receive.ignored(kindOf(body));
      return { accepted: false };
    }
    const r = await this.receive.handle(parsed.data, this.clock.now());
    return { accepted: r.accepted, ...(r.case ? { caseId: r.case.caseId } : {}) };
  }
}
