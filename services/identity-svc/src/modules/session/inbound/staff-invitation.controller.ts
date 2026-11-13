// 받는 층: 현장 스태프 초대 조회·수락·거절·내 배정 목록(openapi /v1/staff-invitation-*·/v1/staff-assignments,
// BUILD_ORDER GAT-210, identity §6.1). 토큰은 URL 조각에서 꺼내 본문으로만 받는다.
import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import {
  CreateStaffInvitationAcceptanceBody,
  CreateStaffInvitationAcceptanceResponse,
  CreateStaffInvitationLookupBody,
  CreateStaffInvitationLookupResponse,
  CreateStaffInvitationRejectionBody,
  ListStaffAssignmentsQueryParams,
  ListStaffAssignmentsResponse,
} from '@peaket/contracts/openapi/identity';
import { ContractBody, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { StaffInvitationError, StaffInvitations, type StaffAssignmentView, type StaffInvitationView } from '../application/staff-invitations.js';

function reject(e: unknown): never {
  if (e instanceof StaffInvitationError) {
    if (e.code === 'INVITATION_INVALID') throw new ProblemError({ type: 'invitation-invalid', status: 410, title: '초대가 만료되었거나 이미 사용되었습니다' });
    if (e.code === 'EMAIL_MISMATCH') throw new ProblemError({ type: 'staff-invitation-email-mismatch', status: 403, title: '초대 이메일과 검증된 계정 이메일이 다릅니다' });
    if (e.code === 'ASSIGNMENT_EXISTS') throw new ProblemError({ type: 'staff-assignment-exists', status: 409, title: '이미 이 회차에 배정된 계정입니다' });
    if (e.code === 'CONSENT_REQUIRED') throw new ProblemError({ type: 'consent-required', status: 422, title: '동의가 필요합니다' });
    if (e.code === 'CONSENT_OUTDATED') throw new ProblemError({ type: 'consent-version-outdated', status: 422, title: '동의 문안이 바뀌었습니다. 다시 확인해 주세요' });
    if (e.code === 'LIMIT') throw new RequestValidationError('limit은 1~100이어야 합니다');
  }
  throw e;
}

@Controller()
export class StaffInvitationController {
  constructor(private readonly invitations: StaffInvitations) {}

  @Post('v1/staff-invitation-lookups')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateStaffInvitationLookupBody, responses: { 200: CreateStaffInvitationLookupResponse } })
  @Roles(['fan'])
  async lookup(
    @ContractBody(CreateStaffInvitationLookupBody) body: z.output<typeof CreateStaffInvitationLookupBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StaffInvitationView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.invitations.lookup(body.inviteToken);
    } catch (e) {
      reject(e);
    }
  }

  @Post('v1/staff-invitation-acceptances')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateStaffInvitationAcceptanceBody, responses: { 200: CreateStaffInvitationAcceptanceResponse } })
  @Roles(['fan'])
  async accept(
    @ContractBody(CreateStaffInvitationAcceptanceBody) body: z.output<typeof CreateStaffInvitationAcceptanceBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StaffAssignmentView> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.invitations.accept({
        inviteToken: body.inviteToken,
        accountId: me.accountId,
        consentCollection: body.consentCollection,
        consentProvision: body.consentProvision,
        consentVersion: body.consentVersion,
      });
    } catch (e) {
      reject(e);
    }
  }

  @Post('v1/staff-invitation-rejections')
  @HttpCode(204)
  @ContractRouteSchema({ body: CreateStaffInvitationRejectionBody, responses: { 204: z.object({}).strict() } })
  @Roles(['fan'])
  async rejectInvitation(
    @ContractBody(CreateStaffInvitationRejectionBody) body: z.output<typeof CreateStaffInvitationRejectionBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await this.invitations.reject(body.inviteToken);
  }

  @Get('v1/staff-assignments')
  @ContractRouteSchema({ query: ListStaffAssignmentsQueryParams, responses: { 200: ListStaffAssignmentsResponse } })
  @Roles(['fan'])
  async list(
    @ContractQuery(ListStaffAssignmentsQueryParams) query: z.output<typeof ListStaffAssignmentsQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof ListStaffAssignmentsResponse>> {
    void reply.header('cache-control', 'private, no-store');
    try {
      return await this.invitations.listSelf({ accountId: me.accountId, cursor: query.cursor, limit: query.limit });
    } catch (e) {
      reject(e);
    }
  }
}
