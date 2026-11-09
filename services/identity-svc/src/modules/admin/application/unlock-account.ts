// 관리 계정 시간 잠금 본인 해제와 해제 링크 다시 받기(identity §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', docs/security/auth-controls.md §3.3, BUILD_ORDER BOT-121, AC-T5).
// 풀기: 링크(30분·한 번·코드 3번 틀리면 무효) + 인증 앱 코드·복구 코드. 맞으면 시간 잠금만 푼다(묶음 잠금·2단계 실패 수·누계는 그대로). 틀리면 링크와 계정의 2단계 실패 수에 센다.
// 다시 받기: 이메일마다 1시간에 3번(없는 이메일도 같은 수로). 시간 잠금 중인 그 콘솔의 활성 계정이면 UNLOCK_LINK 알림을 적는다(발송 고리가 새 링크를 만든다).
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { activeLock, onSelfUnlock, onUnlockCodeFailure } from '../domain/login-rules.js';
import {
  ADMIN_LOGIN_SIGNALS,
  ADMIN_LOGIN_STORE,
  ADMIN_SECOND_STEP_STORE,
  ADMIN_UNLOCK_STORE,
  type AdminAud,
  type AdminLoginSignals,
  type AdminLoginStore,
  type AdminPasswords,
  type AdminSecondStepStore,
  type AdminUnlockStore,
  LOGIN_COUNTERS,
  type LoginCounters,
  RECOVERY_CODE_HASHER,
  ROLES_OF_AUD,
  TOTP_SEED_CIPHER,
  type TotpSeedCipher,
  TotpSeedUnreadable,
} from '../domain/ports.js';
import { matchTotp, normalizeRecoveryCode } from '../domain/totp.js';
import { emailKeyOf, shortHash } from './login-password-step.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

const BUSY_LEASE_MS = 30_000;
const RESEND_WINDOW_MS = 60 * 60_000;

export type UnlockOutcome = { kind: 'UNLOCKED' } | { kind: 'LINK_INVALID' } | { kind: 'CODE_INVALID'; remainingAttempts: number } | { kind: 'PROTECTED' } | { kind: 'BUSY' };

type Store = AdminUnlockStore & AdminSecondStepStore & AdminLoginStore;

@Injectable()
export class UnlockWithLink {
  constructor(
    @Inject(ADMIN_UNLOCK_STORE) private readonly store: Store,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(RECOVERY_CODE_HASHER) private readonly recovery: AdminPasswords,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws LoginCountersUnavailable·PepperUnavailable·TotpKeyUnavailable(받는 층이 503으로) */
  async run(i: { aud: AdminAud; unlockToken: string; code: string }): Promise<UnlockOutcome> {
    const hash = createHash('sha256').update(i.unlockToken).digest();
    const pre = await this.store.findUnlockLink(hash);
    if (!pre) return { kind: 'LINK_INVALID' };
    const lease = await this.counters.acquire(pre.accountId, this.clock.now(), BUSY_LEASE_MS);
    if (!lease) return { kind: 'BUSY' };
    try {
      return await this.#attempt(i, hash);
    } finally {
      await this.counters.release(pre.accountId, lease).catch(() => undefined);
    }
  }

  async #attempt(i: { aud: AdminAud; code: string }, hash: Buffer): Promise<UnlockOutcome> {
    const now = this.clock.now();
    const link = await this.store.findUnlockLink(hash);
    if (!link || link.usedAt !== null || link.revokedAt !== null || link.expiresAt <= now || link.codeFailures >= this.cfg.unlockLinkCodeAttempts) return { kind: 'LINK_INVALID' };
    const account = await this.store.findLoginById(link.accountId);
    if (!account || account.status !== 'ACTIVE' || !ROLES_OF_AUD[i.aud].includes(account.role)) return { kind: 'LINK_INVALID' };
    const lock = activeLock(account.state, now);
    if (lock?.kind === 'PROTECT') return { kind: 'PROTECTED' };
    // 시간 잠금이 이미 끝났으면 풀 것이 없다(새 맥락 리뷰 2026-11-05)
    if (lock?.kind !== 'TIMED') return { kind: 'LINK_INVALID' };
    const check = await this.#checkCode(link.accountId, i.code, now);
    if (check === 'UNREADABLE') return { kind: 'CODE_INVALID', remainingAttempts: Math.max(0, Math.min(this.cfg.unlockLinkCodeAttempts - link.codeFailures, this.cfg.protectAfterSecondFactorFailures - account.state.secondFactorFailures)) };
    if (check === 'BAD' || !(await check.commit())) return this.#failed(i.aud, link.id, link.accountId, now);
    // 확정 트랜잭션 안에서도 보호 잠금이면 풀지 않는다(앞의 검사와 확정 사이에 걸린 경우)
    if (!(await this.store.useUnlockLink(link.id, link.accountId, now, (cur) => (activeLock(cur, now)?.kind === 'PROTECT' ? null : onSelfUnlock(cur, now)), 'UNLOCKED'))) {
      const again = await this.store.findLoginById(link.accountId);
      return again && activeLock(again.state, now)?.kind === 'PROTECT' ? { kind: 'PROTECTED' } : { kind: 'LINK_INVALID' };
    }
    return { kind: 'UNLOCKED' };
  }

  /** 2단계와 같은 코드 확인(TOTP 지금 칸·재사용 막기, 복구 코드 한 번). 적기는 맞은 뒤 commit으로 */
  async #checkCode(accountId: string, raw: string, now: number): Promise<{ commit: () => Promise<boolean> } | 'BAD' | 'UNREADABLE'> {
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
      return step === null ? 'BAD' : { commit: () => this.store.recordTotpStep(accountId, step, now) };
    }
    const normalized = normalizeRecoveryCode(raw);
    if (!normalized) return 'BAD';
    for (const row of await this.store.listRecoveryCodes(accountId)) {
      if (await this.recovery.verify(accountId, normalized, row.phc)) return { commit: () => this.store.useRecoveryCode(row.id) };
    }
    return 'BAD';
  }

  async #failed(aud: AdminAud, linkId: string, accountId: string, now: number): Promise<UnlockOutcome> {
    const failures = await this.store.failUnlockCode(linkId);
    // 링크에서 틀린 코드는 2단계 실패 수에만 센다(계정 실패 수·시간 잠금 칸은 그대로). 5 [가정]면 보호 잠금
    const box: { protect?: boolean; secondFactor?: number } = {};
    await this.store.updateLoginState(accountId, now, (cur) => {
      if (activeLock(cur, now)?.kind === 'PROTECT') {
        box.protect = true;
        return null;
      }
      const d = onUnlockCodeFailure(cur, now, this.cfg);
      box.protect = d.protect;
      box.secondFactor = d.next.secondFactorFailures;
      return { next: d.next, notices: d.protect ? ['PROTECT_LOCK'] : [] };
    });
    this.signals.failure(aud, 'second_factor');
    if (box.protect) {
      this.signals.alert('protect_lock');
      return { kind: 'PROTECTED' };
    }
    return { kind: 'CODE_INVALID', remainingAttempts: Math.max(0, Math.min(this.cfg.unlockLinkCodeAttempts - failures, this.cfg.protectAfterSecondFactorFailures - (box.secondFactor ?? 0))) };
  }
}

export type ResendOutcome = { kind: 'ACCEPTED' } | { kind: 'RATE_LIMITED'; retryAfterSeconds: number };

@Injectable()
export class RequestUnlockLink {
  constructor(
    @Inject(ADMIN_UNLOCK_STORE) private readonly store: Store,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 계정이 있는지·잠겼는지와 상관없이 같은 답(§2.2). 한도를 넘으면 메일을 보내지 않고 RATE_LIMITED */
  async run(i: { aud: AdminAud; email: string }): Promise<ResendOutcome> {
    const now = this.clock.now();
    const email = emailKeyOf(i.email);
    const r = await this.counters.countResend(shortHash(`${i.aud}:${email}`), now, RESEND_WINDOW_MS, this.cfg.unlockLinkResendPerHour);
    if (!r.allowed) return { kind: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) };
    const account = await this.store.findForLogin(email);
    if (account && account.status === 'ACTIVE' && ROLES_OF_AUD[i.aud].includes(account.role) && activeLock(account.state, now)?.kind === 'TIMED') {
      await this.store.addNotice(account.id, 'UNLOCK_LINK', now);
    }
    return { kind: 'ACCEPTED' };
  }
}
