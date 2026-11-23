// 받는 층: 회차 취소·연기 환급의 정산 보류 열기·완료 내부 경로(부르는 쪽 purchase-svc, F-07-8 계획 §5 '공개 인터페이스(내부 HTTP)', ADR-0380 결정 2).
// 서비스 사이 공유 토큰(x-peaket-internal-token)이 없거나 틀리면 401이다(공용 가드의 403이 아니다, guidelines §8.1 다시 계산 행, architecture §3.2 REST 행).
// 판정 규칙과 local·ci 밖 토큰 없음의 시작 차단은 공용 InternalTokenGuard 그대로다(core-svc InternalToken401Guard와 같은 방식). 답은 no-store다.
import { Body, Controller, type ExecutionContext, HttpCode, Inject, Injectable, Optional, Param, Post, Put, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, InternalTokenGuard, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { Settlements } from '../application/settlements.js';
import { SettlementProblem } from '../domain/settlement.js';

@Injectable()
export class InternalToken401Guard extends InternalTokenGuard {
  constructor(@Optional() @Inject(INTERNAL_TOKEN) expected?: string, @Optional() @Inject(INTERNAL_TOKEN_REQUIRED) required = false) {
    super(expected, required);
  }

  override canActivate(context: ExecutionContext): boolean {
    if (!super.canActivate(context)) throw new UnauthorizedException('내부 토큰이 올바르지 않습니다');
    return true;
  }
}

const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)));
const OpenBody = z.strictObject({ eventId: z.string().uuid(), kind: z.enum(['CANCEL', 'POSTPONE']), confirmedAt: Iso });
const CompletionBody = z.strictObject({ completedAt: Iso, partial: z.boolean().optional() });
const RequestId = z.string().uuid();
const View = z
  .object({
    requestId: z.string(),
    eventId: z.string(),
    kind: z.enum(['CANCEL', 'POSTPONE']),
    state: z.enum(['PENDING', 'DONE']),
    held: z.array(z.string()),
    skipped: z.array(z.string()),
    retrying: z.array(z.string()),
    recalculated: z.array(z.object({ oldStatementId: z.string(), newStatementId: z.string(), revision: z.number(), negativeClosed: z.object({ receivableId: z.string(), closedAmount: z.number(), recoveredCredit: z.number() }).nullable() })),
  })
  .passthrough();

type Reply = { header(name: string, value: string): unknown };
const invalidBody = (): ProblemError => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
/** 유스케이스의 SettlementProblem을 같은 이름의 Problem으로 */
const problem = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SettlementProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

@Controller('internal/v1/settlements/event-recalculations')
@Roles(['public'])
@UseGuards(InternalToken401Guard)
export class InternalRecalculationController {
  constructor(private readonly settlements: Settlements) {}

  @Put(':requestId')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: View } })
  async open(@Param('requestId') requestId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const b = OpenBody.safeParse(body);
    if (!RequestId.safeParse(requestId).success || !b.success) throw invalidBody();
    return problem(() => this.settlements.openEventRecalculation({ requestId: requestId.toLowerCase(), eventId: b.data.eventId.toLowerCase(), kind: b.data.kind, confirmedAt: new Date(b.data.confirmedAt) }));
  }

  @Post(':requestId/completion')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: View } })
  async complete(@Param('requestId') requestId: string, @Body() body: unknown, @Res({ passthrough: true }) reply: Reply) {
    void reply.header('cache-control', 'no-store');
    const b = CompletionBody.safeParse(body);
    if (!RequestId.safeParse(requestId).success || !b.success) throw invalidBody();
    return problem(() => this.settlements.completeEventRecalculation(requestId.toLowerCase(), { completedAt: new Date(b.data.completedAt), ...(b.data.partial !== undefined ? { partial: b.data.partial } : {}) }));
  }
}
