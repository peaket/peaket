// 관리 계정 로그인 2단계(loginStep + 인증 앱 코드·복구 코드, identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120, I-T10).
// 비밀번호가 맞아도 이 단계를 지나지 않으면 세션을 주지 않는다. 1단계와 같은 처리 중 임대 안에서 잠김을 다시 보고, 틀리면 계정 실패 수·묶음 실패 수에 센다(누계에는 세지 않는다).
// 맞으면 그 단계를 쓴 것으로 적고 성공 처리 뒤 관리 세션(동시 2개)과 액세스·리프레시 토큰을 만든다. 2단계 실패 수와 보호 잠금은 BOT-121.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, PASSWORD_CHANGE_SCOPE } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { activeLock, nextTimedLockMs, onSecondFactorFailure, remainingBeforeLock } from '../domain/login-rules.js';
import {
  ADMIN_LOGIN_SIGNALS,
  ADMIN_LOGIN_STORE,
  ADMIN_SECOND_STEP_STORE,
  ADMIN_TOKEN_SIGNER,
  type AdminSessionStore,
  type AdminAud,
  type AdminLoginSignals,
  type AdminLoginStore,
  type AdminPasswords,
  type AdminSecondStepStore,
  type AdminTokenSigner,
  LOGIN_COUNTERS,
  type LoginCounters,
  RECOVERY_CODE_HASHER,
  ROLES_OF_AUD,
  TOTP_SEED_CIPHER,
  type TotpSeedCipher,
  TotpSeedUnreadable,
  type SecondStepUse,
} from '../domain/ports.js';
import { matchTotp, normalizeRecoveryCode } from '../domain/totp.js';
import { emailKeyOf, shortHash, sourceAddressOf } from './login-password-step.js';
import { RecordAdminLoginSuccess } from './record-login-success.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

/** 관리 세션: 최대 수명 24시간, 유휴 만료 1시간, 동시 2개(POL-019) */
export const ADMIN_SESSION_ABSOLUTE_MS = 24 * 60 * 60_000;
export const ADMIN_SESSION_IDLE_MS = 60 * 60_000;
export const ADMIN_SESSION_LIMIT = 2;
const BUSY_LEASE_MS = 30_000;
const SOURCE_WINDOW_MS = 60 * 60_000;
const GLOBAL_WINDOW_MS = 5 * 60_000;

export type SecondStepOutcome =
  | { kind: 'DONE'; sessionId: string; accessToken: string; accessExpiresAt: number; refreshToken: string; absoluteExpiresAt: number }
  | { kind: 'STEP_INVALID' }
  | { kind: 'CODE_INVALID'; remainingAttempts: number }
  | { kind: 'LOCKED'; lock: 'TIMED'; retryAfterSeconds: number }
  | { kind: 'LOCKED'; lock: 'PROTECT' }
  | { kind: 'BUSY' };

const secondsUntil = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));

@Injectable()
export class LoginSecondStep {
  constructor(
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly store: AdminSecondStepStore & AdminLoginStore & AdminSessionStore,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(RECOVERY_CODE_HASHER) private readonly recovery: AdminPasswords,
    private readonly success: RecordAdminLoginSuccess,
    @Inject(ADMIN_TOKEN_SIGNER) private readonly signer: AdminTokenSigner,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws LoginCountersUnavailable·PepperUnavailable·TotpKeyUnavailable(받는 층이 503으로) */
  async run(i: { aud: AdminAud; loginStep: string; code: string; ip: string; deviceId: string }): Promise<SecondStepOutcome> {
    const step = await this.store.findLoginStep(createHash('sha256').update(i.loginStep).digest());
    const now0 = this.clock.now();
    if (!step || step.usedAt !== null || step.expiresAt <= now0 || step.aud !== i.aud) return { kind: 'STEP_INVALID' };
    const lease = await this.counters.acquire(step.accountId, now0, BUSY_LEASE_MS);
    if (!lease) return { kind: 'BUSY' };
    try {
      // 임대를 쥔 뒤 단계를 다시 읽는다: 늦게 들어온 같은 단계가 코드를 먼저 쓰지 못하게(재리뷰 2026-11-05)
      const again = await this.store.findLoginStep(createHash('sha256').update(i.loginStep).digest());
      if (!again || again.usedAt !== null || again.expiresAt <= this.clock.now()) return { kind: 'STEP_INVALID' };
      return await this.#attempt(i, step.id, step.accountId, step.pairRef);
    } finally {
      await this.counters.release(step.accountId, lease).catch(() => undefined);
    }
  }

  async #attempt(i: { aud: AdminAud; code: string; ip: string }, stepId: string, accountId: string, pair: string): Promise<SecondStepOutcome> {
    const now = this.clock.now();
    const account = await this.store.findLoginById(accountId);
    if (!account || account.status !== 'ACTIVE' || !ROLES_OF_AUD[i.aud].includes(account.role)) return { kind: 'STEP_INVALID' };
    const ipHash = shortHash(sourceAddressOf(i.ip));
    // 1단계 뒤 다른 출발지가 잠갔을 수 있다: 잠김을 다시 본다(비밀번호·코드를 보지 않고 세지 않는다)
    const peek = await this.counters.peek({ subject: accountId, pair, ipHash, now });
    const lock = activeLock(account.state, now);
    if (lock?.kind === 'PROTECT') return this.#locked(i.aud, { kind: 'LOCKED', lock: 'PROTECT' });
    const until = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, peek.pairLockedUntil ?? 0);
    if (until > now) return this.#locked(i.aud, { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(until, now) });

    const check = await this.#checkCode(accountId, i.code, now);
    if (check === 'UNREADABLE') return { kind: 'CODE_INVALID', remainingAttempts: remainingBeforeLock(account.state, this.cfg, true) };
    if (check === 'BAD') return this.#failed(accountId, emailKeyOf(account.email), pair, ipHash, i.aud, now);
    // 되돌릴 수 없는 일(시간 칸·복구 코드·단계 소비, 셈 0, 세션·종료 사건) 전에 토큰부터 서명한다: 키가 없으면 아무것도 쓰지 않고 503(새 맥락 리뷰 2026-11-05)
    const sessionId = randomUUID();
    // 비밀번호 바꾸기가 필요하면 그 세션은 비밀번호 바꾸기·로그아웃만(scope password:change, auth-controls §3.5, BOT-123)
    const at = await this.signer.access({ accountId, sessionId, aud: i.aud, ...(account.passwordChangeRequired ? { scopes: [PASSWORD_CHANGE_SCOPE] } : {}) }, now);
    // 코드(같은 시간 칸·같은 복구 코드는 한 번만)·단계(한 번만)·세션을 한 트랜잭션에 쓴다(BOT-120이 넘긴 것: 코드만 쓰이고 단계에서 실패하는 일이 없다).
    // 그 사이 다른 요청이 코드를 썼으면 틀린 코드로 세고, 단계를 썼으면 처음부터다
    const refreshToken = randomBytes(32).toString('base64url');
    const absoluteExpiresAt = now + ADMIN_SESSION_ABSOLUTE_MS;
    const done = await this.store.finishSecondStep(
      { id: sessionId, accountId, aud: i.aud, refreshHash: createHash('sha256').update(refreshToken).digest(), refreshFamily: randomUUID(), pairRef: pair, createdAt: now, absoluteExpiresAt, idleExpiresAt: now + ADMIN_SESSION_IDLE_MS },
      ADMIN_SESSION_LIMIT,
      { stepId, code: check.use },
    );
    if (done.kind === 'CODE_USED') return this.#failed(accountId, emailKeyOf(account.email), pair, ipHash, i.aud, now);
    if (done.kind === 'STEP_USED') return { kind: 'STEP_INVALID' };
    // 세션을 만든 뒤 셈을 0으로(묶음 지우기가 셈 저장소 장애로 실패해도 로그인은 막지 않는다)
    await this.success.run({ accountId, pair });
    // 익숙한 출발지로 적는다(BOT-123)
    await this.store.touchKnownSource(accountId, pair, now);
    return { kind: 'DONE', sessionId, accessToken: at.token, accessExpiresAt: at.expiresAt, refreshToken, absoluteExpiresAt };
  }

  /**
   * 숫자 6자리(띄어 쓴 꼴도)는 TOTP, 아니면 복구 코드. 맞으면 쓸 코드(시간 칸 또는 복구 코드 행)를 돌려준다(적기는 토큰 서명 뒤 finishSecondStep 한 트랜잭션).
   * 시드를 그 계정으로 풀 수 없으면 UNREADABLE(보안 경보, 세지 않는다: 어떤 코드로도 통과하지 못한다)
   */
  async #checkCode(accountId: string, raw: string, now: number): Promise<{ use: SecondStepUse['code'] } | 'BAD' | 'UNREADABLE'> {
    const code = raw.replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) {
      const t = await this.store.getTotp(accountId);
      if (!t?.seedEnc) return 'BAD';
      let seed: Buffer;
      try {
        seed = await this.cipher.decrypt(accountId, t.seedEnc);
      } catch (e) {
        if (e instanceof TotpSeedUnreadable) {
          this.signals.alert('totp_seed_unreadable');
          return 'UNREADABLE';
        }
        throw e;
      }
      const step = matchTotp(seed, code, now, t.lastStep);
      seed.fill(0);
      return step === null ? 'BAD' : { use: { kind: 'totp', step } };
    }
    const normalized = normalizeRecoveryCode(raw);
    if (!normalized) return 'BAD';
    for (const row of await this.store.listRecoveryCodes(accountId)) {
      if (await this.recovery.verify(accountId, normalized, row.phc)) return { use: { kind: 'recovery', rowId: row.id } };
    }
    return 'BAD';
  }

  #locked(aud: AdminAud, o: SecondStepOutcome): SecondStepOutcome {
    this.signals.failure(aud, 'locked');
    return o;
  }

  async #failed(accountId: string, email: string, pair: string, ipHash: string, aud: AdminAud, now: number): Promise<SecondStepOutcome> {
    const box: { d?: ReturnType<typeof onSecondFactorFailure> } = {};
    const written = await this.store.updateLoginState(accountId, now, (cur) => {
      if (activeLock(cur, now)) return null;
      box.d = onSecondFactorFailure(cur, now, this.cfg);
      return { next: box.d.next, notices: box.d.notices };
    });
    if (!written || !box.d) {
      const l = written ? activeLock(written, now) : null;
      if (l?.kind === 'PROTECT') return { kind: 'LOCKED', lock: 'PROTECT' };
      if (l?.kind === 'TIMED') return { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(l.until, now) };
      return { kind: 'STEP_INVALID' };
    }
    const accountLock = activeLock(box.d.next, now);
    const rec = await this.counters.recordFailure({
      subject: accountId,
      pair,
      ipHash,
      emailHash: shortHash(email),
      now,
      accountLockedUntil: accountLock?.kind === 'TIMED' ? accountLock.until : null,
      pairLockMs: nextTimedLockMs(box.d.next, now, this.cfg),
      limits: {
        pairLockAfter: this.cfg.pairLockAfterFailures,
        multiSourceIps: this.cfg.multiSourceIpsPerHour,
        sourceAccounts: this.cfg.sourceAccountsPerHour,
        windowMs: SOURCE_WINDOW_MS,
        accountAlertMs: this.cfg.sourceCaptchaDurationMs,
        sourceAlertMs: this.cfg.sourceCaptchaDurationMs,
        globalFailures: this.cfg.globalAlertFailures,
        globalWindowMs: GLOBAL_WINDOW_MS,
        globalAlertMs: this.cfg.globalCaptchaDurationMs,
      },
    });
    this.signals.failure(aud, 'second_factor');
    if (rec.newAccountAlert) {
      this.signals.alert('multi_source');
      await this.store.addNotice(accountId, 'MULTI_SOURCE_ALERT', now);
    }
    if (rec.newSourceAlert) this.signals.alert('source');
    if (rec.newGlobalAlert) this.signals.alert('global');
    // 이번에 보호 잠금(2단계 실패 수 5 [가정], BOT-121)이면 그것을 먼저 알린다
    if (accountLock?.kind === 'PROTECT') {
      this.signals.alert('protect_lock');
      return { kind: 'LOCKED', lock: 'PROTECT' };
    }
    const lockedUntil = Math.max(accountLock?.kind === 'TIMED' ? accountLock.until : 0, rec.pairLockedUntil ?? 0);
    if (lockedUntil > now) return { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(lockedUntil, now) };
    return { kind: 'CODE_INVALID', remainingAttempts: Math.max(0, Math.min(remainingBeforeLock(box.d.next, this.cfg, true), this.cfg.pairLockAfterFailures - rec.pairFailures)) };
  }
}
