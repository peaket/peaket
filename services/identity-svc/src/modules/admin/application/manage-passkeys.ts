// 내 패스키 등록·목록·지우기(openapi /v1/{partner,ops}/auth/passkey-registrations·/passkeys, identity §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, ADR-0206).
// 등록 시작과 지우기는 작업 묶음 ACCOUNT_SECURITY의 재인증 토큰을 받는다: 그 세션·그 콘솔이고 factors에 password·totp, 패스키가 이미 있으면 passkey도.
// 토큰은 identity가 한 번만 받는다(admin_reauth.used_at). 등록 마치기는 등록 ID(그 세션에서 5분 한 번)와 브라우저가 만든 자격을 확인한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { accountSecurityAllows, normalizePasskeyName, PASSKEY_LIMIT, PASSKEY_REQUIRED_ROLES, type RelyingParties, WEBAUTHN_CHALLENGE_BYTES, WEBAUTHN_CHALLENGE_TTL_MS } from '../domain/passkey.js';
import {
  ADMIN_PASSKEY_STORE,
  ADMIN_REAUTH_VERIFIER,
  type AdminAccountStore,
  type AdminAud,
  type AdminLoginAccount,
  type AdminPasskeyRow,
  type AdminPasskeyStore,
  AdminReauthRejected,
  type AdminReauthVerifier,
  type AdminSecondStepStore,
  type AdminSessionStore,
  PASSKEY_CHALLENGES,
  type PasskeyChallenges,
  ROLES_OF_AUD,
  WEBAUTHN,
  WEBAUTHN_RPS,
  type WebAuthnCeremonies,
} from '../domain/ports.js';

/** openapi format: uuid는 대문자도 맞으므로 대소문자를 가리지 않고 받아 소문자로 맞춘다(새 맥락 리뷰 2026-11-05) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashOf = (handle: string) => createHash('sha256').update(handle, 'utf8').digest('hex');

/** 밖으로 내는 패스키 한 줄(공개키·자격 ID 원문은 싣지 않는다) */
export interface PasskeyView {
  passkeyId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
  deviceType: 'singleDevice' | 'multiDevice';
  transports: string[];
}
export const passkeyViewOf = (p: AdminPasskeyRow): PasskeyView => ({ passkeyId: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, backedUp: p.backedUp, deviceType: p.deviceType, transports: [...p.transports] });

type Denied = { kind: 'REAUTH_REQUIRED' } | { kind: 'SESSION_INVALID' };
export type BeginRegistrationOutcome = { kind: 'OK'; registrationId: string; publicKey: Record<string, unknown>; expiresInSeconds: number } | Denied | { kind: 'LIMIT' };
export type FinishRegistrationOutcome =
  | { kind: 'OK'; passkey: PasskeyView }
  | { kind: 'REGISTRATION_INVALID' }
  | { kind: 'ATTESTATION_INVALID' }
  | { kind: 'EXISTS' }
  | { kind: 'LIMIT' }
  | { kind: 'NAME_INVALID' }
  | { kind: 'SESSION_INVALID' };
export type RemovePasskeyOutcome = { kind: 'OK' } | Denied | { kind: 'NOT_FOUND' } | { kind: 'LAST' };

type Store = AdminAccountStore & AdminSecondStepStore & AdminSessionStore & AdminPasskeyStore;

@Injectable()
export class ManagePasskeys {
  constructor(
    @Inject(ADMIN_PASSKEY_STORE) private readonly store: Store,
    @Inject(PASSKEY_CHALLENGES) private readonly challenges: PasskeyChallenges,
    @Inject(WEBAUTHN) private readonly webauthn: WebAuthnCeremonies,
    @Inject(WEBAUTHN_RPS) private readonly rps: RelyingParties,
    @Inject(ADMIN_REAUTH_VERIFIER) private readonly verifier: AdminReauthVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws PasskeyChallengesUnavailable(받는 층이 503으로) */
  async beginRegistration(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }): Promise<BeginRegistrationOutcome> {
    const now = this.clock.now();
    const ok = await this.#authorize(i, now);
    if ('kind' in ok) return ok;
    if (ok.passkeys.length >= PASSKEY_LIMIT) return { kind: 'LIMIT' };
    const row = await this.store.get(ok.account.id);
    const challenge = randomBytes(WEBAUTHN_CHALLENGE_BYTES);
    const registrationId = randomBytes(32).toString('base64url');
    const publicKey = await this.webauthn.creationOptions({
      rp: this.rps[i.aud],
      challenge,
      // 사용자 ID는 관리 계정 ID 16바이트(개인정보를 담지 않는다), 사용자 이름은 업무 이메일
      userId: Buffer.from(ok.account.id.replace(/-/g, ''), 'hex'),
      userName: ok.account.email,
      userDisplayName: row?.displayName ?? ok.account.email,
      exclude: ok.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
      timeoutMs: WEBAUTHN_CHALLENGE_TTL_MS,
    });
    await this.challenges.put('REG', hashOf(registrationId), { kind: 'REG', accountId: ok.account.id, sessionId: i.sessionId, aud: i.aud, challenge: challenge.toString('base64url'), expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS }, WEBAUTHN_CHALLENGE_TTL_MS);
    return { kind: 'OK', registrationId, publicKey, expiresInSeconds: WEBAUTHN_CHALLENGE_TTL_MS / 1000 };
  }

  /** @throws PasskeyChallengesUnavailable(받는 층이 503으로) */
  async finishRegistration(i: { aud: AdminAud; accountId: string; sessionId: string; registrationId: string; credential: unknown; name?: string }): Promise<FinishRegistrationOutcome> {
    const now = this.clock.now();
    const name = normalizePasskeyName(i.name);
    if (name === null) return { kind: 'NAME_INVALID' };
    // 맞든 틀리든 한 번: 꺼내며 지운다
    const c = await this.challenges.take('REG', hashOf(i.registrationId), now);
    if (!c || c.accountId !== i.accountId || c.sessionId !== i.sessionId || c.aud !== i.aud) return { kind: 'REGISTRATION_INVALID' };
    const account = await this.#account(i.aud, i.accountId);
    if (!account || !(await this.#sessionAlive(i.aud, i.accountId, i.sessionId, now))) return { kind: 'SESSION_INVALID' };
    const v = await this.webauthn.verifyCreation({ rp: this.rps[i.aud], challenge: c.challenge, response: i.credential });
    if (!v) return { kind: 'ATTESTATION_INVALID' };
    // 같은 자격 ID가 어느 계정에든 있으면 넣지 않는다(고유 색인이 동시 넣기도 막는다)
    if (await this.store.findPasskeyByCredential(v.credentialId)) return { kind: 'EXISTS' };
    const row: AdminPasskeyRow = { id: randomUUID(), accountId: account.id, ...v, name, createdAt: now, lastUsedAt: null };
    const r = await this.store.addPasskey(row, PASSKEY_LIMIT, now);
    if (r === 'ADDED') return { kind: 'OK', passkey: passkeyViewOf(row) };
    if (r === 'NOT_ACTIVE') return { kind: 'SESSION_INVALID' };
    return { kind: r };
  }

  async list(accountId: string): Promise<PasskeyView[]> {
    return (await this.store.listPasskeys(accountId)).map(passkeyViewOf);
  }

  async remove(i: { aud: AdminAud; accountId: string; sessionId: string; passkeyId: string; reauthToken: string }): Promise<RemovePasskeyOutcome> {
    const now = this.clock.now();
    // 꼴이 틀린 ID는 토큰을 쓰기 전에 거절한다(되돌릴 수 없는 한 번 쓰기를 헛되이 하지 않게)
    if (!UUID.test(i.passkeyId)) return { kind: 'NOT_FOUND' };
    const passkeyId = i.passkeyId.toLowerCase();
    const ok = await this.#authorize(i, now);
    if ('kind' in ok) return ok;
    const r = await this.store.removePasskey(ok.account.id, passkeyId, PASSKEY_REQUIRED_ROLES, now);
    return r === 'REMOVED' ? { kind: 'OK' } : { kind: r };
  }

  /**
   * ACCOUNT_SECURITY 재인증 토큰을 본다: 서명·그 콘솔·그 세션·작업 묶음, 토큰 주인, 한 번 쓰기(DB의 factors), 지금 패스키에 맞는 요소.
   * 차례: 세션 → 토큰 확인 → 쓰기(되돌리지 않는다) → 요소 판정. 쓴 뒤의 거절(요소 모자람)도 토큰을 다시 받지 않는다
   */
  async #authorize(i: { aud: AdminAud; accountId: string; sessionId: string; reauthToken: string }, now: number): Promise<{ account: AdminLoginAccount & { email: string }; passkeys: AdminPasskeyRow[] } | Denied> {
    const account = await this.#account(i.aud, i.accountId);
    if (!account || !(await this.#sessionAlive(i.aud, i.accountId, i.sessionId, now))) return { kind: 'SESSION_INVALID' };
    let v: { jti: string; accountId: string };
    try {
      v = await this.verifier.verify(i.reauthToken, { aud: i.aud, sessionId: i.sessionId, act: 'ACCOUNT_SECURITY' });
    } catch (e) {
      if (e instanceof AdminReauthRejected) return { kind: 'REAUTH_REQUIRED' };
      throw e;
    }
    if (v.accountId !== account.id) return { kind: 'REAUTH_REQUIRED' };
    const factors = await this.store.useReauth(v.jti, account.id, i.sessionId, 'ACCOUNT_SECURITY', now);
    if (!factors) return { kind: 'REAUTH_REQUIRED' };
    const passkeys = await this.store.listPasskeys(account.id);
    if (!accountSecurityAllows(factors, passkeys.length > 0)) return { kind: 'REAUTH_REQUIRED' };
    return { account, passkeys };
  }

  async #account(aud: AdminAud, accountId: string): Promise<(AdminLoginAccount & { email: string }) | null> {
    const a = await this.store.findLoginById(accountId);
    return a && a.status === 'ACTIVE' && ROLES_OF_AUD[aud].includes(a.role) ? a : null;
  }

  async #sessionAlive(aud: AdminAud, accountId: string, sessionId: string, now: number): Promise<boolean> {
    const s = await this.store.findSession(sessionId);
    return Boolean(s && s.accountId === accountId && s.aud === aud && s.terminatedAt === null && s.idleExpiresAt > now && s.absoluteExpiresAt > now);
  }
}
