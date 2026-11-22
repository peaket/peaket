// 받는 층: 파트너 현장 스태프 초대 만들기·명단·해제·재발송(openapi /v1/partner/events/{eventId}/staff*·/v1/partner/staff/*,
// BUILD_ORDER BAT-450B, GAT-210, identity §6.1). 테넌트는 세션의 tenantId만 쓰고(ADR-0172), 회차 소유는 core 판매 설정으로 확인한다(ADR-0353).
// 응답·헤더에 초대 토큰을 싣지 않는다. 토큰은 메일 링크의 URL 조각에만 있다.
import { Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  CreatePartnerEventStaffInvitationBody,
  CreatePartnerEventStaffInvitationResponse,
  CreatePartnerStaffInvitationResponse,
  ListPartnerEventStaffQueryParams,
  ListPartnerEventStaffResponse,
} from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { PartnerStaffInvitationError, PartnerStaffInvitations } from '../application/partner-staff-invitations.js';

function reject(e: unknown): never {
  if (e instanceof PartnerStaffInvitationError) {
    if (e.code === 'NOT_FOUND') throw new ProblemError({ type: 'not-found', status: 404, title: '없는 회차이거나 이 파트너의 회차가 아닙니다' });
    if (e.code === 'DEPENDENCY_UNAVAILABLE') throw new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다', retryAfterSeconds: 1 });
    if (e.code === 'MAIL_UNAVAILABLE') throw new ProblemError({ type: 'provider-down', status: 503, title: '지금은 초대 메일을 보낼 수 없습니다', retryAfterSeconds: 1 });
    if (e.code === 'DUPLICATE_EMAIL') throw new ProblemError({ type: 'staff-invitation-duplicate', status: 422, title: '같은 이메일을 두 번 초대할 수 없습니다' });
    if (e.code === 'ALREADY_ACCEPTED') throw new ProblemError({ type: 'staff-invitation-already-accepted', status: 409, title: '이미 수락했거나 끝난 배정입니다' });
    if (e.code === 'LIMIT') throw new RequestValidationError('초대는 한 번에 1~200명, 목록 limit은 1~100이어야 합니다');
  }
  throw e;
}

@Controller()
export class PartnerStaffController {
  constructor(private readonly invitations: PartnerStaffInvitations) {}

  @Post('v1/partner/events/:eventId/staff-invitations')
  @HttpCode(201)
  @ContractRouteSchema({ body: CreatePartnerEventStaffInvitationBody, responses: { 201: CreatePartnerEventStaffInvitationResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async create(
    @Param('eventId') eventId: string,
    @ContractBody(CreatePartnerEventStaffInvitationBody) body: z.output<typeof CreatePartnerEventStaffInvitationBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreatePartnerEventStaffInvitationResponse>> {
    void reply.header('cache-control', 'no-store');
    if (!me.tenantId) throw new ForbiddenException();
    try {
      return await this.invitations.create({ eventId, tenantId: me.tenantId, accountId: me.accountId, invitations: body.invitations });
    } catch (e) {
      reject(e);
    }
  }

  @Get('v1/partner/events/:eventId/staff')
  @ContractRouteSchema({ query: ListPartnerEventStaffQueryParams, responses: { 200: ListPartnerEventStaffResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async list(
    @Param('eventId') eventId: string,
    @ContractQuery(ListPartnerEventStaffQueryParams) query: z.output<typeof ListPartnerEventStaffQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof ListPartnerEventStaffResponse>> {
    void reply.header('cache-control', 'no-store');
    if (!me.tenantId) throw new ForbiddenException();
    try {
      return await this.invitations.list({ eventId, tenantId: me.tenantId, ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), ...(query.limit !== undefined ? { limit: query.limit } : {}) });
    } catch (e) {
      reject(e);
    }
  }

  @Delete('v1/partner/staff/:assignmentId')
  @HttpCode(204)
  @ContractRouteSchema({ responses: { 204: z.object({}).strict() } })
  @Roles(['partner_admin', 'partner_member'])
  async revoke(@Param('assignmentId') assignmentId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    if (!me.tenantId) throw new ForbiddenException();
    try {
      await this.invitations.revoke({ assignmentId, tenantId: me.tenantId });
    } catch (e) {
      reject(e);
    }
  }

  @Post('v1/partner/staff/:assignmentId/invitation')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: CreatePartnerStaffInvitationResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async reissue(
    @Param('assignmentId') assignmentId: string,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreatePartnerStaffInvitationResponse>> {
    void reply.header('cache-control', 'no-store');
    if (!me.tenantId) throw new ForbiddenException();
    try {
      return await this.invitations.reissue({ assignmentId, tenantId: me.tenantId });
    } catch (e) {
      reject(e);
    }
  }
}
