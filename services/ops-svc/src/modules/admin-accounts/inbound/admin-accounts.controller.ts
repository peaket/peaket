// 받는 층: 관제 관리 계정 REST(openapi /v1/ops/admin-accounts*, /v1/ops/auth/sessions/me, BUILD_ORDER BOT-152, ADR-0322).
// 권한은 platform RolesGuard가 identity GetAdminAuthz로 판정한다(목록·상세·세션 종료는 operator·commander,
// 지정은 commander). 쓰기는 X-Reauth-Token(act=PERMISSION_CHANGE, 패스키)을, 역할 변경은 If-Match를 요구한다.
import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminAccountProblem, DESIGNATION_KINDS, type DesignationKind, etagOf } from '../domain/admin-account.js';
import { AdminAccounts } from '../application/admin-accounts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ adminAccountId: z.string().regex(UUID, '관리 계정 ID는 UUID다') });
const SessionParams = IdParams.extend({ sessionId: z.string().regex(UUID, '세션 ID는 UUID다') });
const DesignationParams = IdParams.extend({ kind: z.enum(['ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR']) });
const InviteBody = z
  .object({
    email: z.string().min(3).max(254),
    displayName: z.string().min(1).max(30),
    role: z.enum(['viewer', 'operator', 'cs_agent', 'cs_lead', 'partner_admin', 'partner_member']),
    promoterId: z.string().min(1).max(64).optional(),
  })
  .strict();
const RoleBody = z.object({ role: z.enum(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead', 'partner_admin', 'partner_member']), reason: z.string().min(1).max(500) }).strict();
const ReinviteBody = z.object({ reasonCode: z.enum(['RESEND', 'PROTECT_LOCK', 'CREDENTIAL_LOST']), reason: z.string().min(1).max(500) }).strict();
const RemovalBody = z.object({ reason: z.string().min(1).max(500) }).strict();
const DesignationBody = z.object({ kind: z.enum(['ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR']), basis: z.string().min(1).max(200) }).strict();

const RoleEnum = z.enum(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead', 'partner_admin', 'partner_member']);
const DesignationEnum = z.enum(['ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR']);
const AccountView = z
  .object({
    adminAccountId: z.string(),
    emailMasked: z.string(),
    displayName: z.string().nullable(),
    group: z.enum(['OPS', 'PARTNER']),
    role: RoleEnum,
    promoterId: z.string().optional(),
    status: z.enum(['INVITED', 'ACTIVE', 'INVITE_EXPIRED', 'REMOVED']),
    lockKind: z.enum(['NONE', 'TIMED', 'PROTECT']),
    lockReason: z.enum(['FAILED_ATTEMPTS', 'SECOND_FACTOR_FAILURES', 'PASSWORD_FAILURE_TOTAL']).optional(),
    lockedUntil: z.string().optional(),
    totpEnrolled: z.boolean(),
    passkeyCount: z.number(),
    designations: z.array(DesignationEnum),
    inviteExpiresAt: z.string().optional(),
    lastLoginAt: z.string().optional(),
    removedAt: z.string().optional(),
    version: z.number(),
  })
  .passthrough();
const AccountPage = z.object({ items: z.array(AccountView), nextCursor: z.string().nullable() });
const AccountDetail = AccountView.extend({
  sessions: z.array(z.object({ sessionId: z.string(), browser: z.string(), os: z.string(), createdAt: z.string(), lastActiveAt: z.string() }).passthrough()),
}).passthrough();
const ApprovalView = z
  .object({
    approvalId: z.string(),
    kind: z.enum(['COMMANDER_ROLE_CHANGE', 'PAYOUT_BATCH']),
    targetRef: z.string(),
    status: z.string(),
    requiredApprovals: z.number(),
    approvals: z.array(z.string()),
    requestedBy: z.object({ adminAccountId: z.string(), displayName: z.string().nullable(), role: z.string() }).passthrough(),
    requestedAt: z.string(),
    canApprove: z.boolean(),
  })
  .passthrough();
const DesignationView = z.object({ kind: DesignationEnum, basis: z.string(), designatedBy: z.string(), designatedAt: z.string() }).passthrough();
const PermissionChange = z
  .object({
    changedAt: z.string(),
    action: z.enum(['INVITED', 'REINVITED', 'ROLE_CHANGED', 'DESIGNATED', 'DESIGNATION_REVOKED', 'REMOVED']),
    fromRole: RoleEnum.optional(),
    toRole: RoleEnum.optional(),
    designationKind: DesignationEnum.optional(),
    actorAdminAccountId: z.string(),
    actorRole: RoleEnum,
    approvalId: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
const PermissionChangePage = z.object({ items: z.array(PermissionChange), nextCursor: z.string().nullable() });
const SessionSelf = z.object({ adminAccountId: z.string(), role: RoleEnum, displayName: z.string().nullable(), designations: z.array(DesignationEnum) }).passthrough();
const NoBody = z.object({}).strict();

const reject = (e: unknown): never => {
  if (e instanceof AdminAccountProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
  throw e;
};
const badQuery = (title: string): never => {
  throw new ProblemError({ type: 'invalid-query', status: 400, title });
};
const limitOf = (v: string | undefined): number => {
  const n = Number(v ?? 50);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) badQuery('limit이 맞지 않습니다');
  return n;
};
const tokenOf = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const v = headers['x-reauth-token'];
  return typeof v === 'string' ? v : undefined;
};
const idemOf = (headers: Record<string, string | string[] | undefined>): string | undefined => {
  const v = headers['idempotency-key'];
  return typeof v === 'string' && v.length <= 128 ? v : undefined;
};
const actorOf = (me: Principal) => ({ accountId: me.accountId, sessionId: me.sessionId, role: me.role ?? 'viewer' });

@Controller('v1/ops/admin-accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccounts) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: AccountPage } })
  async list(@Query() q: Record<string, string | undefined>) {
    const group = q.group;
    if (group !== 'OPS' && group !== 'PARTNER') badQuery('group은 OPS나 PARTNER다');
    if (group === 'OPS' && q.promoterId !== undefined) badQuery('OPS 탭에는 promoterId를 넣지 않는다');
    try {
      return await this.accounts.list({
        group: group as 'OPS' | 'PARTNER',
        ...(q.promoterId ? { promoterId: q.promoterId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit: limitOf(q.limit),
      });
    } catch (e) {
      reject(e);
    }
  }

  @Post()
  @HttpCode(201)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 201: AccountView } })
  async invite(
    @ContractBody(InviteBody) body: z.output<typeof InviteBody>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const a = await this.accounts.invite(actorOf(me), body, tokenOf(headers), idemOf(headers));
      void reply.header('location', `/v1/ops/admin-accounts/${a.adminAccountId}`);
      return a;
    } catch (e) {
      reject(e);
    }
  }

  @Get(':adminAccountId')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: AccountDetail } })
  async detail(@ContractParams(IdParams) params: z.output<typeof IdParams>, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const a = await this.accounts.get(params.adminAccountId);
      void reply.header('etag', etagOf(a.version));
      return a;
    } catch (e) {
      reject(e);
    }
  }

  @Put(':adminAccountId/role')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: AccountView, 202: ApprovalView } })
  async changeRole(
    @ContractParams(IdParams) params: z.output<typeof IdParams>,
    @ContractBody(RoleBody) body: z.output<typeof RoleBody>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const ifMatch = typeof headers['if-match'] === 'string' ? headers['if-match'] : undefined;
    try {
      const out = await this.accounts.changeRole(actorOf(me), params.adminAccountId, body, ifMatch, tokenOf(headers), idemOf(headers));
      if (out.kind === 'approval') {
        void reply.status(202);
        return out.approval;
      }
      void reply.header('etag', etagOf(out.account.version));
      return out.account;
    } catch (e) {
      reject(e);
    }
  }

  @Post(':adminAccountId/invitation')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: AccountView } })
  async reinvite(
    @ContractParams(IdParams) params: z.output<typeof IdParams>,
    @ContractBody(ReinviteBody) body: z.output<typeof ReinviteBody>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.accounts.reinvite(actorOf(me), params.adminAccountId, body, tokenOf(headers), idemOf(headers));
    } catch (e) {
      reject(e);
    }
  }

  @Post(':adminAccountId/removal')
  @HttpCode(200)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: AccountView } })
  async remove(
    @ContractParams(IdParams) params: z.output<typeof IdParams>,
    @ContractBody(RemovalBody) body: z.output<typeof RemovalBody>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.accounts.remove(actorOf(me), params.adminAccountId, body, tokenOf(headers));
    } catch (e) {
      reject(e);
    }
  }

  @Post(':adminAccountId/designations')
  @HttpCode(201)
  @Roles(['commander'])
  @ContractRouteSchema({ responses: { 201: DesignationView } })
  async designate(
    @ContractParams(IdParams) params: z.output<typeof IdParams>,
    @ContractBody(DesignationBody) body: z.output<typeof DesignationBody>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.accounts.designate(actorOf(me), params.adminAccountId, body, tokenOf(headers), idemOf(headers));
    } catch (e) {
      reject(e);
    }
  }

  @Delete(':adminAccountId/designations/:kind')
  @HttpCode(204)
  @Roles(['commander'])
  @ContractRouteSchema({ responses: { 204: NoBody } })
  async revokeDesignation(
    @ContractParams(DesignationParams) params: z.output<typeof DesignationParams>,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    try {
      await this.accounts.revokeDesignation(actorOf(me), params.adminAccountId, params.kind as DesignationKind, tokenOf(headers));
    } catch (e) {
      reject(e);
    }
  }

  @Delete(':adminAccountId/sessions')
  @HttpCode(204)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 204: NoBody } })
  async terminateAll(@ContractParams(IdParams) params: z.output<typeof IdParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    try {
      await this.accounts.terminateSessions(actorOf(me), params.adminAccountId, undefined);
    } catch (e) {
      reject(e);
    }
  }

  @Delete(':adminAccountId/sessions/:sessionId')
  @HttpCode(204)
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 204: NoBody } })
  async terminateOne(@ContractParams(SessionParams) params: z.output<typeof SessionParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    try {
      await this.accounts.terminateSessions(actorOf(me), params.adminAccountId, params.sessionId);
    } catch (e) {
      reject(e);
    }
  }

  @Get(':adminAccountId/permission-changes')
  @Header('Cache-Control', 'no-store')
  @Roles(['operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: PermissionChangePage } })
  async permissionChanges(@ContractParams(IdParams) params: z.output<typeof IdParams>, @Query() q: Record<string, string | undefined>) {
    try {
      await this.accounts.get(params.adminAccountId);
      return await this.accounts.permissionChanges(params.adminAccountId, q.cursor, limitOf(q.limit));
    } catch (e) {
      reject(e);
    }
  }
}

@Controller('v1/ops/auth/sessions')
export class AdminSessionSelfController {
  constructor(private readonly accounts: AdminAccounts) {}

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: SessionSelf } })
  async me(@CurrentPrincipal() me: Principal) {
    try {
      return await this.accounts.mySession(actorOf(me));
    } catch (e) {
      reject(e);
    }
  }
}

export { DESIGNATION_KINDS };
