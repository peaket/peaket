// 받는 층: 관리 계정 초대 수락(openapi /v1/{partner,ops}/auth/invitation-*, F-09-6 BOT-152).
// 공개 작업이라 세션·재인증 토큰 대신 초대 토큰·단계 토큰이 자격이다. gw-partner·gw-ops가 Origin을 확인한다.
// 응답은 캐시하지 않고, 토큰·비밀번호·TOTP 시드·복구 코드 원문(확인 응답 제외)을 본문에 싣지 않는다.
import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { AcceptAdminInvitation, InvitationAcceptanceError } from '../application/accept-admin-invitation.js';
import { REJECTION_TEXT } from '../application/admin-password-error.js';
import type { PasskeyView } from '../application/manage-passkeys.js';
import type { AdminAud } from '../domain/ports.js';

const b64u = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const b64uOpt = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/).optional();
const step43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const extensions = z.record(z.string(), z.unknown());

const StartBody = z.object({ invitationToken: step43 }).strict();
const PasswordBody = z
  .object({
    acceptanceStep: step43,
    password: z.string().min(15).max(256),
  })
  .strict();
const StepBody = z.object({ acceptanceStep: step43 }).strict();
const ConfirmBody = z.object({ acceptanceStep: step43, code: z.string().regex(/^[0-9]{6}$/) }).strict();
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
const PasskeyFinishBody = z
  .object({
    acceptanceStep: step43,
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
const CompleteBody = z
  .object({
    acceptanceStep: step43,
    recoveryCodesSaved: z.literal(true),
    displayName: z
      .string()
      .min(1)
      .max(60)
      .refine((s) => [...s].length <= 30)
      .optional(),
  })
  .strict();

const StartView = z
  .object({
    acceptanceStep: step43,
    expiresInSeconds: z.number().int().positive(),
    emailMasked: z.string(),
    displayName: z.string(),
    role: z.string(),
    promoterName: z.null(),
    passkeyRequired: z.boolean(),
    next: z.literal('PASSWORD'),
  })
  .strict();
const PasswordView = z.object({ next: z.literal('TOTP') }).strict();
const TotpEnrollView = z.object({ otpauthUri: z.string() }).strict();
const TotpConfirmView = z.object({ recoveryCodes: z.array(z.string()), next: z.literal('PASSKEY') }).strict();
const PasskeyBeginView = z.object({ registrationId: step43, publicKey: z.record(z.string(), z.unknown()), expiresInSeconds: z.number().int().positive() }).strict();
const PasskeyViewSchema = z
  .object({
    passkeyId: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    backedUp: z.boolean(),
    deviceType: z.enum(['singleDevice', 'multiDevice']),
    transports: z.array(z.string()),
  })
  .strict();
const NoBody = z.object({}).strict();

/** 계약 본문 검사를 이 컨트롤러에서 직접 해 `invalid-body` Problem으로 맞춘다(공용 ContractBody는 about:blank 400이다) */
function bodyOf<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
  return r.data;
}

const problem = (e: unknown): never => {
  if (e instanceof InvitationAcceptanceError) {
    switch (e.code) {
      case 'INVITATION_INVALID':
        throw new ProblemError({ type: 'invitation-invalid', status: 410, title: '초대가 만료되었거나 쓸 수 없습니다' });
      case 'STEP_INVALID':
        throw new ProblemError({ type: 'invitation-step-invalid', status: 410, title: '처음부터 다시 해 주세요' });
      case 'STEP_OUT_OF_ORDER':
        throw new ProblemError({ type: 'invitation-step-out-of-order', status: 409, title: '앞 단계를 먼저 마쳐 주세요' });
      case 'PASSWORD_REJECTED':
        throw new ProblemError({
          type: 'password-rejected',
          status: 422,
          title: '쓸 수 없는 비밀번호입니다',
          extensions: { reason: e.detail.reason ?? 'CONTEXT', advice: e.detail.reason ? REJECTION_TEXT[e.detail.reason] : REJECTION_TEXT.CONTEXT },
        });
      case 'CODE_INVALID':
        throw new ProblemError({ type: 'reauth-code-invalid', status: 422, title: '인증 앱 코드가 맞지 않습니다', extensions: { remainingAttempts: e.detail.remainingAttempts ?? 0 } });
      case 'PASSKEY_REQUIRED':
        throw new ProblemError({ type: 'passkey-not-registered', status: 409, title: '패스키를 먼저 등록해 주세요' });
      case 'PASSKEY_LIMIT':
        throw new ProblemError({ type: 'passkey-limit', status: 409, title: '패스키를 더 등록할 수 없습니다' });
      case 'PASSKEY_EXISTS':
        throw new ProblemError({ type: 'passkey-exists', status: 409, title: '이미 등록한 패스키입니다' });
      case 'PASSKEY_NAME_INVALID':
        throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
      case 'ATTESTATION_INVALID':
        throw new ProblemError({ type: 'passkey-attestation-invalid', status: 422, title: '패스키 등록을 확인하지 못했습니다' });
      case 'REGISTRATION_INVALID':
        throw new ProblemError({ type: 'passkey-registration-invalid', status: 410, title: '패스키 등록을 처음부터 다시 해 주세요' });
      case 'UNAVAILABLE':
        throw new ProblemError({ type: 'admin-login-unavailable', status: 503, title: '잠시 뒤 다시 시도해 주세요', retryAfterSeconds: 5 });
    }
  }
  throw e;
};

const passkeyView = (p: PasskeyView) => ({
  passkeyId: p.passkeyId,
  name: p.name,
  createdAt: new Date(p.createdAt).toISOString(),
  lastUsedAt: p.lastUsedAt === null ? null : new Date(p.lastUsedAt).toISOString(),
  backedUp: p.backedUp,
  deviceType: p.deviceType,
  transports: p.transports,
});

@Controller()
export class AdminInvitationController {
  constructor(private readonly invitations: AcceptAdminInvitation) {}

  // ── 파트너 콘솔 ──
  @Post('v1/partner/auth/invitation-acceptances')
  @ContractRouteSchema({ responses: { 201: StartView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  partnerStart(@Body() raw: unknown): Promise<object> {
    return this.#start('partner', bodyOf(StartBody, raw));
  }

  @Post('v1/partner/auth/invitation-passwords')
  @ContractRouteSchema({ responses: { 200: PasswordView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  partnerPassword(@Body() raw: unknown): Promise<object> {
    return this.#password('partner', bodyOf(PasswordBody, raw));
  }

  @Post('v1/partner/auth/invitation-totp-enrollments')
  @ContractRouteSchema({ responses: { 201: TotpEnrollView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  partnerTotpBegin(@Body() raw: unknown): Promise<object> {
    return this.#totpBegin('partner', bodyOf(StepBody, raw));
  }

  @Post('v1/partner/auth/invitation-totp-confirmations')
  @ContractRouteSchema({ responses: { 200: TotpConfirmView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  partnerTotpConfirm(@Body() raw: unknown): Promise<object> {
    return this.#totpConfirm('partner', bodyOf(ConfirmBody, raw));
  }

  @Post('v1/partner/auth/invitation-passkey-registrations')
  @ContractRouteSchema({ responses: { 201: PasskeyBeginView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  partnerPasskeyBegin(@Body() raw: unknown): Promise<object> {
    return this.#passkeyBegin('partner', bodyOf(StepBody, raw));
  }

  @Post('v1/partner/auth/invitation-passkeys')
  @ContractRouteSchema({ responses: { 201: PasskeyViewSchema } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  partnerPasskeyFinish(@Body() raw: unknown): Promise<object> {
    return this.#passkeyFinish('partner', bodyOf(PasskeyFinishBody, raw));
  }

  @Post('v1/partner/auth/invitation-completions')
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  partnerComplete(@Body() raw: unknown): Promise<void> {
    return this.#complete('partner', bodyOf(CompleteBody, raw));
  }

  // ── 관제 콘솔 ──
  @Post('v1/ops/auth/invitation-acceptances')
  @ContractRouteSchema({ responses: { 201: StartView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  opsStart(@Body() raw: unknown): Promise<object> {
    return this.#start('ops', bodyOf(StartBody, raw));
  }

  @Post('v1/ops/auth/invitation-passwords')
  @ContractRouteSchema({ responses: { 200: PasswordView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  opsPassword(@Body() raw: unknown): Promise<object> {
    return this.#password('ops', bodyOf(PasswordBody, raw));
  }

  @Post('v1/ops/auth/invitation-totp-enrollments')
  @ContractRouteSchema({ responses: { 201: TotpEnrollView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  opsTotpBegin(@Body() raw: unknown): Promise<object> {
    return this.#totpBegin('ops', bodyOf(StepBody, raw));
  }

  @Post('v1/ops/auth/invitation-totp-confirmations')
  @ContractRouteSchema({ responses: { 200: TotpConfirmView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  opsTotpConfirm(@Body() raw: unknown): Promise<object> {
    return this.#totpConfirm('ops', bodyOf(ConfirmBody, raw));
  }

  @Post('v1/ops/auth/invitation-passkey-registrations')
  @ContractRouteSchema({ responses: { 201: PasskeyBeginView } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  opsPasskeyBegin(@Body() raw: unknown): Promise<object> {
    return this.#passkeyBegin('ops', bodyOf(StepBody, raw));
  }

  @Post('v1/ops/auth/invitation-passkeys')
  @ContractRouteSchema({ responses: { 201: PasskeyViewSchema } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  opsPasskeyFinish(@Body() raw: unknown): Promise<object> {
    return this.#passkeyFinish('ops', bodyOf(PasskeyFinishBody, raw));
  }

  @Post('v1/ops/auth/invitation-completions')
  @ContractRouteSchema({ responses: { 204: NoBody } })
  @Roles(['public'])
  @Header('Cache-Control', 'no-store')
  @HttpCode(204)
  opsComplete(@Body() raw: unknown): Promise<void> {
    return this.#complete('ops', bodyOf(CompleteBody, raw));
  }

  async #start(aud: AdminAud, body: z.output<typeof StartBody>): Promise<object> {
    try {
      return await this.invitations.start(aud, body.invitationToken);
    } catch (e) {
      return problem(e);
    }
  }

  async #password(aud: AdminAud, body: z.output<typeof PasswordBody>): Promise<object> {
    try {
      return await this.invitations.setPassword(aud, body.acceptanceStep, body.password);
    } catch (e) {
      return problem(e);
    }
  }

  async #totpBegin(aud: AdminAud, body: z.output<typeof StepBody>): Promise<object> {
    try {
      return await this.invitations.beginTotp(aud, body.acceptanceStep);
    } catch (e) {
      return problem(e);
    }
  }

  async #totpConfirm(aud: AdminAud, body: z.output<typeof ConfirmBody>): Promise<object> {
    try {
      return await this.invitations.confirmTotp(aud, body.acceptanceStep, body.code);
    } catch (e) {
      return problem(e);
    }
  }

  async #passkeyBegin(aud: AdminAud, body: z.output<typeof StepBody>): Promise<object> {
    try {
      return await this.invitations.beginPasskey(aud, body.acceptanceStep);
    } catch (e) {
      return problem(e);
    }
  }

  async #passkeyFinish(aud: AdminAud, body: z.output<typeof PasskeyFinishBody>): Promise<object> {
    try {
      return passkeyView(await this.invitations.finishPasskey(aud, body.acceptanceStep, body.registrationId, body.credential, body.name));
    } catch (e) {
      return problem(e);
    }
  }

  async #complete(aud: AdminAud, body: z.output<typeof CompleteBody>): Promise<void> {
    try {
      await this.invitations.complete(aud, body.acceptanceStep, body.recoveryCodesSaved, body.displayName);
    } catch (e) {
      problem(e);
    }
  }
}
