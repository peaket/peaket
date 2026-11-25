// SCR-052 현장 관리의 서버 경로(openapi createScannerBoothAuthorization·getScannerEventDevices,
// docs/design/d5 §8.5, docs/features/offline-gate.md §7.2·§9.1, docs/review/plans/F-05-12.md §3 결정 6).
// 부스 허용·기기 현황·내 예외 통과는 gate_lead만이고, 부스 허용은 스캐너 PWA 출처·JSON만 받는다.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { assertScannerOrigin, ContractBody, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, ScannerAuth, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { BoothCodeExpired, BoothInputError, BoothMismatch, type GateStatusView, type OverridePassView } from '../../ticket/index.js';
import { SCANNER_PWA_ORIGIN } from '../domain/ports.js';
import { ScannerGateForbidden } from '../application/scanner-gate.js';
import { ScannerPlacementMissing } from '../domain/scanner-shift.js';

const BoothBody = z.object({ boothCode: z.string() }).strict();
const BoothResult = z.object({ ticketId: z.string(), seatLabel: z.string(), allowUntil: z.string() });
const GateStatusResult = z.object({
  devices: z.array(z.object({ deviceId: z.string(), name: z.string(), placement: z.object({ gateZone: z.string(), mode: z.enum(['IN', 'OUT']), version: z.number().optional() }).optional(), ready: z.boolean(), packageSeq: z.number().optional(), lastSyncAt: z.string().optional(), pendingUploads: z.number(), staffLoggedIn: z.boolean().optional() })),
  entriesByZone: z.record(z.string(), z.number()),
  rejectsByReason: z.record(z.string(), z.number()),
  openFlags: z.number(),
  boothCount: z.number(),
  overrideCount: z.number(),
  entryClosedAt: z.string().optional(),
});
const OverridePage = z.object({ items: z.array(z.object({ scanId: z.string(), at: z.string(), ticketId: z.string(), seatLabel: z.string(), reason: z.string(), note: z.string().optional(), reviewStatus: z.enum(['WAITING', 'OK', 'SUSPECT', 'UNDETERMINED']) })) });

/** 이 컨트롤러가 쓰는 부스 관리 포트(TicketBooth가 만족한다). 순환 의존을 피하려 모양만 둔다 */
export interface ScannerBoothAdmin {
  authorize(i: { eventId: string; deviceId: string; body: unknown }): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }>;
  gateStatus(i: { eventId: string; deviceId: string }): Promise<GateStatusView>;
  overridePasses(i: { eventId: string; staffAccountId: string; deviceId: string; limit?: number }): Promise<{ items: OverridePassView[] }>;
}
export const SCANNER_BOOTH_ADMIN = Symbol('ticket.ScannerBoothAdmin');

function reject(e: unknown): never {
  if (e instanceof BoothInputError) throw new RequestValidationError('부스 코드가 올바르지 않습니다');
  if (e instanceof BoothCodeExpired) throw new ProblemError({ type: 'booth-code-expired', status: 410, title: '부스 코드가 만료되었거나 이미 사용되었습니다' });
  if (e instanceof BoothMismatch) throw new ProblemError({ type: 'scanner-event-mismatch', status: 403, title: '스캐너 세션의 회차와 요청 회차가 다릅니다' });
  if (e instanceof ScannerGateForbidden) throw new ProblemError({ type: 'scanner-event-mismatch', status: 403, title: '스캐너 세션의 회차와 요청 회차가 다릅니다' });
  if (e instanceof ScannerPlacementMissing) throw new ProblemError({ type: 'no-placement', status: 409, title: '배치되지 않은 기기입니다' });
  throw e;
}

@Controller('v1/scanner')
export class ScannerBoothController {
  constructor(
    @Inject(SCANNER_BOOTH_ADMIN) private readonly booth: ScannerBoothAdmin,
    @Inject(SCANNER_PWA_ORIGIN) private readonly pwaOrigin: string,
  ) {}

  @Post('booth-authorizations')
  @HttpCode(200)
  @ContractRouteSchema({ body: BoothBody, responses: { 200: BoothResult } })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async authorize(
    @Headers('origin') origin: unknown,
    @ContractBody(BoothBody) body: z.output<typeof BoothBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }> {
    assertScannerOrigin(origin, this.pwaOrigin);
    void reply.header('cache-control', 'no-store');
    try {
      return await this.booth.authorize({ eventId: me.eventId ?? '', deviceId: me.deviceId ?? '', body });
    } catch (e) {
      reject(e);
    }
  }

  @Get('events/:eventId/devices')
  @ContractRouteSchema({ responses: { 200: GateStatusResult } })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async devices(@Param('eventId') eventId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<GateStatusView> {
    void reply.header('cache-control', 'no-store');
    try {
      if (me.eventId !== undefined && me.eventId !== eventId) throw new ScannerGateForbidden();
      return await this.booth.gateStatus({ eventId, deviceId: me.deviceId ?? '' });
    } catch (e) {
      reject(e);
    }
  }

  @Get('events/:eventId/override-passes')
  @ContractRouteSchema({ responses: { 200: OverridePage } })
  @Roles(['gate_lead'])
  @ScannerAuth()
  async overridePasses(
    @Param('eventId') eventId: string,
    @Query('limit') limitRaw: string | undefined,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ items: OverridePassView[] }> {
    void reply.header('cache-control', 'no-store');
    let limit = 50;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new RequestValidationError('limit이 올바르지 않습니다');
      limit = Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RequestValidationError('limit은 1~200이어야 합니다');
    }
    try {
      if (me.eventId !== undefined && me.eventId !== eventId) throw new ScannerGateForbidden();
      return await this.booth.overridePasses({ eventId, staffAccountId: me.accountId, deviceId: me.deviceId ?? '', limit });
    } catch (e) {
      reject(e);
    }
  }
}
