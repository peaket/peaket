// 관리 계정 컨텍스트의 포트: 비밀번호 해시·확인, 페퍼, 유출 목록, 관리 계정 저장소(identity §6, BUILD_ORDER BOT-110),
// 로그인 1단계의 저장소·실패 셈·사람 확인·운영 신호(BUILD_ORDER BOT-111).
import type { AccountLoginState, NoticeKind } from './login-rules.js';

export type AdminRole = 'partner_admin' | 'partner_member' | 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';
export type AdminStatus = 'INVITED' | 'ACTIVE' | 'INVITE_EXPIRED' | 'REMOVED';

export interface AdminAccountRow {
  id: string;
  role: AdminRole;
  promoterId: string | null;
  status: AdminStatus;
  email: string;
  displayName: string | null;
  passwordPhc: string | null;
  breachCheckedAt: number | null;
}

export const ADMIN_ACCOUNT_STORE = Symbol('identity.AdminAccountStore');
export interface AdminAccountStore {
  get(id: string): Promise<AdminAccountRow | null>;
  /** 비밀번호 저장 문자열과 유출 대조 시각을 삭제하지 않은 계정에만 쓰고 비밀번호 바꾸기 필요 표시를 내린다. 없거나 삭제한 계정이면 false */
  setPassword(i: { id: string; phc: string; breachCheckedAt: number; now: number }): Promise<boolean>;
}

export const ADMIN_PASSWORDS = Symbol('identity.AdminPasswords');
/** PBKDF2 + KMS 페퍼(identity §6 '비밀번호 보안 정책'). 원문은 NFC로 맞춰 쓴다 */
export interface AdminPasswords {
  hash(accountId: string, raw: string): Promise<string>;
  /** 맞으면 true. 모르는 판·꼴이면 false(던지지 않는다). 페퍼 키 서비스가 답하지 않으면 PepperUnavailable */
  verify(accountId: string, raw: string, phc: string): Promise<boolean>;
  /** 쓰기 판이 아니거나 반복 횟수가 기준보다 적으면 true(다음 로그인 때 다시 저장, BOT-111) */
  needsRehash(phc: string): boolean;
  /** 없는 계정에도 같은 반복 횟수의 PBKDF2를 한 번 한다(가짜 솔트, 페퍼 없음. 응답 시간을 맞춘다, auth-controls §2.2) */
  burn(raw: string): Promise<void>;
}

/** 페퍼(KMS HMAC 키, 판마다 따로). mac은 GenerateMac, verify는 VerifyMac */
export interface AdminPepper {
  readonly writeVersion: number;
  has(version: number): boolean;
  mac(version: number, message: Uint8Array): Promise<Buffer>;
  verify(version: number, message: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

/** 페퍼 키 서비스(KMS)에 닿지 못했다 */
export class PepperUnavailable extends Error {
  constructor(cause?: unknown) {
    super('관리자 비밀번호 페퍼 키 서비스에 닿지 못했다', { cause });
    this.name = 'PepperUnavailable';
  }
}

export const BREACH_LIST = Symbol('identity.BreachList');
/** 유출 비밀번호 목록(L2, HIBP 범위 조회). 닿지 못하면 BreachListUnavailable */
export interface BreachList {
  isBreached(raw: string): Promise<boolean>;
}
export class BreachListUnavailable extends Error {
  constructor(cause?: unknown) {
    super('유출 비밀번호 목록에 닿지 못했다', { cause });
    this.name = 'BreachListUnavailable';
  }
}

// ── 로그인 1단계(BUILD_ORDER BOT-111) ──
export type AdminAud = 'partner' | 'ops';
export const ROLES_OF_AUD: Record<AdminAud, readonly AdminRole[]> = {
  partner: ['partner_admin', 'partner_member'],
  ops: ['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'],
};

export interface AdminLoginAccount {
  id: string;
  role: AdminRole;
  status: AdminStatus;
  passwordPhc: string | null;
  breachCheckedAt: number | null;
  passwordChangeRequired: boolean;
  state: AccountLoginState;
}

export const ADMIN_LOGIN_STORE = Symbol('identity.AdminLoginStore');
export interface AdminLoginStore {
  /** 삭제하지 않은 계정을 업무 이메일(소문자·앞뒤 빈칸 제거)로 찾는다 */
  findForLogin(email: string): Promise<AdminLoginAccount | null>;
  /**
   * 행을 잠근 트랜잭션에서 로그인 상태를 고친다. fn이 null이면 고치지 않는다(그 사이 잠겼다 등).
   * 돌려준 알림은 같은 트랜잭션에서 admin_security_notice에 적는다. 계정이 없으면 null
   */
  updateLoginState(id: string, now: number, fn: (cur: AccountLoginState) => { next: AccountLoginState; notices: NoticeKind[] } | null): Promise<AccountLoginState | null>;
  addNotice(id: string, kind: NoticeKind, at: number): Promise<void>;
  /** 다시 저장(페퍼 판·반복 횟수). 비밀번호 바꾸기 필요 표시는 바꾸지 않는다 */
  rehash(id: string, phc: string, now: number): Promise<void>;
  /** 로그인 때 유출 다시 보기의 결과. breached면 비밀번호 바꾸기 필요 표시를 켠다 */
  markBreachChecked(id: string, at: number, breached: boolean): Promise<void>;
  createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number }): Promise<void>;
  /** 비밀번호와 2단계를 모두 통과했다: 계정 실패 수·2단계 실패 수·누계를 0으로, last_login_at을 쓴다 */
  recordLoginSuccess(id: string, at: number): Promise<void>;
}

/** 출발지가 든 값(Redis, auth-controls §3.1)과 없는 계정의 가짜 상태 */
export const LOGIN_COUNTERS = Symbol('identity.LoginCounters');
export interface LoginCountersPeek {
  pairFailures: number;
  pairLockedUntil: number | null;
  accountAlert: boolean;
  sourceAlert: boolean;
  globalAlert: boolean;
}
export interface LoginFailureLimits {
  pairLockAfter: number;
  multiSourceIps: number;
  sourceAccounts: number;
  windowMs: number;
  accountAlertMs: number;
  sourceAlertMs: number;
  globalFailures: number;
  globalWindowMs: number;
  globalAlertMs: number;
}
export interface LoginFailureRecorded {
  pairFailures: number;
  pairLockedUntil: number | null;
  newAccountAlert: boolean;
  newSourceAlert: boolean;
  newGlobalAlert: boolean;
}
export interface LoginCounters {
  peek(i: { subject: string; pair: string; ipHash: string; now: number }): Promise<LoginCountersPeek>;
  /** 실패 하나를 센다. 계정이 이번에 시간 잠금이면 accountLockedUntil, 묶음만 잠그게 되면 pairLockMs 길이로 묶음 잠금 */
  recordFailure(i: { subject: string; pair: string; ipHash: string; emailHash: string; now: number; accountLockedUntil: number | null; pairLockMs: number; limits: LoginFailureLimits }): Promise<LoginFailureRecorded>;
  clearPair(subject: string, pair: string): Promise<void>;
  /** 없는 계정의 가짜 상태. 키는 콘솔마다 따로다(`{aud}:{이메일 해시}`, 새 맥락 리뷰 2026-11-05) */
  ghostState(ghostKey: string, now: number): Promise<AccountLoginState>;
  setGhostState(ghostKey: string, state: AccountLoginState, now: number): Promise<void>;
  /** 한 대상에 한 번에 한 시도만(짧은 임대). 이미 다른 시도가 쥐고 있으면 null */
  acquire(subject: string, now: number, ttlMs: number): Promise<string | null>;
  release(subject: string, token: string): Promise<void>;
}
export class LoginCountersUnavailable extends Error {
  constructor(cause?: unknown) {
    super('관리 계정 로그인 실패 셈 저장소에 닿지 못했다', { cause });
    this.name = 'LoginCountersUnavailable';
  }
}

export const HUMAN_CHECK = Symbol('identity.HumanCheck');
/** 사람 확인(Cloudflare Turnstile 검증 API, auth-controls §2.3) */
export interface HumanCheck {
  verify(token: string, ctx: { aud: AdminAud; remoteIp: string }): Promise<'OK' | 'FAILED' | 'UNAVAILABLE'>;
}

export const ADMIN_LOGIN_SIGNALS = Symbol('identity.AdminLoginSignals');
export type AdminLoginFailureReason = 'password' | 'second_factor' | 'locked' | 'human_check';
export type AdminSecurityAlertKind = 'password_failure_notice' | 'multi_source' | 'protect_lock' | 'source' | 'global' | 'totp_seed_unreadable';
export interface AdminLoginSignals {
  failure(aud: AdminAud, reason: AdminLoginFailureReason): void;
  /** SEV3 보안 경보(관측 단계가 경보 규칙을 붙인다) */
  alert(kind: AdminSecurityAlertKind): void;
}

// ── TOTP와 로그인 2단계(BUILD_ORDER BOT-120) ──
export const TOTP_SEED_CIPHER = Symbol('identity.TotpSeedCipher');
/** TOTP 시드 봉투 암호화(암호화 컨텍스트 {purpose: "peaket-admin-totp-v1", accountId}, identity §6) */
export interface TotpSeedCipher {
  encrypt(accountId: string, seed: Uint8Array): Promise<Buffer>;
  /** 다른 계정의 암호문이거나 깨졌으면 TotpSeedUnreadable, 키 서비스에 닿지 못하면 TotpKeyUnavailable */
  decrypt(accountId: string, blob: Uint8Array): Promise<Buffer>;
}
export class TotpSeedUnreadable extends Error {
  constructor(cause?: unknown) {
    super('TOTP 시드 암호문을 그 계정으로 풀 수 없다', { cause });
    this.name = 'TotpSeedUnreadable';
  }
}
export class TotpKeyUnavailable extends Error {
  constructor(cause?: unknown) {
    super('TOTP 시드 키 서비스에 닿지 못했다', { cause });
    this.name = 'TotpKeyUnavailable';
  }
}

export const RECOVERY_CODE_HASHER = Symbol('identity.RecoveryCodeHasher');

export const ADMIN_TOKEN_SIGNER = Symbol('identity.AdminTokenSigner');
/** 관리 액세스 토큰(관리 토큰 키, ES256, typ at+jwt, aud partner·ops, 15분). 역할·테넌트는 싣지 않는다(ADR-0172) */
export interface AdminTokenSigner {
  access(c: { accountId: string; sessionId: string; aud: AdminAud }, now: number): Promise<{ token: string; expiresAt: number }>;
}

export interface AdminTotpState {
  email: string;
  seedEnc: Buffer | null;
  pendingEnc: Buffer | null;
  lastStep: number | null;
}
export interface LoginStepRow {
  id: string;
  accountId: string;
  aud: AdminAud;
  pairRef: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export const ADMIN_SECOND_STEP_STORE = Symbol('identity.AdminSecondStepStore');
export interface AdminSecondStepStore {
  findLoginById(id: string): Promise<(AdminLoginAccount & { email: string }) | null>;
  getTotp(id: string): Promise<AdminTotpState | null>;
  setTotpPending(id: string, enc: Buffer, now: number): Promise<boolean>;
  /** 대기 시드를 확정하고(받은 시간 칸을 적는다) 복구 코드를 모두 바꾼다 */
  confirmTotp(id: string, i: { seedEnc: Buffer; step: number; recoveryPhcs: string[]; now: number }): Promise<boolean>;
  /** 그 시간 칸이 마지막으로 받은 칸보다 클 때만 적는다(같은 코드 재사용 막기). 적었으면 true */
  recordTotpStep(id: string, step: number, now: number): Promise<boolean>;
  listRecoveryCodes(id: string): Promise<{ id: string; phc: string }[]>;
  /** 그 복구 코드 행을 지운다(한 번만). 지웠으면 true */
  useRecoveryCode(rowId: string): Promise<boolean>;
  findLoginStep(tokenHash: Buffer): Promise<LoginStepRow | null>;
  /** 로그인 단계를 쓴 것으로 적는다(한 번만). 적었으면 true */
  useLoginStep(id: string, at: number): Promise<boolean>;
  /**
   * 관리 세션을 만든다. 그 계정의 살아 있는 세션이 limit개면 유휴 만료가 가장 이른 것부터 끝내고(DEVICE_LIMIT),
   * 같은 트랜잭션에 세션 종료 사건과 계정 주인 알림(SESSION_LIMIT)을 적는다. 끝낸 세션 ID를 돌려준다
   */
  createSession(
    i: { id: string; accountId: string; aud: AdminAud; refreshHash: Buffer; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number },
    limit: number,
  ): Promise<{ evicted: string[] }>;
}
