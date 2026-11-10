// 받는 층: 회차 고치기(openapi PATCH /v1/partner/events/{eventId} updatePartnerEvent, ADR-0261 결정 4, BUILD_ORDER HOT-250).
// 파트너 관리자·실무자(승인 이력이 있으면 관리자만, 유스케이스가 본다). 본문은 계약 PartnerEventUpdate(닫힘, 칸 하나 이상, 정의 밖 칸 400)이다.
// If-Match는 회차의 판(event.version)이고 응답 ETag는 새 판이다. 응답은 성공·오류 모두 Cache-Control: no-store다(모듈의 미들웨어).
import { Controller, Patch, Req, Res } from '@nestjs/common';
import { UpdatePartnerEventBody, UpdatePartnerEventResponse } from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { type EventUpdated, UpdateProductionEvent } from '../application/update-production-event.js';
import type { EventEditable } from '../domain/sale-ports.js';
import { layoutEtag } from '../domain/seatmap-layout.js';
import { EventParams } from './event-summary.controller.js';
import { tenantOf } from './partner-production.controller.js';

/** 계약 PartnerEventUpdate(minProperties 1은 생성 스키마에 없어 여기서 더한다) */
export const PartnerEventPatchBody = UpdatePartnerEventBody.refine((b) => Object.keys(b).length >= 1, '고칠 칸이 없다');

type Body = z.output<typeof UpdatePartnerEventBody>;

/** 보낸 칸만 유스케이스 입력으로(시각은 Date로, entryOpensAt null은 지움) */
export function toEventPatch(b: Body): Partial<EventEditable> {
  const out: Partial<EventEditable> = {};
  if (b.openAt !== undefined) out.openAt = new Date(b.openAt);
  if (b.startsAt !== undefined) out.startsAt = new Date(b.startsAt);
  if (b.endsAt !== undefined) out.endsAt = new Date(b.endsAt);
  if (b.entryOpensAt !== undefined) out.entryOpensAt = b.entryOpensAt === null ? null : new Date(b.entryOpensAt);
  if (b.lobbyMinutes !== undefined) out.lobbyMinutes = b.lobbyMinutes;
  if (b.lobbyShuffle !== undefined) out.lobbyShuffle = b.lobbyShuffle;
  if (b.openBatch !== undefined) out.openBatch = b.openBatch;
  if (b.seatAssignment !== undefined) out.seatAssignment = b.seatAssignment;
  if (b.perPersonLimit !== undefined) out.perPersonLimit = b.perPersonLimit;
  return out;
}

@Controller('v1/partner/events')
export class PartnerEventController {
  constructor(private readonly update: UpdateProductionEvent) {}

  @Patch(':eventId')
  @ContractRouteSchema({ responses: { 200: UpdatePartnerEventResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async patch(
    @ContractParams(EventParams) params: z.output<typeof EventParams>,
    @ContractBody(PartnerEventPatchBody) body: Body,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EventUpdated> {
    const ifMatch = request.headers['if-match'];
    const out = await this.update.run({
      eventId: params.eventId.toLowerCase(),
      who: { tenantId: tenantOf(me), accountId: me.accountId },
      role: me.role ?? '',
      ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
      patch: toEventPatch(body),
    });
    void reply.header('etag', layoutEtag(out.version));
    return out;
  }
}
