// 받는 층: 파트너의 기기 배치(openapi PUT /v1/partner/events/{eventId}/device-placements/{deviceId}, SCR-037).
// 소속 기기만, 퇴장 모드는 재입장 허용 회차만. If-Match는 배치 판(`"<version>"`, 새 배치는 `"0"`)이다.
import { Controller, Headers, HttpCode, Put, Res } from '@nestjs/common';
import { PutPartnerEventDevicePlacementBody, PutPartnerEventDevicePlacementParams, PutPartnerEventDevicePlacementResponse } from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerPlacements } from '../application/scanner-shift.js';
import type { ScannerPlacementResultView } from '../domain/scanner-shift.js';
import { rejectPlacement } from './scanner-placement.controller.js';

@Controller('v1/partner/events')
export class PartnerScannerPlacementController {
  constructor(private readonly placements: ScannerPlacements) {}

  @Put(':eventId/device-placements/:deviceId')
  @HttpCode(200)
  @ContractRouteSchema({
    params: PutPartnerEventDevicePlacementParams,
    body: PutPartnerEventDevicePlacementBody,
    responses: { 200: PutPartnerEventDevicePlacementResponse },
  })
  @Roles(['partner_admin', 'partner_member'])
  async put(
    @ContractParams(PutPartnerEventDevicePlacementParams) params: z.output<typeof PutPartnerEventDevicePlacementParams>,
    @ContractBody(PutPartnerEventDevicePlacementBody) body: z.output<typeof PutPartnerEventDevicePlacementBody>,
    @Headers('if-match') ifMatch: unknown,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScannerPlacementResultView> {
    void reply.header('cache-control', 'no-store');
    try {
      const placed = await this.placements.put({
        eventIdRaw: params.eventId,
        deviceIdRaw: params.deviceId,
        tenantId: me.tenantId ?? '',
        actorId: me.accountId,
        ifMatch,
        body,
      });
      void reply.header('etag', ScannerPlacements.etagOf(placed.version));
      return placed;
    } catch (e) {
      rejectPlacement(e);
    }
  }
}
