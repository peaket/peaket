// 받는 층: 파트너 회차 취소·연기 요청과 상태(openapi /v1/partner/events/{eventId}/cancellation, BAT-420 GAT-110 P, R-T36, SCR-044 서버).
// gw-partner가 이 경로만 ops-svc로 보낸다. 소속은 세션 테넌트와 core 판매 설정의 promoterId로만 보고(본문·쿼리의 promoterId는 쓰지 않는다),
// 없는 회차·판매 승인 전 회차·다른 파트너 회차는 같은 404다(authz-matrix §4.1).
import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { EventCancellations, type PartnerActor } from '../application/event-cancellations.js';
import { FAULTS, KINDS, PartnerStatus, View, fail } from './views.js';

const Params = z.object({ eventId: z.string().min(1) });
// 길이·연기 일시 규칙은 유스케이스가 본다(400 invalid-body·422 postponement-date-invalid가 한 곳에서 나오게)
const PartnerBody = z
  .object({
    kind: z.enum(KINDS),
    reason: z.string(),
    faultOpinion: z.enum(FAULTS).optional(),
    evidenceRef: z.string().optional(),
    newStartsAt: z.string().optional(),
  })
  .strict();

/** 세션 테넌트가 없으면 소속을 확인할 수 없다(503, core·payment 파트너 경로와 같다) */
const partnerActorOf = (me: Principal): PartnerActor => {
  if (!me.tenantId) throw new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다' });
  return { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'partner_member', tenantId: me.tenantId };
};

@Controller('v1/partner/events')
export class PartnerEventCancellationController {
  constructor(private readonly cancellations: EventCancellations) {}

  @Post(':eventId/cancellation')
  @HttpCode(202)
  @Roles(['partner_admin'])
  @Idempotent({ operation: 'CREATE_PARTNER_EVENT_CANCELLATION' })
  @ContractRouteSchema({ params: Params, body: PartnerBody, responses: { 202: View } })
  async request(
    @ContractParams(Params) params: z.output<typeof Params>,
    @ContractBody(PartnerBody) body: z.output<typeof PartnerBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    const actor = partnerActorOf(me);
    try {
      return await this.cancellations.requestByPartner(params.eventId, body, actor, idem);
    } catch (err) {
      return fail(err);
    }
  }

  @Get(':eventId/cancellation')
  @Header('Cache-Control', 'no-store')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ params: Params, responses: { 200: PartnerStatus } })
  async status(@ContractParams(Params) params: z.output<typeof Params>, @CurrentPrincipal() me: Principal) {
    const actor = partnerActorOf(me);
    try {
      return await this.cancellations.partnerStatus(params.eventId, actor.tenantId);
    } catch (err) {
      return fail(err);
    }
  }
}
