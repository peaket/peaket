// 관리 계정 초대 수락(openapi /v1/{partner,ops}/auth/invitation-*, F-09-6 BOT-152, ADR-0322가 BAT-046으로 미뤄 둔 서버 몫).
// 초대 링크 토큰(43자, SHA-256만 저장) → 30분 단계 토큰 → 비밀번호 → TOTP → 패스키 → 완료 순서다.
// 단계 토큰은 그 초대에만 묶이고, 다시 시작하면 앞서 넣은 비밀번호·TOTP 시드·복구 코드·패스키를 지운다.
// TOTP 실패는 단계에만 세고 계정 로그인 실패·잠금 카운터를 건드리지 않는다. 완료는 세션을 만들지 않는다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type AdminPasswordError, type AdminPasswordRejection, REJECTION_TEXT } from './admin-password-error.js';
import { BeginTotpEnrollment } from './totp-enrollment.js';
import { SetAdminPassword } from './set-admin-password.js';
import { maskAdminEmail, normalizeDisplayName } from './manage-admin-accounts.js';
import { passkeyViewOf, type PasskeyView } from './manage-passkeys.js';
import { matchTotp, newRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from '../domain/totp.js';
import {
  ADMIN_INVITATION_STORE,
  ADMIN_PASSKEY_STORE,
  ADMIN_SECOND_STEP_STORE,
  type AdminAud,
  type AdminInvitationRow,
  type AdminInvitationStore,
  type AdminPasskeyRow,
  type AdminPasskeyStore,
  type AdminPasswords,
  type AdminSecondStepStore,
  PASSKEY_CHALLENGES,
  type PasskeyChallenges,
  RECOVERY_CODE_HASHER,
  ROLES_OF_AUD,
  type TotpSeedCipher,
  TOTP_SEED_CIPHER,
  TotpKeyUnavailable,
  TotpSeedUnreadable,
  WEBAUTHN,
  WEBAUTHN_RPS,
  type WebAuthnCeremonies,
} from '../domain/ports.js';
import { PASSKEY_LIMIT, PASSKEY_REQUIRED_ROLES, normalizePasskeyName, type RelyingParties, WEBAUTHN_CHALLENGE_BYTES, WEBAUTHN_CHALLENGE_TTL_MS } from '../domain/passkey.js';

export const INVITATION_STEP_TTL_MS = 30 * 60_000;
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();

export type InvitationErrorCode =
  | 'INVITATION_INVALID'
  | 'STEP_INVALID'
  | 'STEP_OUT_OF_ORDER'
  | 'PASSWORD_REJECTED'
  | 'CODE_INVALID'
  | 'PASSKEY_REQUIRED'
  | 'PASSKEY_LIMIT'
  | 'PASSKEY_EXISTS'
  | 'PASSKEY_NAME_INVALID'
  | 'ATTESTATION_INVALID'
  | 'REGISTRATION_INVALID'
  | 'UNAVAILABLE';

export class InvitationAcceptanceError extends Error {
  constructor(
    readonly code: InvitationErrorCode,
    readonly detail: { reason?: AdminPasswordRejection; remainingAttempts?: number } = {},
  ) {
    super(code);
    this.name = 'InvitationAcceptanceError';
  }
}

export interface InvitationStartView {
  acceptanceStep: string;
  expiresInSeconds: number;
  emailMasked: string;
  displayName: string;
  role: string;
  promoterName: null;
  passkeyRequired: boolean;
  next: 'PASSWORD';
}

@Injectable()
export class AcceptAdminInvitation {
  constructor(
    @Inject(ADMIN_INVITATION_STORE) private readonly invitations: AdminInvitationStore,
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly second: AdminSecondStepStore,
    @Inject(ADMIN_PASSKEY_STORE) private readonly passkeys: AdminPasskeyStore,
    private readonly passwordSetter: SetAdminPassword,
    private readonly totpBeginner: BeginTotpEnrollment,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(RECOVERY_CODE_HASHER) private readonly recovery: AdminPasswords,
    @Inject(PASSKEY_CHALLENGES) private readonly challenges: PasskeyChallenges,
    @Inject(WEBAUTHN) private readonly webauthn: WebAuthnCeremonies,
    @Inject(WEBAUTHN_RPS) private readonly rps: RelyingParties,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async start(aud: AdminAud, invitationToken: string): Promise<InvitationStartView> {
    const now = this.clock.now();
    const row = await this.invitations.findByInvitationTokenHash(sha256(invitationToken));
    if (!this.#usable(row, aud, now) || row!.inviteExpiresAt === null || row!.inviteExpiresAt <= now) throw new InvitationAcceptanceError('INVITATION_INVALID');
    const step = randomBytes(32).toString('base64url');
    const ok = await this.invitations.resetInvitationAcceptance({ accountId: row!.accountId, stepHash: sha256(step), expiresAt: now + INVITATION_STEP_TTL_MS, now });
    if (!ok) throw new InvitationAcceptanceError('INVITATION_INVALID');
    return {
      acceptanceStep: step,
      expiresInSeconds: INVITATION_STEP_TTL_MS / 1000,
      emailMasked: maskAdminEmail(row!.email),
      displayName: row!.displayName ?? '',
      role: row!.role,
      promoterName: null,
      passkeyRequired: PASSKEY_REQUIRED_ROLES.includes(row!.role),
      next: 'PASSWORD',
    };
  }

  async setPassword(aud: AdminAud, acceptanceStep: string, password: string): Promise<{ next: 'TOTP' }> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'PASSWORD') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    try {
      await this.passwordSetter.run({ accountId: row.accountId, password });
    } catch (e) {
      const p = e as AdminPasswordError;
      if (p.code === 'REJECTED') throw new InvitationAcceptanceError('PASSWORD_REJECTED', { reason: p.reason ?? 'CONTEXT' });
      if (p.code === 'UNAVAILABLE') throw new InvitationAcceptanceError('UNAVAILABLE');
      throw new InvitationAcceptanceError('STEP_INVALID');
    }
    if (!(await this.invitations.advanceInvitationStage({ accountId: row.accountId, from: 'PASSWORD', to: 'TOTP', now: this.clock.now() }))) throw new InvitationAcceptanceError('STEP_INVALID');
    return { next: 'TOTP' };
  }

  async beginTotp(aud: AdminAud, acceptanceStep: string): Promise<{ otpauthUri: string }> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'TOTP') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    try {
      return await this.totpBeginner.run({ accountId: row.accountId });
    } catch {
      throw new InvitationAcceptanceError('STEP_INVALID');
    }
  }

  async confirmTotp(aud: AdminAud, acceptanceStep: string, code: string): Promise<{ recoveryCodes: string[]; next: 'PASSKEY' }> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'TOTP') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    const now = this.clock.now();
    const t = await this.second.getTotp(row.accountId);
    if (!t?.pendingEnc) throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    let seed: Buffer;
    try {
      seed = await this.cipher.decrypt(row.accountId, t.pendingEnc);
    } catch (e) {
      if (e instanceof TotpSeedUnreadable || e instanceof TotpKeyUnavailable) throw new InvitationAcceptanceError('UNAVAILABLE');
      throw e;
    }
    const step = matchTotp(seed, code, now, null);
    seed.fill(0);
    if (step === null) {
      const rec = await this.invitations.recordInvitationCodeFailure(row.accountId, now);
      throw new InvitationAcceptanceError('CODE_INVALID', { remainingAttempts: Math.max(0, 5 - rec.failures) });
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const recoveryPhcs = await Promise.all(codes.map((c) => this.recovery.hash(row.accountId, normalizeRecoveryCode(c)!)));
    if (!(await this.invitations.confirmInvitationTotp({ accountId: row.accountId, seedEnc: t.pendingEnc, step, recoveryPhcs, now }))) {
      throw new InvitationAcceptanceError('CODE_INVALID', { remainingAttempts: 0 });
    }
    return { recoveryCodes: codes, next: 'PASSKEY' };
  }

  async beginPasskey(aud: AdminAud, acceptanceStep: string): Promise<{ registrationId: string; publicKey: Record<string, unknown>; expiresInSeconds: number }> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'PASSKEY') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    const now = this.clock.now();
    const passkeys = await this.passkeys.listPasskeys(row.accountId);
    if (passkeys.length >= PASSKEY_LIMIT) throw new InvitationAcceptanceError('PASSKEY_LIMIT');
    const challenge = randomBytes(WEBAUTHN_CHALLENGE_BYTES);
    const registrationId = randomBytes(32).toString('base64url');
    const publicKey = await this.webauthn.creationOptions({
      rp: this.rps[aud],
      challenge,
      userId: Buffer.from(row.accountId.replace(/-/g, ''), 'hex'),
      userName: row.email,
      userDisplayName: row.displayName ?? row.email,
      exclude: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
      timeoutMs: WEBAUTHN_CHALLENGE_TTL_MS,
    });
    await this.challenges.put(
      'REG',
      handleHashOf(registrationId),
      { kind: 'REG', accountId: row.accountId, sessionId: `invitation:${row.accountId}`, aud, challenge: challenge.toString('base64url'), expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS },
      WEBAUTHN_CHALLENGE_TTL_MS,
    );
    return { registrationId, publicKey, expiresInSeconds: WEBAUTHN_CHALLENGE_TTL_MS / 1000 };
  }

  async finishPasskey(aud: AdminAud, acceptanceStep: string, registrationId: string, credential: unknown, name?: string): Promise<PasskeyView> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'PASSKEY') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    const passkeyName = normalizePasskeyName(name);
    if (passkeyName === null) throw new InvitationAcceptanceError('PASSKEY_NAME_INVALID');
    const now = this.clock.now();
    const c = await this.challenges.take('REG', handleHashOf(registrationId), now);
    if (!c || c.accountId !== row.accountId || c.aud !== aud || c.sessionId !== `invitation:${row.accountId}`) throw new InvitationAcceptanceError('REGISTRATION_INVALID');
    const v = await this.webauthn.verifyCreation({ rp: this.rps[aud], challenge: c.challenge, response: credential });
    if (!v) throw new InvitationAcceptanceError('ATTESTATION_INVALID');
    if (await this.passkeys.findPasskeyByCredential(v.credentialId)) throw new InvitationAcceptanceError('PASSKEY_EXISTS');
    const passkey: AdminPasskeyRow = { id: randomUUID(), accountId: row.accountId, ...v, name: passkeyName, createdAt: now, lastUsedAt: null };
    const r = await this.invitations.addInvitationPasskey(passkey, PASSKEY_LIMIT, now);
    if (r === 'ADDED') return passkeyViewOf(passkey);
    if (r === 'LIMIT') throw new InvitationAcceptanceError('PASSKEY_LIMIT');
    if (r === 'EXISTS') throw new InvitationAcceptanceError('PASSKEY_EXISTS');
    throw new InvitationAcceptanceError('REGISTRATION_INVALID');
  }

  async complete(aud: AdminAud, acceptanceStep: string, displayName?: string): Promise<void> {
    const row = await this.#step(aud, acceptanceStep);
    if (row.stepStage !== 'PASSKEY') throw new InvitationAcceptanceError('STEP_OUT_OF_ORDER');
    if (PASSKEY_REQUIRED_ROLES.includes(row.role) && (await this.passkeys.listPasskeys(row.accountId)).length === 0) throw new InvitationAcceptanceError('PASSKEY_REQUIRED');
    let normalized: string | undefined;
    if (displayName !== undefined) {
      try {
        normalized = normalizeDisplayName(displayName);
      } catch {
        throw new InvitationAcceptanceError('PASSKEY_NAME_INVALID');
      }
    }
    if (!(await this.invitations.completeInvitation({ accountId: row.accountId, ...(normalized !== undefined ? { displayName: normalized } : {}), now: this.clock.now() }))) {
      throw new InvitationAcceptanceError('STEP_INVALID');
    }
  }

  #usable(row: AdminInvitationRow | null, aud: AdminAud, now: number): boolean {
    return row !== null && row.status === 'INVITED' && ROLES_OF_AUD[aud].includes(row.role) && row.inviteExpiresAt !== null && row.inviteExpiresAt > now;
  }

  async #step(aud: AdminAud, acceptanceStep: string): Promise<AdminInvitationRow> {
    const now = this.clock.now();
    const row = await this.invitations.findInvitationStep(sha256(acceptanceStep));
    if (!row || row.status !== 'INVITED' || !ROLES_OF_AUD[aud].includes(row.role) || row.stepExpiresAt === null || row.stepExpiresAt <= now) throw new InvitationAcceptanceError('STEP_INVALID');
    return row;
  }
}

/** 단계·등록 ID는 SHA-256만 저장한다(원문 저장 금지) */
export function handleHashOf(handle: string): string {
  return createHash('sha256').update(handle, 'utf8').digest('hex');
}
