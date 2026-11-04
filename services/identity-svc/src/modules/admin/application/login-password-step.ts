// 관리 계정 로그인 1단계(이메일·비밀번호, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', docs/security/auth-controls.md §2·§3, BUILD_ORDER BOT-111).
// 차례: 사람 확인이 필요한지 → 잠김 → 비밀번호 확인 → 틀리면 센다 / 맞으면 다시 저장·유출 다시 보기·로그인 단계.
// 없는 계정(없는 이메일, 다른 콘솔 역할, 비밀번호 없는 계정)도 같은 규칙으로 센 가짜 상태로 같은 응답을 준다(§2.2). 원문 비밀번호·IP·이메일은 로그에 쓰지 않는다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { type AccountLoginState, accountNeedsHumanCheck, activeLock, nextTimedLockMs, type NoticeKind, onPasswordFailure } from '../domain/login-rules.js';
import {
  ADMIN_LOGIN_SIGNALS,
  ADMIN_LOGIN_STORE,
  ADMIN_PASSWORDS,
  type AdminAud,
  type AdminLoginAccount,
  type AdminLoginSignals,
  type AdminLoginStore,
  type AdminPasswords,
  BREACH_LIST,
  type BreachList,
  BreachListUnavailable,
  HUMAN_CHECK,
  type HumanCheck,
  LOGIN_COUNTERS,
  type LoginCounters,
  type LoginFailureLimits,
  ROLES_OF_AUD,
} from '../domain/ports.js';
import { ADMIN_AUTH_CONFIG } from './set-admin-password.js';

/** 로그인 단계 토큰 수명 [가정](identity §6) */
export const LOGIN_STEP_TTL_MS = 5 * 60_000;
/** 출발지 창(계정의 출발지 수·출발지의 계정 수, auth-controls §3.1) */
const SOURCE_WINDOW_MS = 60 * 60_000;
/** 전체 실패 창(auth-controls §2.1 C8) */
const GLOBAL_WINDOW_MS = 5 * 60_000;
/** 한 대상의 처리 중 임대 [가정]: 임대 안의 일(DB·PBKDF2·KMS 연결 1초+요청 2초의 다시 시도·다시 저장·유출 목록 2초)보다 넉넉히(재리뷰 2026-11-05) */
const BUSY_LEASE_MS = 30_000;

export type LoginStepOutcome =
  | { kind: 'PASSED'; loginStep: string; expiresInSeconds: number }
  | { kind: 'FAILED'; remainingAttempts: number; humanCheckRequired: boolean }
  | { kind: 'LOCKED'; lock: 'TIMED'; retryAfterSeconds: number }
  | { kind: 'LOCKED'; lock: 'PROTECT' }
  | { kind: 'HUMAN_CHECK_REQUIRED' }
  | { kind: 'HUMAN_CHECK_UNAVAILABLE' }
  /** 같은 대상(계정이나 없는 계정)의 다른 시도가 처리 중이다. 세지 않는다(동시 요청으로 잠금·셈을 건너뛰지 못하게, 새 맥락 리뷰 2026-11-05) */
  | { kind: 'BUSY' };

/** SHA-256 앞 16바이트 16진수(Redis 키와 묶음 값, identity §6) */
export const shortHash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
export const pairRefOf = (ip: string, deviceId: string): string => shortHash(`${ip}\u0000${deviceId}`);
export const emailKeyOf = (email: string): string => email.trim().toLowerCase();

/** IPv6 주소를 표준 꼴(소문자, 줄인 꼴, 점 꼬리 없음)로 맞춘다. WHATWG URL의 IPv6 직렬화를 쓴다. 꼴이 아니면 null */
function canonicalV6(ip: string): string | null {
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}
/** 표준 꼴 IPv6를 여덟 칸 16진수로 편다 */
function expandV6(canon: string): string[] {
  const [head = '', tail] = canon.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - a.length - b.length : 0;
  return [...a, ...Array<string>(Math.max(0, fill)).fill('0'), ...b].map((x) => x.padStart(4, '0'));
}
/**
 * 셈에 쓰는 출발지 주소: IPv4를 적은 IPv6(::ffff:a.b.c.d, 어느 꼴이든)는 그 IPv4로, 다른 IPv6는 앞 /64로 센다(한 사람이 흔히 /64 하나를 받는다, 재리뷰 2026-11-05).
 * IP가 아니면 그대로(묶음 값만 달라진다)
 */
export function sourceAddressOf(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const canon = canonicalV6(ip);
  if (!canon) return ip;
  const parts = expandV6(canon);
  if (parts.length !== 8) return ip;
  if (parts.slice(0, 5).every((x) => x === '0000') && parts[5] === 'ffff') {
    const hi = parseInt(parts[6]!, 16);
    const lo = parseInt(parts[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${parts.slice(0, 4).join(':')}::/64`;
}

const NOTICE_ALERT: Partial<Record<NoticeKind, 'password_failure_notice' | 'protect_lock'>> = { PASSWORD_FAILURE_NOTICE: 'password_failure_notice', PROTECT_LOCK: 'protect_lock' };
const secondsUntil = (until: number, now: number) => Math.max(1, Math.ceil((until - now) / 1000));

type GateCtx = {
  i: { aud: AdminAud; email: string; password: string; ip: string; deviceId: string; humanCheckToken?: string };
  subject: string;
  ghostKey: string;
  emailHash: string;
  pair: string;
  ipHash: string;
};

@Injectable()
export class LoginPasswordStep {
  constructor(
    @Inject(ADMIN_LOGIN_STORE) private readonly store: AdminLoginStore,
    @Inject(LOGIN_COUNTERS) private readonly counters: LoginCounters,
    @Inject(ADMIN_PASSWORDS) private readonly passwords: AdminPasswords,
    @Inject(BREACH_LIST) private readonly breaches: BreachList,
    @Inject(HUMAN_CHECK) private readonly human: HumanCheck,
    @Inject(ADMIN_LOGIN_SIGNALS) private readonly signals: AdminLoginSignals,
    @Inject(ADMIN_AUTH_CONFIG) private readonly cfg: AdminAuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws LoginCountersUnavailable·PepperUnavailable(받는 층이 503으로) */
  async run(i: { aud: AdminAud; email: string; password: string; ip: string; deviceId: string; humanCheckToken?: string }): Promise<LoginStepOutcome> {
    const email = emailKeyOf(i.email);
    const emailHash = shortHash(email);
    // 이 콘솔에서 로그인할 수 있는 계정만 진짜로 다룬다. 나머지는 없는 계정과 같다
    const accountOf = (found: AdminLoginAccount | null) => (found && found.status === 'ACTIVE' && found.passwordPhc && ROLES_OF_AUD[i.aud].includes(found.role) ? found : null);
    const account = accountOf(await this.store.findForLogin(email));
    // 없는 계정의 가짜 상태는 콘솔마다 따로다: 진짜 파트너 계정이 관제 경로에서 새 가짜 상태를 받는 것과 같게(새 맥락 리뷰 2026-11-05)
    const ghostKey = `${i.aud}:${emailHash}`;
    const subject = account ? account.id : `g:${ghostKey}`;
    const source = sourceAddressOf(i.ip);
    const pair = pairRefOf(source, i.deviceId);
    const ipHash = shortHash(source);
    const ctx = { i, subject, ghostKey, emailHash, pair, ipHash };

    // ①② 사람 확인과 잠김은 임대 밖에서 먼저 본다: 검증을 기다리는 동안 임대를 쥐면 틀린 토큰을 이어 보내 주인을 막을 수 있다(재리뷰 2026-11-05)
    const human = { verified: false };
    const pre = await this.#gate(ctx, account, this.clock.now(), human, true);
    if (pre) return pre;
    // 한 대상에 한 번에 한 시도: 잠김 다시 보기 → 확인 → 셈이 다른 시도와 겹치지 않는다. 임대를 쥘 때마다 실패 하나로 세거나 통과한다
    const lease = await this.counters.acquire(subject, this.clock.now(), BUSY_LEASE_MS);
    if (!lease) return { kind: 'BUSY' };
    try {
      // 임대를 쥔 뒤 시각과 계정 상태를 다시 읽는다(없는 계정도 같은 왕복을 한다: 응답 시간을 맞춘다)
      const now = this.clock.now();
      const fresh = accountOf(await this.store.findForLogin(email));
      const current = account && fresh && fresh.id === account.id ? fresh : null;
      const again = await this.#gate(ctx, current, now, human, false);
      if (again) return again;
      return await this.#attempt(ctx, current, now);
    } finally {
      await this.counters.release(subject, lease).catch(() => undefined);
    }
  }

  /**
   * 사람 확인과 잠김. verifyToken이면 사람 확인 토큰을 검증하고(임대 밖, 한 번) human.verified에 적는다.
   * 다시 볼 때(임대 안) 사람 확인이 새로 필요해졌는데 밖에서 검증하지 않았으면 토큰이 있어도 428이다(검증하지 않은 토큰으로 비밀번호 확인까지 가지 않게). 통과하면 null
   */
  async #gate(c: GateCtx, account: AdminLoginAccount | null, now: number, human: { verified: boolean }, verifyToken: boolean): Promise<LoginStepOutcome | null> {
    const peek = await this.counters.peek({ subject: c.subject, pair: c.pair, ipHash: c.ipHash, now });
    const state: AccountLoginState = account ? account.state : await this.counters.ghostState(c.ghostKey, now);
    // ① 사람 확인(§2.3, 이번 시도 전의 값)
    if (accountNeedsHumanCheck(state, now, this.cfg) || peek.accountAlert || peek.sourceAlert || peek.globalAlert) {
      if (!c.i.humanCheckToken) return this.#humanRequired(c.i.aud);
      if (verifyToken) {
        const v = await this.human.verify(c.i.humanCheckToken, { aud: c.i.aud, remoteIp: c.i.ip });
        if (v === 'UNAVAILABLE') return { kind: 'HUMAN_CHECK_UNAVAILABLE' };
        if (v === 'FAILED') return this.#humanRequired(c.i.aud);
        human.verified = true;
      } else if (!human.verified) return this.#humanRequired(c.i.aud);
    }
    // ② 잠김: 비밀번호를 보지 않고 거절하고 세지 않는다
    const lock = activeLock(state, now);
    if (lock?.kind === 'PROTECT') return this.#locked(c.i.aud, { kind: 'LOCKED', lock: 'PROTECT' });
    const until = Math.max(lock?.kind === 'TIMED' ? lock.until : 0, peek.pairLockedUntil !== null && peek.pairLockedUntil > now ? peek.pairLockedUntil : 0);
    if (until > now) return this.#locked(c.i.aud, { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(until, now) });
    return null;
  }

  async #attempt(c: GateCtx, account: AdminLoginAccount | null, now: number): Promise<LoginStepOutcome> {
    const { i, subject, ghostKey, emailHash, pair, ipHash } = c;
    const state: AccountLoginState = account ? account.state : await this.counters.ghostState(ghostKey, now);
    // ③ 비밀번호 확인(없는 계정은 같은 반복의 PBKDF2를 한 번)
    let ok = false;
    if (account) ok = await this.passwords.verify(account.id, i.password, account.passwordPhc!);
    else await this.passwords.burn(i.password);
    if (ok && account) return this.#passed(account, i, pair, now);
    return this.#failed(account, subject, ghostKey, emailHash, pair, ipHash, state, i.aud, now);
  }

  #humanRequired(aud: AdminAud): LoginStepOutcome {
    this.signals.failure(aud, 'human_check');
    return { kind: 'HUMAN_CHECK_REQUIRED' };
  }

  #locked(aud: AdminAud, o: LoginStepOutcome): LoginStepOutcome {
    this.signals.failure(aud, 'locked');
    return o;
  }

  async #failed(account: AdminLoginAccount | null, subject: string, ghostKey: string, emailHash: string, pair: string, ipHash: string, before: AccountLoginState, aud: AdminAud, now: number): Promise<LoginStepOutcome> {
    // ④ 계정에 묶인 값: 있는 계정은 행 잠금 트랜잭션(알림도 같은 트랜잭션), 없는 계정은 가짜 상태
    let next: AccountLoginState;
    let notices: NoticeKind[] = [];
    if (account) {
      const box: { d?: ReturnType<typeof onPasswordFailure> } = {};
      const written = await this.store.updateLoginState(account.id, now, (cur) => {
        // 확인하는 사이 다른 시도가 잠갔으면 세지 않는다
        if (activeLock(cur, now)) return null;
        box.d = onPasswordFailure(cur, now, this.cfg);
        return { next: box.d.next, notices: box.d.notices };
      });
      // 그 사이 계정이 지워졌다: 없는 계정처럼 답한다
      if (!written) return { kind: 'FAILED', remainingAttempts: this.cfg.lockAfterFailures - 1, humanCheckRequired: false };
      if (!box.d) {
        const l = activeLock(written, now);
        if (l?.kind === 'PROTECT') return this.#locked(aud, { kind: 'LOCKED', lock: 'PROTECT' });
        return this.#locked(aud, { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(l?.kind === 'TIMED' ? l.until : now, now) });
      }
      next = written;
      notices = box.d.notices;
    } else {
      const d = onPasswordFailure(before, now, this.cfg);
      next = d.next;
      await this.counters.setGhostState(ghostKey, next, now);
    }
    const accountLock = activeLock(next, now);
    // 출발지가 든 값(Redis)
    const limits: LoginFailureLimits = {
      pairLockAfter: this.cfg.pairLockAfterFailures,
      multiSourceIps: this.cfg.multiSourceIpsPerHour,
      sourceAccounts: this.cfg.sourceAccountsPerHour,
      windowMs: SOURCE_WINDOW_MS,
      accountAlertMs: this.cfg.sourceCaptchaDurationMs,
      sourceAlertMs: this.cfg.sourceCaptchaDurationMs,
      globalFailures: this.cfg.globalAlertFailures,
      globalWindowMs: GLOBAL_WINDOW_MS,
      globalAlertMs: this.cfg.globalCaptchaDurationMs,
    };
    const rec = await this.counters.recordFailure({
      subject,
      pair,
      ipHash,
      emailHash,
      now,
      accountLockedUntil: accountLock?.kind === 'TIMED' ? accountLock.until : null,
      pairLockMs: nextTimedLockMs(next, now, this.cfg),
      limits,
    });
    this.signals.failure(aud, 'password');
    for (const n of notices) {
      const a = NOTICE_ALERT[n];
      if (a) this.signals.alert(a);
    }
    if (rec.newAccountAlert) {
      this.signals.alert('multi_source');
      if (account) await this.store.addNotice(account.id, 'MULTI_SOURCE_ALERT', now);
    }
    if (rec.newSourceAlert) this.signals.alert('source');
    if (rec.newGlobalAlert) this.signals.alert('global');
    // 응답: 이번에 잠겼으면 423, 아니면 401과 남은 수·다음 사람 확인
    if (accountLock?.kind === 'PROTECT') return { kind: 'LOCKED', lock: 'PROTECT' };
    const lockedUntil = Math.max(accountLock?.kind === 'TIMED' ? accountLock.until : 0, rec.pairLockedUntil ?? 0);
    if (lockedUntil > now) return { kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: secondsUntil(lockedUntil, now) };
    const remainingAttempts = Math.max(0, Math.min(this.cfg.lockAfterFailures - next.failedAttempts, this.cfg.pairLockAfterFailures - rec.pairFailures));
    const humanCheckRequired = accountNeedsHumanCheck(next, now, this.cfg) || rec.newAccountAlert || rec.newSourceAlert || rec.newGlobalAlert || (await this.#alertsActive(subject, pair, ipHash, now));
    return { kind: 'FAILED', remainingAttempts, humanCheckRequired };
  }

  async #alertsActive(subject: string, pair: string, ipHash: string, now: number): Promise<boolean> {
    const p = await this.counters.peek({ subject, pair, ipHash, now });
    return p.accountAlert || p.sourceAlert || p.globalAlert;
  }

  async #passed(account: AdminLoginAccount, i: { aud: AdminAud; password: string }, pair: string, now: number): Promise<LoginStepOutcome> {
    // ⑤ 다시 저장(페퍼 판·반복 횟수). 비밀번호 바꾸기 필요 표시는 그대로
    if (this.passwords.needsRehash(account.passwordPhc!)) await this.store.rehash(account.id, await this.passwords.hash(account.id, i.password), now);
    // 로그인 때 유출 다시 보기(§4.3 8·9): 30일 [가정] 지났으면. 닿지 못하면 건너뛰고 다음 로그인에 본다
    if (account.breachCheckedAt === null || now - account.breachCheckedAt >= this.cfg.breachRecheckIntervalMs) {
      try {
        const breached = await this.breaches.isBreached(i.password);
        await this.store.markBreachChecked(account.id, now, breached);
      } catch (e) {
        if (!(e instanceof BreachListUnavailable)) throw e;
      }
    }
    const token = randomBytes(32).toString('base64url');
    await this.store.createLoginStep({ id: randomUUID(), accountId: account.id, tokenHash: createHash('sha256').update(token).digest(), aud: i.aud, pairRef: pair, createdAt: now, expiresAt: now + LOGIN_STEP_TTL_MS });
    return { kind: 'PASSED', loginStep: token, expiresInSeconds: LOGIN_STEP_TTL_MS / 1000 };
  }
}
