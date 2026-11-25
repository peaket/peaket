// 받는 층: 스캐너 회차 목록·변경분·스캔 업로드·이상 표시(openapi /v1/scanner/events/{eventId}/package·changes·flags,
// /v1/scanner/scans, /v1/scanner/flags/{flagId}/resolution, BUILD_ORDER GAT-180·GAT-190).
// 회차는 스태프 세션의 회차와 같아야 하고, 기기·세션 판정은 platform ScannerGuard가 먼저 한다.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  CreateScannerFlagResolutionBody,
  CreateScannerFlagResolutionParams,
  CreateScannerFlagResolutionResponse,
  CreateScannerScanBody,
  CreateScannerScanResponse,
  GetScannerEventChangesParams,
  GetScannerEventChangesQueryParams,
  GetScannerEventChangesResponse,
  GetScannerEventPackageParams,
  GetScannerEventPackageResponse,
  ListScannerEventFlagsParams,
  ListScannerEventFlagsQueryParams,
  ListScannerEventFlagsResponse,
  PutScannerEventQueueReportBody,
} from '@peaket/contracts/openapi/scanner';
import { assertScannerOrigin, ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, ScannerAuth, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerFlagNotFound, ScannerGate, ScannerGateForbidden, ScannerGateOverrideForbidden } from '../application/scanner-gate.js';
import { SCANNER_PWA_ORIGIN } from '../domain/ports.js';
import { ScannerPlacementMissing } from '../domain/scanner-shift.js';
import { ScannerGateInputError, type GateFlagPage, type GateFlagView, type ScanBatchResult, type ScannerChangesView, type ScannerPackageView } from '../domain/scanner-gate.js';

function reject(e: unknown): never {
  if (e instanceof ScannerGateInputError) throw new RequestValidationError(`스캐너 게이트 입력이 올바르지 않습니다: ${e.code}`);
  if (e instanceof ScannerGateForbidden) throw new ProblemError({ type: 'scanner-event-mismatch', status: 403, title: '스캐너 세션의 회차와 요청 회차가 다릅니다' });
  if (e instanceof ScannerGateOverrideForbidden) throw new ProblemError({ type: 'scanner-override-forbidden', status: 403, title: '예외 통과는 현장 책임자 본인 세션에서만 할 수 있습니다' });
  if (e instanceof ScannerPlacementMissing) throw new ProblemError({ type: 'no-placement', status: 409, title: '배치되지 않은 기기입니다' });
  if (e instanceof ScannerFlagNotFound) throw new ProblemError({ type: 'scanner-flag-not-found', status: 404, title: '이상 표시를 찾을 수 없습니다' });
  throw e;
}

@Controller('v1/scanner')
export class ScannerGateController {
  constructor(
    private readonly gate: ScannerGate,
    @Inject(SCANNER_PWA_ORIGIN) private readonly pwaOrigin: string,
  ) {}

  @Get('events/:eventId/package')
  @ContractRouteSchema({ params: GetScannerEventPackageParams, responses: { 200: GetScannerEventPackageResponse } })
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  async package(
    @ContractParams(GetScannerEventPackageParams) params: z.output<typeof GetScannerEventPackageParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScannerPackageView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.gate.package(params.eventId, me.eventId);
    } catch (e) {
      reject(e);
    }
  }

  @Get('events/:eventId/changes')
  @ContractRouteSchema({ params: GetScannerEventChangesParams, query: GetScannerEventChangesQueryParams, responses: { 200: GetScannerEventChangesResponse } })
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  async changes(
    @ContractParams(GetScannerEventChangesParams) params: z.output<typeof GetScannerEventChangesParams>,
    @ContractQuery(GetScannerEventChangesQueryParams) query: z.output<typeof GetScannerEventChangesQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScannerChangesView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.gate.changes(params.eventId, query.after, query.limit, me.eventId, me.deviceId, me.role);
    } catch (e) {
      reject(e);
    }
  }

  @Post('scans')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateScannerScanBody, responses: { 200: CreateScannerScanResponse } })
  @Roles(['scanner_device', 'gate_staff', 'gate_lead'])
  @ScannerAuth({ token: 'optional', device: 'registered' })
  async scans(
    @Headers('origin') origin: unknown,
    @ContractBody(CreateScannerScanBody) body: z.output<typeof CreateScannerScanBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScanBatchResult> {
    // 스캐너 PWA 출처가 아니면 기록을 받지 않는다(offline-gate §6.1 'GAT-170 마감 규칙', O-T35)
    assertScannerOrigin(origin, this.pwaOrigin);
    void reply.header('cache-control', 'no-store');
    try {
      // 기기 인증만으로 올라온 묶음은 본문의 회차를 쓴다(로그아웃·해제·만료 뒤 남은 기록, O-T21·O-T26).
      // 스태프 토큰이 있으면 그 세션의 회차와 대조한다.
      const bodyEventId = Array.isArray(body) ? (body[0] as { eventId?: unknown } | undefined)?.eventId : undefined;
      const result = await this.gate.scans({
        eventIdRaw: me.eventId ?? bodyEventId,
        sessionEventId: me.eventId,
        deviceId: me.deviceId ?? '',
        ...(me.role !== undefined ? { role: me.role } : {}),
        ...(me.proxy !== undefined ? { proxy: me.proxy } : {}),
        ...(me.sessionId ? { staffAccountId: me.accountId, sessionId: me.sessionId } : {}),
        ...(me.staffValidFromMs !== undefined ? { sessionValidFromMs: me.staffValidFromMs } : {}),
        ...(me.staffValidUntilMs !== undefined ? { sessionValidUntilMs: me.staffValidUntilMs } : {}),
        body,
      });
      // duplicateIds는 지표용 내부 값이라 응답 계약(openapi)에 싣지 않는다
      const { duplicateIds: _duplicateIds, ...view } = result;
      return view;
    } catch (e) {
      reject(e);
    }
  }

  @Put('queue-reports/:eventId')
  @HttpCode(204)
  @ContractRouteSchema({ body: PutScannerEventQueueReportBody, responses: { 204: z.object({}).optional() } })
  @Roles(['scanner_device', 'gate_staff', 'gate_lead'])
  @ScannerAuth({ token: 'optional', device: 'registered' })
  async queueReport(
    @Headers('origin') origin: unknown,
    @Param('eventId') eventId: string,
    @ContractBody(PutScannerEventQueueReportBody) body: z.output<typeof PutScannerEventQueueReportBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // 스캔 올리기와 같은 출처 확인(offline-gate §6.1 'GAT-170 마감 규칙', §7.3 '큐 비움 보고')
    assertScannerOrigin(origin, this.pwaOrigin);
    void reply.header('cache-control', 'no-store');
    try {
      await this.gate.queueReport({ eventIdRaw: eventId, sessionEventId: me.eventId, deviceId: me.deviceId ?? '', body });
    } catch (e) {
      reject(e);
    }
  }

  @Get('events/:eventId/flags')
  @ContractRouteSchema({ params: ListScannerEventFlagsParams, query: ListScannerEventFlagsQueryParams, responses: { 200: ListScannerEventFlagsResponse } })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async flags(
    @ContractParams(ListScannerEventFlagsParams) params: z.output<typeof ListScannerEventFlagsParams>,
    @ContractQuery(ListScannerEventFlagsQueryParams) query: z.output<typeof ListScannerEventFlagsQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GateFlagPage> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.gate.listFlags({ eventIdRaw: params.eventId, sessionEventId: me.eventId, deviceId: me.deviceId ?? '', cursor: query.cursor, limit: query.limit });
    } catch (e) {
      reject(e);
    }
  }

  @Post('flags/:flagId/resolution')
  @HttpCode(200)
  @ContractRouteSchema({ params: CreateScannerFlagResolutionParams, body: CreateScannerFlagResolutionBody, responses: { 200: CreateScannerFlagResolutionResponse } })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async resolve(
    @ContractParams(CreateScannerFlagResolutionParams) params: z.output<typeof CreateScannerFlagResolutionParams>,
    @ContractBody(CreateScannerFlagResolutionBody) body: z.output<typeof CreateScannerFlagResolutionBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GateFlagView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.gate.resolveFlag({
        eventIdRaw: me.eventId,
        sessionEventId: me.eventId,
        flagIdRaw: params.flagId,
        status: body.status,
        note: body.note,
        resolvedBy: me.accountId,
      });
    } catch (e) {
      reject(e);
    }
  }
}
