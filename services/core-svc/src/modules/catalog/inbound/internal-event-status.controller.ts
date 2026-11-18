// 받는 층: ops-svc가 회차 취소·연기 확정을 core 회차 상태에 반영하는 내부 HTTP 경로(BUILD_ORDER GAT-110, R-T41, SR-T8 ③,
// docs/features/transfer-refund.md §5 'core 회차 상태 반영', ADR-0280 결정 6). 판매 설정 읽기와 같은 내부 토큰 가드(없거나 틀리면 401)를 쓴다.
// 게이트웨이 HTTPRoute에 없고 클러스터 안에서만 닿는다(메시 허용 정책의 부르는 쪽은 ops-svc 하나, ADR-0285 결정 9). DB 조립에서만 연다.
// 답: 204(바꿈·이미 같은 상태 모두), 404 not-found, 409 event-status-conflict, 400(모양은 플랫폼 공통, 종류와 연기 시작이 맞지 않으면 invalid-body). 응답은 no-store다.
import { Controller, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ContractBody, ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApplyEventCancellationStatus } from '../application/apply-event-cancellation-status.js';
import { notFound } from '../application/problems.js';
import { EventNotFound, EventStatusConflict } from '../domain/event-cancellation-status.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 내부 본문(openapi 계약이 아니라 core-svc 안의 닫힌 스키마다. 모르는 칸은 400) */
const CancellationStatusBody = z
  .object({
    requestId: z.uuid(),
    kind: z.enum(['CANCEL', 'POSTPONE']),
    postponedTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** 204는 본문이 없다 */
const NoBody = z.object({}).strict();

const invalidBody = () => new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
const eventStatusConflict = () => new ProblemError({ type: 'event-status-conflict', status: 409, title: '회차 상태와 맞지 않습니다' });

@Controller('internal/v1/events')
@UseGuards(InternalToken401Guard)
export class InternalEventStatusController {
  constructor(private readonly apply: ApplyEventCancellationStatus) {}

  @Post(':eventId/cancellation-status')
  @HttpCode(204)
  @ContractRouteSchema({ body: CancellationStatusBody, responses: { 204: NoBody } })
  @Roles(['public'])
  async cancellationStatus(
    @Param('eventId') eventId: string,
    @ContractBody(CancellationStatusBody) body: z.output<typeof CancellationStatusBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw notFound();
    // 연기는 바뀐 시작이 꼭 있고, 취소에는 없다
    if ((body.kind === 'POSTPONE') !== (body.postponedTo !== undefined)) throw invalidBody();
    try {
      await this.apply.execute({
        eventId,
        requestId: body.requestId,
        kind: body.kind,
        ...(body.postponedTo !== undefined ? { postponedTo: new Date(body.postponedTo) } : {}),
      });
    } catch (e) {
      if (e instanceof EventNotFound) throw notFound();
      if (e instanceof EventStatusConflict) throw eventStatusConflict();
      throw e;
    }
  }
}
