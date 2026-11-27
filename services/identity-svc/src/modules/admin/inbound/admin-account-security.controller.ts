// 받는 층: SCR-020 '내 계정'의 파트너 보안 경로 여섯(F-07-13, openapi partner 태그).
// 재인증 토큰은 X-Reauth-Token 머리로만 받고, 응답은 모두 캐시하지 않는다. 오류는 Problem으로 바꾼다.
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Res, UnauthorizedException } from '@nestjs/common';
import { ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountSecurityError, ManageAccountSecurity } from '../application/manage-account-security.js';

const Empty = z.object({}).strict();
const Confirm = z.object({ code: z.string().min(6).max(32) }).strict();
const SecuritySettingsView = z
  .object({ totpRegistered: z.boolean(), recoveryCodesRemaining: z.number().int().min(0).max(10), passkeyCount: z.number().int().min(0), sessionLimit: z.literal(2) })
  .strict();
const TotpEnrollmentView = z.object({ otpauthUri: z.string() }).strict();
const RecoveryCodesView = z.object({ recoveryCodes: z.array(z.string()).length(10) }).strict();
const DeviceSessionView = z
  .object({ sessionId: z.string(), deviceName: z.string().max(40).nullable(), lastActiveAt: z.string(), current: z.boolean(), otherSessions: z.number().int().min(0) })
  .strict();
const DeviceSessionListView = z.object({ items: z.array(DeviceSessionView) }).strict();
const NoBody = z.object({}).strict();

function bodyOf<T>(schema: z.ZodType<T>, body: unknown, optional = false): T {
  const input = optional && body === undefined ? {} : body;
  const r = schema.safeParse(input);
  if (!r.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
  return r.data;
}

function fail(e: unknown): never {
  if (e instanceof AccountSecurityError) {
    switch (e.code) {
      case 'REAUTH_REQUIRED':
        throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      case 'SESSION_ENDED':
        throw new UnauthorizedException();
      case 'ENROLLMENT_INVALID':
        throw new ProblemError({ type: 'totp-enrollment-invalid', status: 410, title: '인증 앱 다시 등록을 처음부터 해 주세요' });
      case 'CODE_INVALID':
        throw new ProblemError({ type: 'reauth-code-invalid', status: 422, title: '인증 앱 코드가 맞지 않습니다', normalBranch: true, extensions: { remainingAttempts: e.remainingAttempts ?? 0 } });
      case 'TOTP_NOT_REGISTERED':
        throw new ProblemError({ type: 'totp-not-registered', status: 409, title: '인증 앱이 등록되어 있지 않습니다' });
      case 'SESSION_NOT_FOUND':
        throw new ProblemError({ type: 'session-not-found', status: 404, title: '로그인한 기기가 아니거나 이미 로그아웃했습니다' });
    }
  }
  // TOTP 키·저장소·복구 코드 해셔·세션 종료 사건 장애는 닫힌 쪽으로 실패한다
  throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: 5 });
}

const noStore = (reply: FastifyReply) => void reply.header('cache-control', 'no-store');

@Controller()
export class AdminAccountSecurityController {
  constructor(private readonly security: ManageAccountSecurity) {}

  @Get('v1/partner/auth/security-settings')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 200: SecuritySettingsView } })
  async settings(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    noStore(reply);
    try {
      return await this.security.settings(me.accountId);
    } catch (e) {
      fail(e);
    }
  }

  @Post('v1/partner/auth/totp-enrollments')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 201: TotpEnrollmentView } })
  @HttpCode(201)
  async beginTotp(@Headers('x-reauth-token') token: string | undefined, @Body() body: unknown, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    noStore(reply);
    bodyOf(Empty, body, true);
    try {
      return await this.security.beginTotp({ aud: 'partner', accountId: me.accountId, sessionId: me.sessionId, reauthToken: token ?? '' });
    } catch (e) {
      fail(e);
    }
  }

  @Post('v1/partner/auth/totp-confirmations')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 200: RecoveryCodesView } })
  @HttpCode(200)
  async confirmTotp(@Body() body: unknown, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    noStore(reply);
    const parsed = bodyOf(Confirm, body);
    try {
      return await this.security.confirmTotp({ accountId: me.accountId, sessionId: me.sessionId, code: parsed.code });
    } catch (e) {
      fail(e);
    }
  }

  @Post('v1/partner/auth/recovery-codes')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 200: RecoveryCodesView } })
  @HttpCode(200)
  async recreateRecoveryCodes(@Headers('x-reauth-token') token: string | undefined, @Body() body: unknown, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    noStore(reply);
    bodyOf(Empty, body, true);
    try {
      return await this.security.recreateRecoveryCodes({ aud: 'partner', accountId: me.accountId, sessionId: me.sessionId, reauthToken: token ?? '' });
    } catch (e) {
      fail(e);
    }
  }

  @Get('v1/partner/auth/sessions')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 200: DeviceSessionListView } })
  async listSessions(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    noStore(reply);
    try {
      return { items: await this.security.listSessions({ aud: 'partner', accountId: me.accountId, sessionId: me.sessionId }) };
    } catch (e) {
      fail(e);
    }
  }

  @Delete('v1/partner/auth/sessions/:sessionId')
  @Roles(['partner_admin', 'partner_member'])
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @HttpCode(204)
  async endSession(@Headers('x-reauth-token') token: string | undefined, @Param('sessionId') sessionId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    noStore(reply);
    try {
      await this.security.endSession({ aud: 'partner', accountId: me.accountId, sessionId: me.sessionId, reauthToken: token ?? '', targetSessionId: sessionId });
    } catch (e) {
      fail(e);
    }
  }
}
