// 받는 층: 예매자 명단 보기·내려받기·다운로드 이력(openapi partner attendee-exports, SCR-027, FR-027·064).
import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  CreatePartnerEventAttendeeExportBody,
  CreatePartnerEventAttendeeExportParams,
  ListPartnerEventAttendeeExportsParams,
  ListPartnerEventAttendeeExportsQueryParams,
  ListPartnerEventAttendeeExportsResponse,
  ListPartnerEventAttendeesParams,
  ListPartnerEventAttendeesQueryParams,
  ListPartnerEventAttendeesResponse,
} from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AttendeeExports } from '../application/attendee-exports.js';
import { tenantOf } from '../../catalog/index.js';
import { clientIpOf } from './client-ip.js';

/** 파일 스트림 응답(본문은 처리기가 직접 보낸다). */
const AttendeeExportFileResponse = z.object({});

@Controller('v1/partner')
export class PartnerAttendeeExportController {
  constructor(private readonly exports: AttendeeExports) {}

  @Get('events/:eventId/attendees')
  @ContractRouteSchema({ params: ListPartnerEventAttendeesParams, query: ListPartnerEventAttendeesQueryParams, responses: { 200: ListPartnerEventAttendeesResponse } })
  @Roles(['partner_admin'])
  async attendees(
    @ContractParams(ListPartnerEventAttendeesParams) params: z.output<typeof ListPartnerEventAttendeesParams>,
    @ContractQuery(ListPartnerEventAttendeesQueryParams) q: z.output<typeof ListPartnerEventAttendeesQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    // 접속기록 행위자는 이 요청의 로그인 주체(파트너 ID가 아니다, W7-audit A2-19)와 그 요청의 접속지다(리뷰 R2)
    return this.exports.listAttendees(
      tenantOf(me),
      params.eventId,
      { limit: q.limit ?? 50, ...(q.cursor ? { cursor: q.cursor } : {}) },
      { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'partner_admin', clientIp: clientIpOf(request) },
    );
  }

  @Post('events/:eventId/attendee-exports')
  @HttpCode(200)
  @ContractRouteSchema({ params: CreatePartnerEventAttendeeExportParams, body: CreatePartnerEventAttendeeExportBody, responses: { 200: AttendeeExportFileResponse } })
  @Roles(['partner_admin'])
  async create(
    @ContractParams(CreatePartnerEventAttendeeExportParams) params: z.output<typeof CreatePartnerEventAttendeeExportParams>,
    @ContractBody(CreatePartnerEventAttendeeExportBody) body: z.output<typeof CreatePartnerEventAttendeeExportBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const token = request.headers['x-reauth-token'];
    const { file } = await this.exports.create(
      tenantOf(me),
      params.eventId,
      { accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'partner_admin', clientIp: clientIpOf(request) },
      typeof token === 'string' ? token : undefined,
      body,
    );
    void reply.header('cache-control', 'no-store');
    void reply.header('content-type', file.contentType);
    void reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    void reply.send(Buffer.from(file.body));
  }

  @Get('events/:eventId/attendee-exports')
  @ContractRouteSchema({ params: ListPartnerEventAttendeeExportsParams, query: ListPartnerEventAttendeeExportsQueryParams, responses: { 200: ListPartnerEventAttendeeExportsResponse } })
  @Roles(['partner_admin'])
  async history(
    @ContractParams(ListPartnerEventAttendeeExportsParams) params: z.output<typeof ListPartnerEventAttendeeExportsParams>,
    @ContractQuery(ListPartnerEventAttendeeExportsQueryParams) q: z.output<typeof ListPartnerEventAttendeeExportsQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.exports.history(tenantOf(me), params.eventId, q.limit ?? 50);
  }
}
