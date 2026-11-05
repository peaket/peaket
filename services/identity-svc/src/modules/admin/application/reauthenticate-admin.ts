// 관리 계정 재인증(openapi POST /v1/partner/auth/reauthentications·/v1/ops/auth/reauthentications, identity §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, I-T53, ADR-0206).
// 1단계(start): 같은 처리 중 임대 안에서 세션·잠김을 다시 보고 비밀번호와 TOTP를 확인한다. 틀리면 로그인 실패처럼 센다(auth-controls §3.1).
//   패스키를 요청하지 않으면 바로 재인증 토큰(factors password·totp). 요청하면 챌린지(32바이트, 5분 한 번)와 확인 옵션을 준다.
// 2단계(finish): 챌린지를 꺼내며 지우고(한 번), 그 계정 패스키의 서명을 확인한다(출처·RP ID·사용자 확인). 서명이 맞은 뒤 서명 횟수 퇴행을 본다.
//   통과하면 factors password·totp·passkey 토큰. 패스키 확인 실패는 로그인 실패 수에 세지 않는다(서명은 맞혀 볼 수 없고 1단계부터 다시 해야 한다).
// 토큰마다 재인증 기록(admin_reauth)을 적는다. 기록을 적지 못하면 토큰을 주지 않는다.
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { activeLock, nextTimedLockMs, onPasswordFailure, onSecondFactorFailure, remainingBeforeLock } from '../domain/login-rules.js';
import { ADMIN_REAUTH_TTL_MS, REAUTH_ACTS_OF_AUD, type ReauthAct, type ReauthFactor, type RelyingParties, signCountAccepted, WEBAUTHN_CHALLENGE_BYTES, WEBAUTHN_CHALLENGE_TTL_MS } from '../domain/passkey.js';
import {
  ADMIN_LOGIN_SIGNALS,
  ADMIN_PASSKEY_STORE,
  ADMIN_PASSWORDS,
  ADMIN_TOKEN_SIGNER,
  type AdminAud,
  type AdminLoginAccount,
  type AdminLoginSignals,
  type AdminLoginStore,
  type AdminPasskeyStore,
  type AdminPasswords,
  type AdminSecondStepStore,
  type AdminSessionRow,
  type AdminSessionStore,
  type AdminReauthSigner,
  LOGIN_COUNTERS,
  type LoginCounters,
  PASSKEY_CHALLENGES,
  type PasskeyChallenges,
  ROLES_OF_AUD,
  TOTP_SEED_CIPHER,
  type TotpSeedCipher,
  TotpSeedUnreadable,
  WEBAUTHN,
  WEBAUTHN_RPS,
  type WebAuthnCeremonies,
} from '../domain/ports.js';
import { matchTotp } from '../domain/totp.js';
import { emailKeyOf, failureLimitsOf, shortHash, signalPasswordFailure, sourceAddressOf } from './login-password-step.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

const BUSY_LEASE_MS = 30_000;
const secondsUntil = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));
export const handleHashOf = (handle: string) => createHash('sha256').update(handle, 'utf8').digest('hex');

type Locked = { kind: 'LOCKED'; lock: 'TIMED'; retryAfterSeconds: number } | { kind: 'LOCKED'; lock: 'PROTECT' };
export type ReauthDone = { kind: 'DONE'; reauthToken: string; factors: ReauthFactor[]; expiresInSeconds: number };
export type ReauthStartOutcome =
  | ReauthDone
  | { kind: 'PASSKEY'; reauthStep: string; publicKey: Record<string, unknown>; expiresInSeconds: number }
  /** 패스키를 요청했는데 등록한 패스키가 없다(비밀번호를 보기 전, 409) */
  | { kind: 'NO_PASSKEY' }
  /** 그 콘솔의 활성 계정·살아 있는 같은 세션이 아니다(401) */
  | { kind: 'SESSION_INVALID' }
  | { kind: 'PASSWORD_INVALID' }
  | { kind: 'CODE_INVALID'; remainingAttempts: number }
  | Locked
  | { kind: 'BUSY' };
export type ReauthFinishOutcome = ReauthDone | { kind: 'STEP_INVALID' } | { kind: 'ASSERTION_INVALID' } | { kind: 'SESSION_INVALID' } | { kind: 'LOCKED'; lock: 'PROTECT' };

type Store = AdminSecondStepStore & AdminLoginStore & AdminSessionStore & AdminPasskeyStore;
type Ctx = { aud: AdminAud; accountId: string; email: string; pair: string; ipHash: string };

@Injectable()
export class ReauthenticateAdmin {
  constructor(
    @Inject(ADMIN_PASSKEY_STORE) private readonly store: Store,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(ADMIN_PASSWORDS) private readonly passwords: AdminPasswords,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(PASSKEY_CHALLENGES) private readonly challenges: PasskeyChallenges,
    @Inject(WEBAUTHN) private readonly webauthn: WebAuthnCeremonies,
    @Inject(WEBAUTHN_RPS) private readonly rps: RelyingParties,
    @Inject(ADMIN_TOKEN_SIGNER) private readonly signer: AdminReauthSigner,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws LoginCountersUnavailable·PepperUnavailable·TotpKeyUnavailable·PasskeyChallengesUnavailable(받는 층이 503으로) */
  async start(i: { aud: AdminAud; accountId: string; sessionId: string; act: ReauthAct; password: string; code: string; withPasskey: boolean; ip: string }): Promise<ReauthStartOutcome> {
    if (!REAUTH_ACTS_OF_AUD[i.aud].includes(i.act)) throw new Error(`${i.aud} 콘솔이 받지 않는 작업 묶음이다: ${i.act}`);
    const lease = await this.counters.acquire(i.accountId, this.clock.now(), BUSY_LEASE_MS);
    if (!lease) return { kind: 'BUSY' };
    try {
      return await this.#start(i);
    } finally {
      await this.counters.release(i.accountId, lease).catch(() => undefined);
    }
  }

  async #start(i: { aud: AdminAud; accountId: string; sessionId: string; act: ReauthAct; password: string; code: string; withPasskey: boolean; ip: string }): Promise<ReauthStartOutcome> {
    const now = this.clock.now();
    const account = await this.#account(i.aud, i.accountId);
    const session = account && (await this.#session(i.aud, i.accountId, i.sessionId, now));
    if (!account || !session) return { kind: 'SESSION_INVALID' };
    const c: Ctx = { aud: i.aud, accountId: account.id, email: account.email, pair: session.pairRef, ipHash: shortHash(sourceAddressOf(i.ip)) };
    // 잠김: 비밀번호를 보지 않고 거절하고 세지 않는다(보호 잠금이면 재인증 토큰을 주지 않는다, auth-controls §3.2)
    const lock = activeLock(account.state, now);
    if (lock?.kind === 'PROTECT') return this.#locked(i.aud, { kind: 'LOCKED', lock: 'PROTECT' });
    const peek = await this.counters.peek({ subject: account.id, pair: c.pair, ipHash: c.ipHash, now });
    const until = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, peek.pairLockedUntil !== null && peek.pairLockedUntil > now ? peek.pairLockedUntil : 0);
    if (until > now) return this.#locked(i.aud, { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(until, now) });
    // 패스키를 요청했는데 없으면 비밀번호를 보기 전에 답한다(인증 앱 코드도 쓰지 않는다)
    const passkeys = i.withPasskey ? await this.store.listPasskeys(account.id) : [];
    if (i.withPasskey && passkeys.length === 0) return { kind: 'NO_PASSKEY' };
    if (!account.passwordPhc || !(await this.passwords.verify(account.id, i.password, account.passwordPhc))) return this.#passwordFailed(c, now);
    // 인증 앱 코드: TOTP 6자리만(복구 코드는 받지 않는다). 받은 시간 칸을 적어 다시 받지 않는다
    const code = i.code.replace(/\s/g, '');
    const t = /^\d{6}$/.test(code) ? await this.store.getTotp(account.id) : null;
    if (!t?.seedEnc) return this.#codeFailed(c, now);
    let seed: Buffer;
    try {
      seed = await this.cipher.decrypt(account.id, t.seedEnc);
    } catch (e) {
      if (e instanceof TotpSeedUnreadable) {
        // 그 계정으로 풀 수 없는 시드: 어떤 코드로도 통과하지 못한다. 보안 경보만 남기고 세지 않는다(로그인 2단계와 같다)
        this.signals.alert('totp_seed_unreadable');
        return { kind: 'CODE_INVALID', remainingAttempts: remainingBeforeLock(account.state, this.cfg, true) };
      }
      throw e;
    }
    const step = matchTotp(seed, code, now, t.lastStep);
    seed.fill(0);
    if (step === null || !(await this.store.recordTotpStep(account.id, step, now))) return this.#codeFailed(c, now);
    const factors: ReauthFactor[] = ['password', 'totp'];
    if (!i.withPasskey) return this.#issue({ aud: i.aud, accountId: account.id, sessionId: i.sessionId, act: i.act }, factors, null, now);
    // 패스키 단계: 챌린지(32바이트)와 그 계정 패스키만 허용한 확인 옵션
    const challenge = randomBytes(WEBAUTHN_CHALLENGE_BYTES);
    const reauthStep = randomBytes(32).toString('base64url');
    const publicKey = await this.webauthn.requestOptions({ rp: this.rps[i.aud], challenge, allow: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })), timeoutMs: WEBAUTHN_CHALLENGE_TTL_MS });
    await this.challenges.put(
      'REAUTH',
      handleHashOf(reauthStep),
      { kind: 'REAUTH', accountId: account.id, sessionId: i.sessionId, aud: i.aud, challenge: challenge.toString('base64url'), expiresAt: now + WEBAUTHN_CHALLENGE_TTL_MS, act: i.act, factors, allow: passkeys.map((p) => p.id) },
      WEBAUTHN_CHALLENGE_TTL_MS,
    );
    return { kind: 'PASSKEY', reauthStep, publicKey, expiresInSeconds: WEBAUTHN_CHALLENGE_TTL_MS / 1000 };
  }

  /** @throws TotpKeyUnavailable(관리 토큰 키 없음)·PasskeyChallengesUnavailable(받는 층이 503으로) */
  async finish(i: { aud: AdminAud; accountId: string; sessionId: string; reauthStep: string; credential: { rawId?: unknown } & Record<string, unknown> }): Promise<ReauthFinishOutcome> {
    const now = this.clock.now();
    // 맞든 틀리든 한 번: 꺼내며 지운다
    const c = await this.challenges.take('REAUTH', handleHashOf(i.reauthStep), now);
    if (!c || c.accountId !== i.accountId || c.sessionId !== i.sessionId || c.aud !== i.aud || !c.act || !c.factors) return { kind: 'STEP_INVALID' };
    const account = await this.#account(i.aud, i.accountId);
    if (!account || !(await this.#session(i.aud, i.accountId, i.sessionId, now))) return { kind: 'SESSION_INVALID' };
    if (activeLock(account.state, now)?.kind === 'PROTECT') return this.#locked(i.aud, { kind: 'LOCKED', lock: 'PROTECT' });
    const rawId = typeof i.credential.rawId === 'string' && /^[A-Za-z0-9_-]{1,1366}$/.test(i.credential.rawId) ? Buffer.from(i.credential.rawId, 'base64url') : null;
    const passkey = rawId && (await this.store.findPasskeyByCredential(rawId));
    // 남의 자격, 단계를 만든 뒤 지운 패스키, 허용 목록 밖은 서명을 보지 않고 거절한다
    if (!passkey || passkey.accountId !== account.id || !(c.allow ?? []).includes(passkey.id)) return this.#assertionFailed(i.aud);
    const v = await this.webauthn.verifyRequest({ rp: this.rps[i.aud], challenge: c.challenge, response: i.credential, credential: { id: passkey.credentialId, publicKey: passkey.publicKey, transports: passkey.transports } });
    if (!v) return this.#assertionFailed(i.aud);
    // 서명이 맞은 뒤에 서명 횟수를 본다(위조한 응답으로 경보를 울리지 못하게, ADR-0206 결정 7)
    if (!signCountAccepted(passkey.signCount, v.signCount)) {
      this.signals.alert('passkey_counter_regression');
      return this.#assertionFailed(i.aud);
    }
    // 읽은 값과 같을 때만 고친다: 같은 서명을 동시에 두 번 내도 하나만 통과한다
    if (!(await this.store.recordPasskeyUse(passkey.id, passkey.signCount, v.signCount, v.backedUp, now))) return this.#assertionFailed(i.aud);
    return this.#issue({ aud: i.aud, accountId: account.id, sessionId: i.sessionId, act: c.act }, [...c.factors, 'passkey'], passkey.id, now);
  }

  /** 그 콘솔 역할의 활성 계정 */
  async #account(aud: AdminAud, accountId: string): Promise<(AdminLoginAccount & { email: string }) | null> {
    const a = await this.store.findLoginById(accountId);
    return a && a.status === 'ACTIVE' && ROLES_OF_AUD[aud].includes(a.role) ? a : null;
  }

  /** 그 계정·그 콘솔의 살아 있는 세션(가드의 역할 캐시 5초 안에서 끝난 세션을 다시 본다) */
  async #session(aud: AdminAud, accountId: string, sessionId: string, now: number): Promise<AdminSessionRow | null> {
    const s = await this.store.findSession(sessionId);
    return s && s.accountId === accountId && s.aud === aud && s.terminatedAt === null && s.idleExpiresAt > now && s.absoluteExpiresAt > now ? s : null;
  }

  async #issue(c: { aud: AdminAud; accountId: string; sessionId: string; act: ReauthAct }, factors: ReauthFactor[], passkeyId: string | null, now: number): Promise<ReauthDone> {
    const t = await this.signer.reauth({ ...c, factors }, now);
    await this.store.recordReauth({ jti: t.jti, accountId: c.accountId, sessionId: c.sessionId, aud: c.aud, act: c.act, factors, passkeyId, issuedAt: now, expiresAt: t.expiresAt });
    this.signals.reauthIssued?.(c.aud, factors.includes('passkey') ? 'password_totp_passkey' : 'password_totp');
    return { kind: 'DONE', reauthToken: t.token, factors, expiresInSeconds: ADMIN_REAUTH_TTL_MS / 1000 };
  }

  #locked<T extends Locked>(aud: AdminAud, o: T): T {
    this.signals.failure(aud, 'locked');
    return o;
  }

  #assertionFailed(aud: AdminAud): { kind: 'ASSERTION_INVALID' } {
    this.signals.failure(aud, 'passkey');
    return { kind: 'ASSERTION_INVALID' };
  }

  /** 비밀번호가 틀렸다: 로그인 실패와 같이 계정 실패 수·묶음 실패 수·누계에 세고 같은 경보·알림을 낸다(비밀번호 바꾸기와 같다) */
  async #passwordFailed(c: Ctx, now: number): Promise<ReauthStartOutcome> {
    const box: { d?: ReturnType<typeof onPasswordFailure> } = {};
    const written = await this.store.updateLoginState(c.accountId, now, (cur) => {
      if (activeLock(cur, now)) return null;
      box.d = onPasswordFailure(cur, now, this.cfg);
      return { next: box.d.next, notices: box.d.notices };
    });
    if (!written) return { kind: 'SESSION_INVALID' };
    if (!box.d) return this.#lockedOf(c.aud, written, now);
    const lock = activeLock(box.d.next, now);
    const rec = await this.counters.recordFailure({
      subject: c.accountId,
      pair: c.pair,
      ipHash: c.ipHash,
      emailHash: shortHash(emailKeyOf(c.email)),
      now,
      accountLockedUntil: lock?.kind === 'TIMED' ? lock.until : null,
      pairLockMs: nextTimedLockMs(box.d.next, now, this.cfg),
      limits: failureLimitsOf(this.cfg),
    });
    await signalPasswordFailure(this.signals, this.store, { accountId: c.accountId, aud: c.aud, notices: box.d.notices, rec, now });
    if (lock?.kind === 'PROTECT') return { kind: 'LOCKED', lock: 'PROTECT' };
    const lockedUntil = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, rec.pairLockedUntil ?? 0);
    if (lockedUntil > now) return { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(lockedUntil, now) };
    return { kind: 'PASSWORD_INVALID' };
  }

  /** 인증 앱 코드가 틀렸다: 로그인 2단계 실패와 같이 계정 실패 수·묶음 실패 수·2단계 실패 수에 센다(5 [가정]면 보호 잠금) */
  async #codeFailed(c: Ctx, now: number): Promise<ReauthStartOutcome> {
    const box: { d?: ReturnType<typeof onSecondFactorFailure> } = {};
    const written = await this.store.updateLoginState(c.accountId, now, (cur) => {
      if (activeLock(cur, now)) return null;
      box.d = onSecondFactorFailure(cur, now, this.cfg);
      return { next: box.d.next, notices: box.d.notices };
    });
    if (!written) return { kind: 'SESSION_INVALID' };
    if (!box.d) return this.#lockedOf(c.aud, written, now);
    const lock = activeLock(box.d.next, now);
    const rec = await this.counters.recordFailure({
      subject: c.accountId,
      pair: c.pair,
      ipHash: c.ipHash,
      emailHash: shortHash(emailKeyOf(c.email)),
      now,
      accountLockedUntil: lock?.kind === 'TIMED' ? lock.until : null,
      pairLockMs: nextTimedLockMs(box.d.next, now, this.cfg),
      limits: failureLimitsOf(this.cfg),
    });
    this.signals.failure(c.aud, 'second_factor');
    if (rec.newAccountAlert) {
      this.signals.alert('multi_source');
      await this.store.addNotice(c.accountId, 'MULTI_SOURCE_ALERT', now);
    }
    if (rec.newSourceAlert) this.signals.alert('source');
    if (rec.newGlobalAlert) this.signals.alert('global');
    // 이번에 보호 잠금이면 그것을 먼저 알린다(로그인 2단계와 같다)
    if (lock?.kind === 'PROTECT') {
      this.signals.alert('protect_lock');
      return { kind: 'LOCKED', lock: 'PROTECT' };
    }
    const lockedUntil = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, rec.pairLockedUntil ?? 0);
    if (lockedUntil > now) return { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(lockedUntil, now) };
    return { kind: 'CODE_INVALID', remainingAttempts: Math.max(0, Math.min(remainingBeforeLock(box.d.next, this.cfg, true), this.cfg.pairLockAfterFailures - rec.pairFailures)) };
  }

  /** 확인하는 사이 다른 시도가 잠갔다: 세지 않고 지금 잠금으로 답한다 */
  #lockedOf(aud: AdminAud, state: AdminLoginAccount['state'], now: number): ReauthStartOutcome {
    const l = activeLock(state, now);
    if (l?.kind === 'PROTECT') return this.#locked(aud, { kind: 'LOCKED', lock: 'PROTECT' });
    return this.#locked(aud, { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(l?.kind === 'TIMED' ? l.until : now, now) });
  }
}
