// 관리 계정 비밀번호 바꾸기(openapi POST /v1/partner/auth/password-changes·/v1/ops/auth/password-changes, docs/security/auth-controls.md §3.5·§4, identity §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123, AC-T4).
// 지금 비밀번호가 틀리면 로그인 실패처럼 센다. 맞으면 SetAdminPassword(정책·유출 목록)로 정하고, 그 계정의 다른 관리 세션을 모두 끝내며(PASSWORD_CHANGED),
// 이 세션이 비밀번호 바꾸기 필요 세션(scope password:change)이었으면 스코프 없는 새 액세스 토큰을 준다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PASSWORD_CHANGE_SCOPE, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { activeLock, nextTimedLockMs, onPasswordFailure } from '../domain/login-rules.js';
import {
  ADMIN_LOGIN_SIGNALS,
  ADMIN_PASSWORDS,
  ADMIN_SECOND_STEP_STORE,
  ADMIN_TOKEN_SIGNER,
  type AdminAud,
  type AdminLoginSignals,
  type AdminLoginStore,
  type AdminPasswords,
  type AdminSecondStepStore,
  type AdminSessionStore,
  type AdminTokenSigner,
  LOGIN_COUNTERS,
  type LoginCounters,
  ROLES_OF_AUD,
} from '../domain/ports.js';
import type { AdminPasswordRejection } from './admin-password-error.js';
import { AdminPasswordError } from './admin-password-error.js';
import { emailKeyOf, failureLimitsOf, shortHash, signalPasswordFailure, sourceAddressOf } from './login-password-step.js';
import { ADMIN_AUTH_CONFIG, SetAdminPassword } from './set-admin-password.js';

const BUSY_LEASE_MS = 30_000;
const secondsUntil = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));

type FailCtx = { aud: AdminAud; accountId: string; email: string; pair: string; ipHash: string };

export type ChangePasswordOutcome =
  | { kind: 'CHANGED'; accessToken?: string; absoluteExpiresAt?: number }
  | { kind: 'CURRENT_INVALID' }
  | { kind: 'REJECTED'; reason: AdminPasswordRejection }
  | { kind: 'LOCKED'; retryAfterSeconds: number }
  | { kind: 'PROTECTED' }
  | { kind: 'NOT_FOUND' }
  /** 그 세션이 없거나 끝났거나 만료됐다(가드의 역할 캐시 안에서 끝난 경우, 받는 층이 401) */
  | { kind: 'SESSION_INVALID' }
  | { kind: 'BUSY' };

@Injectable()
export class ChangeAdminPassword {
  constructor(
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly store: AdminSecondStepStore & AdminLoginStore & AdminSessionStore,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(ADMIN_PASSWORDS) private readonly passwords: AdminPasswords,
    private readonly setPassword: SetAdminPassword,
    @Inject(ADMIN_TOKEN_SIGNER) private readonly signer: AdminTokenSigner,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'warn'>,
  ) {}

  /** 같은 비밀번호 거절의 보안 이벤트(정책·유출 거절은 SetAdminPassword가 남긴다, auth-controls §4.3 10, BOT-110이 넘긴 것) */
  #rejected(accountId: string, reason: AdminPasswordRejection): ChangePasswordOutcome {
    this.logger?.warn({ kind: 'security', event: 'admin_password_rejected', accountId, reason }, '관리 계정 새 비밀번호를 거절했다');
    return { kind: 'REJECTED', reason };
  }

  /** @throws AdminPasswordError UNAVAILABLE(유출 목록·페퍼, 받는 층이 503)·LoginCountersUnavailable */
  async run(i: { aud: AdminAud; accountId: string; sessionId: string; scopes: readonly string[]; currentPassword: string; newPassword: string; ip: string }): Promise<ChangePasswordOutcome> {
    const lease = await this.counters.acquire(i.accountId, this.clock.now(), BUSY_LEASE_MS);
    if (!lease) return { kind: 'BUSY' };
    try {
      return await this.#change(i);
    } finally {
      await this.counters.release(i.accountId, lease).catch(() => undefined);
    }
  }

  async #change(i: { aud: AdminAud; accountId: string; sessionId: string; scopes: readonly string[]; currentPassword: string; newPassword: string; ip: string }): Promise<ChangePasswordOutcome> {
    const now = this.clock.now();
    const account = await this.store.findLoginById(i.accountId);
    if (!account || account.status !== 'ACTIVE' || !account.passwordPhc || !ROLES_OF_AUD[i.aud].includes(account.role)) return { kind: 'NOT_FOUND' };
    // 임대 안에서 세션을 다시 본다: 가드의 역할 캐시(5초) 안에서 끝난 세션이 바꾸거나 새 토큰을 받지 않게(재검토 2026-11-05)
    const session = await this.store.findSession(i.sessionId);
    if (!session || session.accountId !== account.id || session.aud !== i.aud || session.terminatedAt !== null || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return { kind: 'SESSION_INVALID' };
    const source = sourceAddressOf(i.ip);
    // 실패는 그 세션이 로그인한 출발지 묶음에 센다(1단계의 묶음과 같은 값, auth-controls §3.1)
    const c: FailCtx = { aud: i.aud, accountId: account.id, email: account.email, pair: session.pairRef, ipHash: shortHash(source) };
    // 잠김: 로그인 1단계와 같이 비밀번호를 보지 않고 거절하고 세지 않는다(시간 잠금·묶음 잠금·보호 잠금, 새 맥락 리뷰 2026-11-05)
    const lock = activeLock(account.state, now);
    if (lock?.kind === 'PROTECT') return this.#locked(i.aud, { kind: 'PROTECTED' });
    const peek = await this.counters.peek({ subject: account.id, pair: c.pair, ipHash: c.ipHash, now });
    const until = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, peek.pairLockedUntil !== null && peek.pairLockedUntil > now ? peek.pairLockedUntil : 0);
    if (until > now) return this.#locked(i.aud, { kind: 'LOCKED', retryAfterSeconds: secondsUntil(until, now) });
    if (!(await this.passwords.verify(account.id, i.currentPassword, account.passwordPhc))) return this.#currentFailed(c, now);
    // 같은 비밀번호로 바꾸기 필요 표시를 끄지 않는다(NFC로 견준다: 저장과 같은 정규화, 새 맥락 리뷰 2026-11-05)
    if (i.newPassword.normalize('NFC') === i.currentPassword.normalize('NFC')) return this.#rejected(account.id, 'SAME_AS_CURRENT');
    try {
      // 파트너 상호·번호(L4)는 판매자 정보가 core-svc에 있어 아직 싣지 않는다: 업무 이메일 도메인의 앞 이름만 본다(identity §6 남는 한계)
      await this.setPassword.run({ accountId: account.id, password: i.newPassword, ...(ROLES_OF_AUD.partner.includes(account.role) ? { partner: { names: [], numbers: [] } } : {}) });
    } catch (e) {
      if (e instanceof AdminPasswordError && e.code === 'REJECTED') return { kind: 'REJECTED', reason: e.reason! };
      if (e instanceof AdminPasswordError && e.code === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
      throw e;
    }
    await this.store.terminateOtherSessions(account.id, i.sessionId, 'PASSWORD_CHANGED', now);
    if (!i.scopes.includes(PASSWORD_CHANGE_SCOPE)) return { kind: 'CHANGED' };
    // 비밀번호 바꾸기 필요 세션이었다: 제한을 푼 새 액세스 토큰(같은 세션)
    const at = await this.signer.access({ accountId: account.id, sessionId: i.sessionId, aud: i.aud }, now);
    return { kind: 'CHANGED', accessToken: at.token, absoluteExpiresAt: session.absoluteExpiresAt };
  }

  #locked(aud: AdminAud, o: ChangePasswordOutcome): ChangePasswordOutcome {
    this.signals.failure(aud, 'locked');
    return o;
  }

  /** 지금 비밀번호가 틀렸다: 로그인 실패와 같이 계정 실패 수·묶음 실패 수·누계에 세고 같은 경보·알림을 낸다(auth-controls §3.1·§3.4) */
  async #currentFailed(c: FailCtx, now: number): Promise<ChangePasswordOutcome> {
    const box: { d?: ReturnType<typeof onPasswordFailure> } = {};
    const written = await this.store.updateLoginState(c.accountId, now, (cur) => {
      // 확인하는 사이 다른 시도가 잠갔으면 세지 않는다
      if (activeLock(cur, now)) return null;
      box.d = onPasswordFailure(cur, now, this.cfg);
      return { next: box.d.next, notices: box.d.notices };
    });
    if (!written) return { kind: 'NOT_FOUND' };
    if (!box.d) {
      const l = activeLock(written, now);
      if (l?.kind === 'PROTECT') return this.#locked(c.aud, { kind: 'PROTECTED' });
      return this.#locked(c.aud, { kind: 'LOCKED', retryAfterSeconds: secondsUntil(l?.kind === 'TIMED' ? l.until : now, now) });
    }
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
    if (lock?.kind === 'PROTECT') return { kind: 'PROTECTED' };
    const lockedUntil = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, rec.pairLockedUntil ?? 0);
    if (lockedUntil > now) return { kind: 'LOCKED', retryAfterSeconds: secondsUntil(lockedUntil, now) };
    return { kind: 'CURRENT_INVALID' };
  }
}
