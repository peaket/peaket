// 받는 층: 스캐너 회차 목록·변경분·스캔 업로드·이상 표시(openapi /v1/scanner/events/{eventId}/package·changes·flags,
// /v1/scanner/scans, /v1/scanner/flags/{flagId}/resolution, BUILD_ORDER GAT-180·GAT-190).
// 회차는 스태프 세션의 회차와 같아야 하고, 기기·세션 판정은 platform ScannerGuard가 먼저 한다.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
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
} from '@peaket/contracts/openapi/scanner';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, ScannerAuth, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerFlagNotFound, ScannerGate, ScannerGateForbidden } from '../application/scanner-gate.js';
import { ScannerGateInputError, type GateFlagPage, type GateFlagView, type ScanBatchResult, type ScannerChangesView, type ScannerPackageView } from '../domain/scanner-gate.js';

function reject(e: unknown): never {
  if (e instanceof ScannerGateInputError) throw new RequestValidationError(`스캐너 게이트 입력이 올바르지 않습니다: ${e.code}`);
  if (e instanceof ScannerGateForbidden) throw new ProblemError({ type: 'scanner-event-mismatch', status: 403, title: '스캐너 세션의 회차와 요청 회차가 다릅니다' });
  if (e instanceof ScannerFlagNotFound) throw new ProblemError({ type: 'scanner-flag-not-found', status: 404, title: '이상 표시를 찾을 수 없습니다' });
  throw e;
}

@Controller('v1/scanner')
export class ScannerGateController {
  constructor(private readonly gate: ScannerGate) {}

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
      return await this.gate.changes(params.eventId, query.after, query.limit, me.eventId);
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
    @ContractBody(CreateScannerScanBody) body: z.output<typeof CreateScannerScanBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ScanBatchResult> {
    void reply.header('cache-control', 'no-store');
    try {
      // 기기 인증만으로 올라온 묶음은 본문의 회차를 쓴다(로그아웃·해제·만료 뒤 남은 기록, O-T21·O-T26).
      // 스태프 토큰이 있으면 그 세션의 회차와 대조한다.
      const bodyEventId = Array.isArray(body) ? (body[0] as { eventId?: unknown } | undefined)?.eventId : undefined;
      return await this.gate.scans({
        eventIdRaw: me.eventId ?? bodyEventId,
        sessionEventId: me.eventId,
        deviceId: me.deviceId ?? '',
        ...(me.sessionId ? { staffAccountId: me.accountId, sessionId: me.sessionId } : {}),
        body,
      });
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
      return await this.gate.listFlags({ eventIdRaw: params.eventId, sessionEventId: me.eventId, cursor: query.cursor, limit: query.limit });
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
