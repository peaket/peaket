// 받는 층: 현장 책임자의 기기 배치(openapi PUT /v1/scanner/events/{eventId}/device-placements/{deviceId}, SCR-052).
// 같은 파트너 기기만, 온라인에서만. If-Match는 배치 판(`"<version>"`, 새 배치는 `"0"`)이다.
import { Controller, Headers, HttpCode, Put, Res } from '@nestjs/common';
import { PutScannerEventDevicePlacementBody, PutScannerEventDevicePlacementParams, PutScannerEventDevicePlacementResponse } from '@peaket/contracts/openapi/scanner';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, ScannerAuth, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerDeviceInactive, ScannerDeviceNotFound } from '../application/scanner-devices.js';
import { ScannerPlacementForbidden, ScannerPlacements, ScannerPlacementPolicyUnavailable } from '../application/scanner-shift.js';
import {
  ScannerPlacementConflict,
  ScannerPlacementDeviceInactive,
  ScannerPlacementPreconditionRequired,
  ScannerPlacementReentryNotAllowed,
  ScannerShiftInputError,
  type ScannerPlacementResultView,
} from '../domain/scanner-shift.js';

export function rejectPlacement(e: unknown): never {
  if (e instanceof ScannerShiftInputError) throw new ProblemError({ type: 'invalid-placement', status: 400, title: '기기 배치 입력이 올바르지 않습니다' });
  if (e instanceof ScannerDeviceNotFound) throw new ProblemError({ type: 'scanner-device-not-found', status: 404, title: '스캐너 기기를 찾을 수 없습니다' });
  if (e instanceof ScannerDeviceInactive || e instanceof ScannerPlacementDeviceInactive) throw new ProblemError({ type: 'scanner-device-inactive', status: 409, title: '폐기·퇴역한 스캐너 기기입니다' });
  if (e instanceof ScannerPlacementForbidden) throw new ProblemError({ type: 'other-partner-device', status: 403, title: '다른 파트너사의 기기입니다' });
  if (e instanceof ScannerPlacementPreconditionRequired) throw new ProblemError({ type: 'precondition-required', status: 428, title: '고칠 판(If-Match)을 보내 주세요' });
  if (e instanceof ScannerPlacementConflict) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
  if (e instanceof ScannerPlacementReentryNotAllowed) throw new ProblemError({ type: 'scanner-placement-reentry-not-allowed', status: 422, title: '재입장을 허용하지 않는 회차에는 퇴장 모드를 배치할 수 없습니다' });
  if (e instanceof ScannerPlacementPolicyUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1 });
  throw e;
}

@Controller('v1/scanner/events')
export class ScannerPlacementController {
  constructor(private readonly placements: ScannerPlacements) {}

  @Put(':eventId/device-placements/:deviceId')
  @HttpCode(200)
  @ContractRouteSchema({
    params: PutScannerEventDevicePlacementParams,
    body: PutScannerEventDevicePlacementBody,
    responses: { 200: PutScannerEventDevicePlacementResponse },
  })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async put(
    @ContractParams(PutScannerEventDevicePlacementParams) params: z.output<typeof PutScannerEventDevicePlacementParams>,
    @ContractBody(PutScannerEventDevicePlacementBody) body: z.output<typeof PutScannerEventDevicePlacementBody>,
    @Headers('if-match') ifMatch: unknown,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScannerPlacementResultView> {
    void reply.header('cache-control', 'no-store');
    try {
      const placed = await this.placements.put({
        eventIdRaw: params.eventId,
        deviceIdRaw: params.deviceId,
        ...(me.eventId !== undefined ? { sessionEventId: me.eventId } : {}),
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
