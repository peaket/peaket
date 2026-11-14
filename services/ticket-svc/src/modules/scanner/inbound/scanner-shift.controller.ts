// 받는 층: 근무 준비(SCR-033)와 준비 보고(openapi GET /v1/scanner/shift, PUT /v1/scanner/shift/readiness).
// 기기·세션 판정은 platform ScannerGuard가 먼저 한다. 배치가 없으면 409 NO_PLACEMENT다(offline-gate §6.2).
import { Controller, Get, HttpCode, Put, Res } from '@nestjs/common';
import { GetScannerShiftResponse, PutScannerShiftReadinessBody } from '@peaket/contracts/openapi/scanner';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, ScannerAuth, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerDeviceInactive, ScannerDeviceNotFound } from '../application/scanner-devices.js';
import { ScannerPlacementForbidden, ScannerPlacementPolicyUnavailable, type ScannerSessionContext, ScannerShift } from '../application/scanner-shift.js';
import {
  ScannerPlacementDeviceInactive,
  ScannerPlacementMissing,
  ScannerShiftInputError,
  type ScannerShiftView,
} from '../domain/scanner-shift.js';

export function scannerSessionContextOf(me: Principal): ScannerSessionContext {
  if (!me.eventId || !me.deviceId || !me.assignmentId || me.staffValidFromMs === undefined || me.staffValidUntilMs === undefined || (me.role !== 'gate_staff' && me.role !== 'gate_lead')) {
    throw new ProblemError({ type: 'scanner-auth-unavailable', status: 503, title: '스캐너 기기·세션을 확인하지 못했습니다', retryAfterSeconds: 1 });
  }
  return {
    accountId: me.accountId,
    sessionId: me.sessionId,
    deviceId: me.deviceId,
    eventId: me.eventId,
    role: me.role,
    proxy: me.proxy === true,
    assignmentId: me.assignmentId,
    validFromMs: me.staffValidFromMs,
    validUntilMs: me.staffValidUntilMs,
  };
}

export function rejectShift(e: unknown): never {
  if (e instanceof ScannerShiftInputError) throw new RequestValidationError(`스캐너 근무 준비 입력이 올바르지 않습니다: ${e.code}`);
  if (e instanceof ScannerPlacementMissing) throw new ProblemError({ type: 'no-placement', status: 409, title: '배치되지 않은 기기입니다' });
  if (e instanceof ScannerDeviceNotFound) throw new ProblemError({ type: 'device-unregistered', status: 403, title: '등록되지 않은 스캐너 기기입니다' });
  if (e instanceof ScannerPlacementDeviceInactive || e instanceof ScannerDeviceInactive) throw new ProblemError({ type: 'device-revoked', status: 403, title: '폐기된 스캐너 기기입니다' });
  if (e instanceof ScannerPlacementForbidden) throw new ProblemError({ type: 'other-partner-device', status: 403, title: '다른 파트너사의 기기입니다' });
  if (e instanceof ScannerPlacementPolicyUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1 });
  throw e;
}

@Controller('v1/scanner/shift')
export class ScannerShiftController {
  constructor(private readonly shift: ScannerShift) {}

  @Get()
  @ContractRouteSchema({ responses: { 200: GetScannerShiftResponse } })
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  async get(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<ScannerShiftView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.shift.shift(scannerSessionContextOf(me));
    } catch (e) {
      rejectShift(e);
    }
  }

  @Put('readiness')
  @HttpCode(204)
  @ContractRouteSchema({ body: PutScannerShiftReadinessBody, responses: { 204: z.object({}).optional() } })
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  async readiness(
    @ContractBody(PutScannerShiftReadinessBody) body: z.output<typeof PutScannerShiftReadinessBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.shift.reportReadiness(scannerSessionContextOf(me), body);
    } catch (e) {
      rejectShift(e);
    }
  }
}
