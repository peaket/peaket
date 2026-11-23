// 받는 층: ticket-svc 입장 기록 마감 알림(openapi에 없는 코어 내부 경로, offline-gate §7.3 'core 알림', F-05-6, O-T29 ③).
// PUT /internal/v1/events/{eventId}/entry-closed, 본문 { closedAt: ISO(오프셋) }, 내부 토큰(docs/api/guidelines.md §8.1).
// event.entry_closed_at이 비었을 때만 그 값과 판매 설정 사본 entryClosedAtMs를 같은 트랜잭션에 쓴다. 이미 값이 있으면 지금 값을 200으로 준다.
// closedAt이 ends_at + 2시간보다 이르면 422, 본문 형식이 틀리면 400(guidelines §12), 없는 회차는 404다.
import { Controller, HttpCode, Inject, Param, Put, Res, UseGuards } from '@nestjs/common';import { ContractBody, ContractRouteSchema, ProblemError, RequestValidationError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound } from '../application/problems.js';
import { ENTRY_CLOSED_STORE, type EntryClosedStore } from '../domain/sale-config-ports.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 시각에 오프셋(Z 또는 ±hh:mm)이 꼭 붙어야 한다(오프셋 없는 시각은 400) */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const EntryClosedBody = z.object({ closedAt: z.string().regex(ISO_WITH_OFFSET) }).strict();
const EntryClosedResponse = z.object({ entryClosedAt: z.string() }).strict();

@Controller('internal/v1/events')
@UseGuards(InternalToken401Guard)
export class InternalEntryClosedController {
  constructor(@Inject(ENTRY_CLOSED_STORE) private readonly closes: EntryClosedStore) {}

  @Put(':eventId/entry-closed')
  @HttpCode(200)
  @ContractRouteSchema({ body: EntryClosedBody, responses: { 200: EntryClosedResponse } })
  @Roles(['public'])
  async put(
    @Param('eventId') eventId: string,
    @ContractBody(EntryClosedBody) body: z.output<typeof EntryClosedBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ entryClosedAt: string }> {
    void reply.header('cache-control', 'no-store');
    const at = Date.parse(body.closedAt);
    if (!Number.isFinite(at)) throw new RequestValidationError('closedAt이 올바른 시각이 아닙니다');
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw notFound();
    const r = await this.closes.markEntryClosed(eventId.toLowerCase(), at);
    if (r.status === 'not-found') throw notFound();
    if (r.status === 'too-early') throw new ProblemError({ type: 'entry-closed-too-early', status: 422, title: '역할 유효 끝보다 이른 마감 시각입니다' });
    return { entryClosedAt: new Date(r.entryClosedAtMs).toISOString() };
  }
}
