// 받는 층: 파트너 실시간 판매 현황(openapi getPartnerEventLiveSnapshot, GET /v1/partner/events/{eventId}/live-snapshot, FR-026, SCR-026, C-T20).
// gw-partner가 이 경로를 ops-svc로 보낸다(docs/streaming.md §4.3, control-tower §11). 파트너 두 역할만 부르고 Cache-Control: no-store다.
// 소속은 세션 테넌트와 core 판매 설정의 promoterId로만 본다(유스케이스). 응답 칸은 계약 스키마 LiveSnapshot으로 직렬화한다
// (스키마에 없는 칸은 내보내지 않는다. 관람객 개인정보·봇 칸은 원천에도 없다).
import { Controller, ForbiddenException, Get, Header } from '@nestjs/common';
import { GetPartnerEventLiveSnapshotParams, GetPartnerEventLiveSnapshotResponse } from '@peaket/contracts/openapi/partner';
import { ContractParams, ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { z } from 'zod';
import { GetPartnerLiveSnapshot } from '../application/get-partner-live-snapshot.js';
import { RtProblem } from '../domain/realtime-table.js';

function reject(e: unknown): never {
  // 다른 파트너 회차: 오류 목록에 이름이 없어 이름 없는 403(about:blank)으로 답한다
  if (e instanceof RtProblem && e.type === 'forbidden') throw new ForbiddenException();
  if (e instanceof RtProblem) {
    throw new ProblemError({
      type: e.type,
      status: e.status,
      title: e.message,
      ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
    });
  }
  throw e;
}

@Controller('v1/partner/events')
export class PartnerLiveSnapshotController {
  constructor(private readonly liveSnapshot: GetPartnerLiveSnapshot) {}

  @Get(':eventId/live-snapshot')
  @Header('Cache-Control', 'no-store')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ params: GetPartnerEventLiveSnapshotParams, responses: { 200: GetPartnerEventLiveSnapshotResponse } })
  async get(@ContractParams(GetPartnerEventLiveSnapshotParams) params: z.output<typeof GetPartnerEventLiveSnapshotParams>, @CurrentPrincipal() me: Principal) {
    // 세션 테넌트가 없으면 소속을 확인할 수 없다(503, 같은 서비스의 파트너 회차 취소 경로와 같다)
    if (!me.tenantId) throw new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다' });
    try {
      return await this.liveSnapshot.run(params.eventId, me.tenantId);
    } catch (e) {
      reject(e);
    }
  }
}
