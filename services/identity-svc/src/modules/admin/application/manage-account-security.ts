// F-07-13 SCR-020 '내 계정'의 파트너 보안 유스케이스(openapi /v1/partner/auth/security-settings·totp-*·recovery-codes·sessions,
// identity §6·§8, ASVS 6.3.3·6.4.4·7.4.3·7.5.1·7.5.2). 재인증은 ManagePasskeys와 같은 ACCOUNT_SECURITY 차례를 쓴다.
// 이 기능은 활성 계정이 자기 인증 앱·복구 코드·로그인 기기를 다루는 길만 연다. 초대 수락·운영자 관리 계정 경로는 F-09-6 몫이다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { accountSecurityAllows } from '../domain/passkey.js';
import {
  ADMIN_MANAGEMENT_STORE,
  ADMIN_PASSKEY_STORE,
  ADMIN_REAUTH_VERIFIER,
  ADMIN_SECOND_STEP_STORE,
  ADMIN_SESSION_STORE,
  type AdminAud,
  type AdminLoginAccount,
  type AdminManagementStore,
  type AdminPasskeyRow,
  type AdminPasskeyStore,
  AdminReauthRejected,
  type AdminReauthVerifier,
  type AdminSecondStepStore,
  type AdminSessionStore,
  ROLES_OF_AUD,
  RECOVERY_CODE_HASHER,
  TOTP_SEED_CIPHER,
  type AdminPasswords,
  type TotpSeedCipher,
} from '../domain/ports.js';
import { matchTotp, newRecoveryCode, newTotpSeed, normalizeRecoveryCode, otpauthUri, RECOVERY_CODE_COUNT } from '../domain/totp.js';
import { ADMIN_SESSION_IDLE_MS, ADMIN_SESSION_LIMIT } from './login-second-step.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOTP_PENDING_LIMIT = 5;

export type AccountSecurityErrorCode =
  | 'REAUTH_REQUIRED'
  | 'SESSION_ENDED'
  | 'ENROLLMENT_INVALID'
  | 'CODE_INVALID'
  | 'TOTP_NOT_REGISTERED'
  | 'SESSION_NOT_FOUND';

export class AccountSecurityError extends Error {
  constructor(readonly code: AccountSecurityErrorCode, readonly remainingAttempts?: number) {
    super(code);
    this.name = 'AccountSecurityError';
  }
}

export interface PartnerSecuritySettingsView {
  totpRegistered: boolean;
  recoveryCodesRemaining: number;
  passkeyCount: number;
  sessionLimit: number;
}

export interface PartnerDeviceSessionView {
  sessionId: string;
  deviceName: string | null;
  lastActiveAt: string;
  current: boolean;
  otherSessions: number;
}

type Account = AdminLoginAccount & { email: string };

@Injectable()
export class ManageAccountSecurity {
  constructor(
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly second: AdminSecondStepStore,
    @Inject(ADMIN_SESSION_STORE) private readonly sessions: AdminSessionStore,
    @Inject(ADMIN_PASSKEY_STORE) private readonly passkeys: AdminPasskeyStore,
    @Inject(ADMIN_MANAGEMENT_STORE) private readonly management: AdminManagementStore,
    @Inject(ADMIN_REAUTH_VERIFIER) private readonly verifier: AdminReauthVerifier,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(RECOVERY_CODE_HASHER) private readonly recovery: AdminPasswords,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async settings(accountId: string): Promise<PartnerSecuritySettingsView> {
    const account = await this.second.findLoginById(accountId);
    if (!account || account.status !== 'ACTIVE') throw new AccountSecurityError('SESSION_ENDED');
    const totp = await this.second.getTotp(accountId);
    const codes = await this.second.listRecoveryCodes(accountId);
    const passkeys = await this.passkeys.listPasskeys(accountId);
    return { totpRegistered: Boolean(totp?.seedEnc), recoveryCodesRemaining: codes.length, passkeyCount: passkeys.length, sessionLimit: ADMIN_SESSION_LIMIT };
  }

  async beginTotp(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }): Promise<{ otpauthUri: string }> {
    const now = this.clock.now();
    const { account } = await this.#authorize(i, now);
    const seed = newTotpSeed();
    try {
      const enc = await this.cipher.encrypt(account.id, seed);
      if (!(await this.second.setTotpPending(account.id, enc, now, i.sessionId))) throw new AccountSecurityError('SESSION_ENDED');
      return { otpauthUri: otpauthUri(seed, account.email) };
    } finally {
      seed.fill(0);
    }
  }

  async confirmTotp(i: { accountId: string; sessionId: string; code: string }): Promise<{ recoveryCodes: string[] }> {
    const now = this.clock.now();
    const totp = await this.second.getTotp(i.accountId);
    if (!totp?.pendingEnc || totp.pendingSessionId !== i.sessionId) throw new AccountSecurityError('ENROLLMENT_INVALID');
    const seed = await this.cipher.decrypt(i.accountId, totp.pendingEnc);
    let step: number | null;
    try {
      step = matchTotp(seed, i.code, now, null);
    } finally {
      seed.fill(0);
    }
    if (step === null) {
      const failed = await this.second.recordTotpPendingFailure(i.accountId, i.sessionId, TOTP_PENDING_LIMIT, now);
      if (failed.invalidated) throw new AccountSecurityError('ENROLLMENT_INVALID');
      throw new AccountSecurityError('CODE_INVALID', Math.max(0, TOTP_PENDING_LIMIT - failed.failures));
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const recoveryPhcs = await Promise.all(codes.map((c) => this.recovery.hash(i.accountId, normalizeRecoveryCode(c)!)));
    const done = await this.second.confirmTotpForSession({ accountId: i.accountId, sessionId: i.sessionId, seedEnc: totp.pendingEnc, step, recoveryPhcs, now });
    if (!done) throw new AccountSecurityError('ENROLLMENT_INVALID');
    return { recoveryCodes: codes };
  }

  async recreateRecoveryCodes(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }): Promise<{ recoveryCodes: string[] }> {
    const now = this.clock.now();
    const { account } = await this.#authorize(i, now);
    const totp = await this.second.getTotp(account.id);
    if (!totp?.seedEnc) throw new AccountSecurityError('TOTP_NOT_REGISTERED');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const recoveryPhcs = await Promise.all(codes.map((c) => this.recovery.hash(account.id, normalizeRecoveryCode(c)!)));
    if (!(await this.second.replaceRecoveryCodes(account.id, recoveryPhcs, now))) throw new AccountSecurityError('SESSION_ENDED');
    return { recoveryCodes: codes };
  }

  async listSessions(i: { aud: AdminAud; accountId: string; sessionId: string }): Promise<PartnerDeviceSessionView[]> {
    const now = this.clock.now();
    if (!(await this.#sessionAlive(i.aud, i.accountId, i.sessionId, now))) throw new AccountSecurityError('SESSION_ENDED');
    const live = await this.management.liveSessions(i.accountId, now);
    const groups = new Map<string, typeof live>();
    for (const row of live) {
      const list = groups.get(row.pairRef) ?? [];
      list.push(row);
      groups.set(row.pairRef, list);
    }
    const out: PartnerDeviceSessionView[] = [];
    for (const rows of groups.values()) {
      const currentRow = rows.find((r) => r.id === i.sessionId);
      const latest = rows.reduce((a, b) => (b.idleExpiresAt > a.idleExpiresAt ? b : a));
      const representative = currentRow ?? latest;
      out.push({
        sessionId: representative.id,
        deviceName: representative.deviceLabel ?? latest.deviceLabel,
        lastActiveAt: new Date(latest.idleExpiresAt - ADMIN_SESSION_IDLE_MS).toISOString(),
        current: Boolean(currentRow),
        otherSessions: rows.length - 1,
      });
    }
    return out.sort((a, b) => (a.current === b.current ? Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) : a.current ? -1 : 1));
  }

  async endSession(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string; targetSessionId: string }): Promise<{ ended: number }> {
    if (!UUID.test(i.targetSessionId)) throw new AccountSecurityError('SESSION_NOT_FOUND');
    const target = i.targetSessionId.toLowerCase();
    const now = this.clock.now();
    // 404는 재인증 토큰을 쓰지 않는다: 대상을 먼저 보고, 없으면 토큰 확인 전에 끝낸다
    const live = await this.management.liveSessions(i.accountId, now);
    const currentRow = live.find((s) => s.id === i.sessionId);
    const targetRow = live.find((s) => s.id === target);
    if (!currentRow || !targetRow) throw new AccountSecurityError('SESSION_NOT_FOUND');
    if (targetRow.pairRef === currentRow.pairRef && live.filter((s) => s.pairRef === targetRow.pairRef && s.id !== i.sessionId).length === 0) {
      throw new AccountSecurityError('SESSION_NOT_FOUND');
    }
    const token = await this.#authorizeToken(i, now);
    const done = await this.management.endDeviceSessions({
      accountId: i.accountId,
      currentSessionId: i.sessionId,
      targetSessionId: target,
      now,
      reauth: { jti: token.jti, accountId: i.accountId, sessionId: i.sessionId },
    });
    if (done.kind === 'NOT_FOUND') throw new AccountSecurityError('SESSION_NOT_FOUND');
    if (done.kind === 'REAUTH_REQUIRED') throw new AccountSecurityError('REAUTH_REQUIRED');
    return { ended: done.ended.length };
  }

  /** 세션·계정·콘솔·토큰·한 번 쓰기·패스키 요소를 ManagePasskeys와 같은 차례로 본다 */
  async #authorize(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }, now: number): Promise<{ account: Account; passkeys: AdminPasskeyRow[] }> {
    const token = await this.#authorizeToken(i, now);
    const factors = await this.passkeys.useReauth(token.jti, token.account.id, i.sessionId, 'ACCOUNT_SECURITY', now);
    if (!factors) throw new AccountSecurityError('REAUTH_REQUIRED');
    if (!accountSecurityAllows(factors, token.passkeys.length > 0)) throw new AccountSecurityError('REAUTH_REQUIRED');
    return { account: token.account, passkeys: token.passkeys };
  }

  /** 토큰 서명·세션·계정·패스키 요소까지만 본다(한 번 쓰기는 부르는 쪽 트랜잭션에서) */
  async #authorizeToken(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }, now: number): Promise<{ account: Account; passkeys: AdminPasskeyRow[]; jti: string }> {
    const account = await this.second.findLoginById(i.accountId);
    if (!account || account.status !== 'ACTIVE' || !ROLES_OF_AUD[i.aud].includes(account.role)) throw new AccountSecurityError('SESSION_ENDED');
    if (!(await this.#sessionAlive(i.aud, i.accountId, i.sessionId, now))) throw new AccountSecurityError('SESSION_ENDED');
    let v: { jti: string; accountId: string };
    try {
      v = await this.verifier.verify(i.reauthToken, { aud: i.aud, sessionId: i.sessionId, act: 'ACCOUNT_SECURITY' });
    } catch (e) {
      if (e instanceof AdminReauthRejected) throw new AccountSecurityError('REAUTH_REQUIRED');
      throw e;
    }
    if (v.accountId !== account.id) throw new AccountSecurityError('REAUTH_REQUIRED');
    const rows = await this.passkeys.listPasskeys(account.id);
    const factors = await this.#reauthFactors(v.jti, account.id, i.sessionId, now);
    if (!accountSecurityAllows(factors, rows.length > 0)) throw new AccountSecurityError('REAUTH_REQUIRED');
    return { account, passkeys: rows, jti: v.jti };
  }

  /** 한 번 쓰기 전에 그 토큰의 factors를 읽는다. 없으면 REAUTH_REQUIRED(토큰을 쓰지 않는다) */
  async #reauthFactors(jti: string, accountId: string, sessionId: string, now: number): Promise<string[]> {
    const factors = await this.passkeys.peekReauth(jti, accountId, sessionId, 'ACCOUNT_SECURITY', now);
    if (!factors) throw new AccountSecurityError('REAUTH_REQUIRED');
    return factors;
  }

  async #sessionAlive(aud: AdminAud, accountId: string, sessionId: string, now: number): Promise<boolean> {
    const s = await this.sessions.findSession(sessionId);
    return Boolean(s && s.accountId === accountId && s.aud === aud && s.terminatedAt === null && s.idleExpiresAt > now && s.absoluteExpiresAt > now);
  }
}
