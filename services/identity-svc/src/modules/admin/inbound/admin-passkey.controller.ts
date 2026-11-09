// 받는 층: 관리 계정 재인증과 내 패스키(openapi /v1/{partner,ops}/auth/reauthentications·/passkey-registrations·/passkeys, identity §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, ADR-0206).
// 게이트웨이(gw-partner·gw-ops)가 넘긴 관리 신원(계정·세션)과 identity의 역할 판정(가드)을 쓴다. 비밀번호 바꾸기 필요 세션은 가드가 403으로 막는다.
// 재인증 토큰은 응답 본문에 싣고 화면이 X-Reauth-Token으로 보낸다(guidelines §7). 응답은 캐시하지 않는다.
import { Controller, Delete, Get, Headers, HttpCode, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { COOKIE_CHALLENGE, ContractBody, CurrentPrincipal, type Principal, ProblemError, RequestValidationError, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type FinishRegistrationOutcome, ManagePasskeys, type PasskeyView } from '../application/manage-passkeys.js';
import { ReauthenticateAdmin, type ReauthFinishOutcome, type ReauthStartOutcome } from '../application/reauthenticate-admin.js';
import { type AdminAud, LoginCountersUnavailable, PasskeyChallengesUnavailable, PepperUnavailable, ROLES_OF_AUD, TotpKeyUnavailable } from '../domain/ports.js';
import { clientIpOf } from './admin-login.controller.js';

const RETRY_AFTER_S = 5;
const b64u = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const b64uOpt = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/).optional();
const step43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const extensions = z.record(z.string(), z.unknown());

// openapi PartnerReauthPasswordStep·OpsReauthPasswordStep(콘솔마다 받는 작업 묶음이 다르다)
const passwordStep = <T extends readonly [string, ...string[]]>(acts: T) =>
  z
    .object({
      act: z.enum(acts),
      password: z.string().min(1).max(1024),
      code: z.string().regex(/^[0-9]{3} ?[0-9]{3}$/),
      withPasskey: z.boolean().optional(),
    })
    .strict();
// openapi WebAuthnAssertion(AuthenticationResponseJSON)
const Assertion = z
  .object({
    id: b64u(1366),
    rawId: b64u(1366),
    type: z.literal('public-key'),
    authenticatorAttachment: z.string().max(32).optional(),
    clientExtensionResults: extensions,
    response: z.object({ clientDataJSON: b64u(4096), authenticatorData: b64u(4096), signature: b64u(1024), userHandle: b64uOpt(128) }).strict(),
  })
  .strict();
// openapi WebAuthnAttestation(RegistrationResponseJSON)
const Attestation = z
  .object({
    id: b64u(1366),
    rawId: b64u(1366),
    type: z.literal('public-key'),
    authenticatorAttachment: z.string().max(32).optional(),
    clientExtensionResults: extensions,
    response: z
      .object({
        clientDataJSON: b64u(4096),
        attestationObject: b64u(16384),
        authenticatorData: b64uOpt(8192),
        publicKey: b64uOpt(4096),
        publicKeyAlgorithm: z.number().int().optional(),
        transports: z
          .array(z.string().regex(/^[a-z-]{1,32}$/))
          .max(8)
          .optional(),
      })
      .strict(),
  })
  .strict();
const PasskeyStep = z.object({ reauthStep: step43, credential: Assertion }).strict();
const PartnerReauthBody = z.union([passwordStep(['PAYOUT_ACCOUNT', 'BOOKER_EXPORT', 'ACCOUNT_SECURITY'] as const), PasskeyStep]);
const OpsReauthBody = z.union([passwordStep(['OPS_COMMAND', 'APPROVAL', 'PERMISSION_CHANGE', 'AUTHORITY_DATA', 'ACCOUNT_SECURITY'] as const), PasskeyStep]);
type ReauthBody = z.output<typeof PartnerReauthBody> | z.output<typeof OpsReauthBody>;
// openapi AdminPasskeyCreate. 이름표는 코드포인트 30자(openapi maxLength와 같은 단위)
const PasskeyCreate = z
  .object({
    registrationId: step43,
    credential: Attestation,
    name: z
      .string()
      .min(1)
      .max(60)
      .refine((s) => [...s].length <= 30)
      .optional(),
  })
  .strict();
type PasskeyCreateBody = z.output<typeof PasskeyCreate>;

const unavailable = (e: unknown): never => {
  if (e instanceof LoginCountersUnavailable || e instanceof PepperUnavailable || e instanceof TotpKeyUnavailable || e instanceof PasskeyChallengesUnavailable) {
    throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: RETRY_AFTER_S });
  }
  throw e;
};
const locked = (o: { lock: 'TIMED'; retryAfterSeconds: number } | { lock: 'PROTECT' }): never => {
  if (o.lock === 'PROTECT') throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, extensions: { lock: 'PROTECT' } });
  throw new ProblemError({ type: 'admin-account-locked', status: 423, title: '계정이 잠겼습니다', normalBranch: true, retryAfterSeconds: o.retryAfterSeconds, extensions: { lock: 'TIMED', retryAfterSeconds: o.retryAfterSeconds } });
};
/** 가드의 신원 401과 같다(RFC 9110 §15.5.2): 그 사이 끝난 세션 */
const sessionInvalid = (reply: FastifyReply): never => {
  void reply.header('www-authenticate', COOKIE_CHALLENGE);
  throw new UnauthorizedException();
};
const reauthRequired = (): never => {
  throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
};
const view = (p: PasskeyView) => ({ passkeyId: p.passkeyId, name: p.name, createdAt: new Date(p.createdAt).toISOString(), lastUsedAt: p.lastUsedAt === null ? null : new Date(p.lastUsedAt).toISOString(), backedUp: p.backedUp, deviceType: p.deviceType, transports: p.transports });

const PARTNER_ROLES = [...ROLES_OF_AUD.partner];
const OPS_ROLES = [...ROLES_OF_AUD.ops];

@Controller()
export class AdminPasskeyController {
  constructor(
    private readonly reauth: ReauthenticateAdmin,
    private readonly passkeys: ManagePasskeys,
  ) {}

  // ── 재인증(두 단계, 같은 경로) ──
  @Post('v1/partner/auth/reauthentications')
  @Roles(PARTNER_ROLES)
  @HttpCode(200)
  partnerReauth(@ContractBody(PartnerReauthBody) body: z.output<typeof PartnerReauthBody>, @CurrentPrincipal() me: Principal, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#reauth('partner', body, me, req, reply);
  }

  @Post('v1/ops/auth/reauthentications')
  @Roles(OPS_ROLES)
  @HttpCode(200)
  opsReauth(@ContractBody(OpsReauthBody) body: z.output<typeof OpsReauthBody>, @CurrentPrincipal() me: Principal, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#reauth('ops', body, me, req, reply);
  }

  // ── 내 패스키 ──
  @Post('v1/partner/auth/passkey-registrations')
  @Roles(PARTNER_ROLES)
  @HttpCode(201)
  partnerBegin(@Headers('x-reauth-token') token: string | undefined, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#begin('partner', token, me, reply);
  }

  @Post('v1/ops/auth/passkey-registrations')
  @Roles(OPS_ROLES)
  @HttpCode(201)
  opsBegin(@Headers('x-reauth-token') token: string | undefined, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#begin('ops', token, me, reply);
  }

  @Get('v1/partner/auth/passkeys')
  @Roles(PARTNER_ROLES)
  partnerList(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#list(me, reply);
  }

  @Get('v1/ops/auth/passkeys')
  @Roles(OPS_ROLES)
  opsList(@CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#list(me, reply);
  }

  @Post('v1/partner/auth/passkeys')
  @Roles(PARTNER_ROLES)
  @HttpCode(201)
  partnerCreate(@ContractBody(PasskeyCreate) body: PasskeyCreateBody, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#create('partner', body, me, reply);
  }

  @Post('v1/ops/auth/passkeys')
  @Roles(OPS_ROLES)
  @HttpCode(201)
  opsCreate(@ContractBody(PasskeyCreate) body: PasskeyCreateBody, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    return this.#create('ops', body, me, reply);
  }

  @Delete('v1/partner/auth/passkeys/:passkeyId')
  @Roles(PARTNER_ROLES)
  @HttpCode(204)
  partnerRemove(@Param('passkeyId') passkeyId: string, @Headers('x-reauth-token') token: string | undefined, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#remove('partner', passkeyId, token, me, reply);
  }

  @Delete('v1/ops/auth/passkeys/:passkeyId')
  @Roles(OPS_ROLES)
  @HttpCode(204)
  opsRemove(@Param('passkeyId') passkeyId: string, @Headers('x-reauth-token') token: string | undefined, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    return this.#remove('ops', passkeyId, token, me, reply);
  }

  async #reauth(aud: AdminAud, body: ReauthBody, me: Principal, req: FastifyRequest, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    if ('reauthStep' in body) {
      let o: ReauthFinishOutcome;
      try {
        o = await this.reauth.finish({ aud, accountId: me.accountId, sessionId: me.sessionId, reauthStep: body.reauthStep, credential: body.credential });
      } catch (e) {
        return unavailable(e);
      }
      switch (o.kind) {
        case 'DONE':
          return { next: 'DONE', reauthToken: o.reauthToken, factors: o.factors, expiresInSeconds: o.expiresInSeconds };
        case 'STEP_INVALID':
          throw new ProblemError({ type: 'reauth-step-invalid', status: 410, title: '처음부터 다시 인증해 주세요', normalBranch: true });
        case 'ASSERTION_INVALID':
          throw new ProblemError({ type: 'passkey-assertion-invalid', status: 422, title: '패스키를 확인하지 못했습니다', normalBranch: true });
        case 'LOCKED':
          return locked(o);
        case 'SESSION_INVALID':
          return sessionInvalid(reply);
      }
    }
    let o: ReauthStartOutcome;
    try {
      o = await this.reauth.start({ aud, accountId: me.accountId, sessionId: me.sessionId, act: body.act, password: body.password, code: body.code, withPasskey: body.withPasskey ?? false, ip: clientIpOf(req) });
    } catch (e) {
      return unavailable(e);
    }
    switch (o.kind) {
      case 'DONE':
        return { next: 'DONE', reauthToken: o.reauthToken, factors: o.factors, expiresInSeconds: o.expiresInSeconds };
      case 'PASSKEY':
        return { next: 'PASSKEY', reauthStep: o.reauthStep, publicKey: o.publicKey, expiresInSeconds: o.expiresInSeconds };
      case 'NO_PASSKEY':
        throw new ProblemError({ type: 'passkey-not-registered', status: 409, title: '등록한 패스키가 없습니다', normalBranch: true });
      case 'PASSWORD_INVALID':
        throw new ProblemError({ type: 'current-password-invalid', status: 422, title: '지금 비밀번호가 맞지 않습니다', normalBranch: true });
      case 'CODE_INVALID':
        throw new ProblemError({ type: 'reauth-code-invalid', status: 422, title: '인증 앱 코드가 맞지 않습니다', normalBranch: true, extensions: { remainingAttempts: o.remainingAttempts } });
      case 'LOCKED':
        return locked(o);
      case 'BUSY':
        throw new ProblemError({ type: 'admin-login-busy', status: 429, title: '잠시 뒤 다시 시도해 주세요', normalBranch: true, retryAfterSeconds: 1 });
      case 'SESSION_INVALID':
        return sessionInvalid(reply);
    }
  }

  async #begin(aud: AdminAud, token: string | undefined, me: Principal, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    let o;
    try {
      o = await this.passkeys.beginRegistration({ aud, accountId: me.accountId, sessionId: me.sessionId, reauthToken: token ?? '' });
    } catch (e) {
      return unavailable(e);
    }
    switch (o.kind) {
      case 'OK':
        return { registrationId: o.registrationId, publicKey: o.publicKey, expiresInSeconds: o.expiresInSeconds };
      case 'LIMIT':
        throw new ProblemError({ type: 'passkey-limit', status: 409, title: '패스키는 10개까지 등록할 수 있습니다', normalBranch: true });
      case 'REAUTH_REQUIRED':
        return reauthRequired();
      case 'SESSION_INVALID':
        return sessionInvalid(reply);
    }
  }

  async #list(me: Principal, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    return { items: (await this.passkeys.list(me.accountId)).map(view) };
  }

  async #create(aud: AdminAud, body: PasskeyCreateBody, me: Principal, reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    let o: FinishRegistrationOutcome;
    try {
      o = await this.passkeys.finishRegistration({ aud, accountId: me.accountId, sessionId: me.sessionId, registrationId: body.registrationId, credential: body.credential, ...(body.name === undefined ? {} : { name: body.name }) });
    } catch (e) {
      return unavailable(e);
    }
    switch (o.kind) {
      case 'OK':
        return view(o.passkey);
      case 'REGISTRATION_INVALID':
        throw new ProblemError({ type: 'passkey-registration-invalid', status: 410, title: '처음부터 다시 등록해 주세요', normalBranch: true });
      case 'ATTESTATION_INVALID':
        throw new ProblemError({ type: 'passkey-attestation-invalid', status: 422, title: '패스키를 등록하지 못했습니다', normalBranch: true });
      case 'EXISTS':
        throw new ProblemError({ type: 'passkey-exists', status: 409, title: '이미 등록한 패스키입니다', normalBranch: true });
      case 'LIMIT':
        throw new ProblemError({ type: 'passkey-limit', status: 409, title: '패스키는 10개까지 등록할 수 있습니다', normalBranch: true });
      case 'NAME_INVALID':
        throw new RequestValidationError('passkey-name');
      case 'SESSION_INVALID':
        return sessionInvalid(reply);
    }
  }

  async #remove(aud: AdminAud, passkeyId: string, token: string | undefined, me: Principal, reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    const o = await this.passkeys.remove({ aud, accountId: me.accountId, sessionId: me.sessionId, passkeyId, reauthToken: token ?? '' });
    switch (o.kind) {
      case 'OK':
        return;
      case 'NOT_FOUND':
        throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
      case 'LAST':
        throw new ProblemError({ type: 'last-passkey', status: 409, title: '마지막 패스키는 지울 수 없습니다', normalBranch: true });
      case 'REAUTH_REQUIRED':
        return reauthRequired();
      case 'SESSION_INVALID':
        return sessionInvalid(reply);
    }
  }
}
