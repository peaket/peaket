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
  createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number; knownSource?: boolean }): Promise<void>;
  /** 그 묶음이 since 뒤에 성공한 익숙한 출발지인가(BOT-123) */
  isKnownSource(accountId: string, pairRef: string, since: number): Promise<boolean>;
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
  /** 해제 링크 다시 받기: 이메일 해시마다 창 안의 횟수를 세고(없는 이메일도), 한도 안이면 하나 더한다 */
  countResend(emailHash: string, now: number, windowMs: number, limit: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
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
  /** 관리 토큰 갱신 결과(팬과 같은 identity_refresh_total 등에 aud partner·ops로, BOT-130). 시험 대역은 빼도 된다 */
  refreshed?(aud: AdminAud, result: 'rotated' | 'retried' | 'reused' | 'invalid'): void;
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
  /** scopes: 비밀번호 바꾸기 필요 세션이면 ['password:change'](BOT-123), 보통은 비운다 */
  access(c: { accountId: string; sessionId: string; aud: AdminAud; scopes?: readonly string[] }, now: number): Promise<{ token: string; expiresAt: number }>;
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
  findLoginById(id: string): Promise<(AdminLoginAccount & { email: string; promoterId: string | null }) | null>;
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

// ── 본인 해제 링크와 알림 발송(BUILD_ORDER BOT-121) ──
export interface UnlockLinkRow {
  id: string;
  accountId: string;
  codeFailures: number;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}
export interface PendingNotice {
  id: string;
  accountId: string;
  kind: NoticeKind;
  createdAt: number;
}

export const ADMIN_UNLOCK_STORE = Symbol('identity.AdminUnlockStore');
export interface AdminUnlockStore {
  /** 새 링크를 만들고 그 계정의 살아 있는 옛 링크를 무효로 한다 */
  createUnlockLink(i: { id: string; accountId: string; tokenHash: Buffer; createdAt: number; expiresAt: number }): Promise<void>;
  findUnlockLink(tokenHash: Buffer): Promise<UnlockLinkRow | null>;
  /** 링크의 틀린 코드 수를 하나 올리고 새 값을 준다 */
  failUnlockCode(linkId: string): Promise<number>;
  /**
   * 한 트랜잭션: 링크를 쓴 것으로 적고(살아 있을 때만) 계정 상태를 fn으로 바꾸고 알림을 적는다. 링크가 이미 쓰였거나 무효면 false
   */
  useUnlockLink(linkId: string, accountId: string, now: number, fn: (cur: AccountLoginState) => AccountLoginState | null, notice: NoticeKind): Promise<boolean>;
  /**
   * 보내지 않은 알림을 하나씩 잠가(FOR UPDATE SKIP LOCKED, 한 행에 트랜잭션 하나) handle을 부른다. handle이 SENT·CLOSE면 sent_at을 적고, KEEP이거나 예외면 보내지 않은 채 다음 시도를 미루고(1분·2분·4분… 최대 1시간 [가정]) 다음 행으로 간다. 다음 시도 때가 안 된 행은 고르지 않는다. limit개까지
   */
  dispatchNotices(limit: number, now: number, handle: (n: PendingNotice) => Promise<'SENT' | 'CLOSE' | 'KEEP'>): Promise<{ done: number; failed: number }>;
}

export const ADMIN_MAILER = Symbol('identity.AdminMailer');
export type AdminMailKind = NoticeKind;
/** 계정 주인 업무 이메일 보내기. 운영 구현(발송 대행)은 정본에 없다 [가정] */
export interface AdminMailer {
  send(m: { to: string; kind: AdminMailKind; link?: string; at: number }): Promise<void>;
}

// ── 비밀번호만 맞은 로그인과 비밀번호 바꾸기·역할 확인(BUILD_ORDER BOT-123) ──
export interface AdminSessionRow {
  id: string;
  accountId: string;
  aud: AdminAud;
  /** 그 세션이 로그인한 출발지 묶음(비밀번호 바꾸기의 실패를 이 묶음에 센다) */
  pairRef: string;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  terminatedAt: number | null;
}
export const ADMIN_SESSION_STORE = Symbol('identity.AdminSessionStore');
export interface AdminSessionStore {
  findSession(sessionId: string): Promise<AdminSessionRow | null>;
  /** 그 계정의 keep 말고 살아 있는 관리 세션을 모두 끝내고 같은 트랜잭션에 세션 종료 사건을 적는다. 끝낸 세션 ID */
  terminateOtherSessions(accountId: string, keepSessionId: string, reason: 'PASSWORD_CHANGED', now: number): Promise<string[]>;
  /** 비밀번호와 2단계를 모두 통과한 묶음의 마지막 성공 시각 */
  touchKnownSource(accountId: string, pairRef: string, at: number): Promise<void>;
  purgeKnownSources(before: number): Promise<number>;
  /** 만든 때가 createdBefore 이전이고, 쓰이지 않았고, 익숙하지 않은 출발지이며, 아직 알리지 않은 로그인 단계 */
  findPasswordOnlySteps(createdBefore: number, limit: number): Promise<{ id: string; accountId: string }[]>;
  /**
   * 한 트랜잭션: 그 단계에 본 시각을 적고(아직이면), 계정의 비밀번호 바꾸기 필요를 켜고, PASSWORD_ONLY_LOGIN 알림을 적는다. 알렸으면 true.
   * 그 단계를 만든 뒤 같은 묶음에서 2단계까지 끝낸 기록(익숙한 출발지)이 있으면 본 시각만 적고 알리지 않는다(false)
   */
  markPasswordOnly(stepId: string, accountId: string, now: number): Promise<boolean>;
}

/** 관리 세션을 끝내는 이유(asyncapi SessionTerminated.reason 가운데 갱신·로그아웃이 쓰는 것, BOT-130) */
export type AdminSessionEndReason = 'LOGOUT' | 'REFRESH_REUSE' | 'DELETE' | 'ROLE_CHANGED' | 'ADMIN_FORCE';

/** 리프레시 토큰 해시로 찾은 관리 세션(팬 RefreshRow와 같은 판정 재료) */
export interface AdminRefreshRow {
  id: string;
  accountId: string;
  aud: AdminAud;
  refreshFamily: string;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  terminatedAt: number | null;
  /** 지금 토큰, 바로 앞 토큰, 그 패밀리가 예전에 받았던 토큰 */
  match: 'current' | 'previous' | 'history';
  rotatedAt: number | null;
  refreshUsed: boolean;
}

/** 갱신 한 번의 트랜잭션 안에서 쓰는 것(세션 행을 잠근다) */
export interface AdminRefreshTx {
  findByRefreshHash(hash: Buffer): Promise<AdminRefreshRow | null>;
  accountOf(accountId: string): Promise<{ status: AdminStatus; role: AdminRole; passwordChangeRequired: boolean } | null>;
  familySessions(refreshFamily: string): Promise<string[]>;
  /** 세션들을 끝내고 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다 */
  terminateSessions(ids: string[], reason: AdminSessionEndReason, now: number): Promise<void>;
  /** 회전: 지금 해시를 바로 앞으로 옮기고 새 해시를 둔다. rotated_at = now, refresh_used = false, 유휴 만료를 고친다 */
  rotateRefresh(sessionId: string, hash: Buffer, now: number, idleExpiresAt: number): Promise<void>;
  /** 재시도: 지금 해시만 바꾼다 */
  setRefreshHash(sessionId: string, hash: Buffer): Promise<void>;
  recordRefreshHash(r: { hash: Buffer; sessionId: string; refreshFamily: string; issuedAt: number; expiresAt: number }): Promise<void>;
}

export const ADMIN_REFRESH_STORE = Symbol('identity.AdminRefreshStore');
export interface AdminRefreshStore {
  refreshTransaction<T>(fn: (tx: AdminRefreshTx) => Promise<T>): Promise<T>;
  /** 로그아웃: 그 계정의 그 세션이 끝나지 않았으면 끝내고 같은 트랜잭션에 사건을 적는다. 끝냈으면 true */
  endSession(accountId: string, sessionId: string, reason: 'LOGOUT', now: number): Promise<boolean>;
  /** 절대 만료가 before보다 이른 발급 해시 기록을 지운다(정비 admin-refresh-hash-expired) */
  purgeRefreshHashes(before: number): Promise<number>;
}

// ── 관리 계정 관리(AdminAccountService, identity §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150) ──
/** 관리하는 쪽이 보는 계정 한 줄(가리기 전) */
export interface ManagedAccount {
  id: string;
  role: AdminRole;
  promoterId: string | null;
  status: AdminStatus;
  email: string | null;
  displayName: string | null;
  inviteExpiresAt: number | null;
  lastLoginAt: number | null;
  removedAt: number | null;
  version: number;
  totpEnrolled: boolean;
  lockKind: 'NONE' | 'TIMED' | 'PROTECT';
  lockReason: 'FAILED_ATTEMPTS' | 'SECOND_FACTOR_FAILURES' | 'PASSWORD_FAILURE_TOTAL' | null;
  lockedUntil: number | null;
}
export type AdminAccountRequestKind = 'INVITE' | 'CHANGE_ROLE' | 'REINVITE' | 'REMOVE';
/** 관리 호출 한 번의 트랜잭션 안에서 쓰는 것 */
export interface AdminManagementTx {
  findRequest(requestId: string): Promise<{ kind: AdminAccountRequestKind; accountId: string; result: string } | null>;
  recordRequest(r: { requestId: string; kind: AdminAccountRequestKind; accountId: string; result: string; at: number }): Promise<void>;
  /** 잠그지 않고 읽는다(요청자, 잠글 차례를 정하기 전의 대상) */
  readAccount(id: string): Promise<ManagedAccount | null>;
  /** 대상 계정 행을 잠근다(지운 계정도 돌려준다) */
  lockAccount(id: string): Promise<ManagedAccount | null>;
  /** 그 파트너사의 지우지 않은 partner_admin 행을 ID 순으로 모두 잠그고 돌려준다(마지막 관리자·첫 파트너 계정 판정). 대상 행보다 먼저 잠근다(교착을 막는 차례) */
  lockPartnerAdmins(promoterId: string): Promise<ManagedAccount[]>;
  /** 초대 계정을 넣는다. 지우지 않은 계정의 같은 이메일이 있으면 넣지 않고 false(고유 색인으로 가린다: 동시에 와도 하나만) */
  insertInvited(i: { id: string; role: AdminRole; promoterId: string | null; email: string; displayName: string; now: number }): Promise<boolean>;
  /** 역할을 바꾸고 판을 올린다 */
  setRole(id: string, role: AdminRole, now: number): Promise<void>;
  /** RESEND: 상태 INVITED, 초대 토큰을 지우고 판을 올린다 */
  resetInvite(id: string, now: number): Promise<void>;
  /** PROTECT_LOCK·CREDENTIAL_LOST: 비밀번호·TOTP·복구 코드·셈·잠금·바꾸기 필요·유출 대조를 지우고 상태 INVITED, 판을 올린다 */
  wipeCredentials(id: string, now: number): Promise<void>;
  /** 삭제: 상태 REMOVED·삭제 시각, 이메일·표시 이름·인증 수단·초대 토큰·마지막 접속·유출 대조·셈·잠금·바꾸기 필요를 지우고 익숙한 출발지·해제 링크·로그인 단계 행을 지우며 판을 올린다 */
  markRemoved(id: string, now: number): Promise<void>;
  /** 그 계정의 끝나지 않은 세션을 모두 끝내고 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다. 끝낸 세션 ID */
  endAllSessions(id: string, reason: 'ADMIN_FORCE' | 'DELETE' | 'ROLE_CHANGED', now: number): Promise<string[]>;
  addNotice(id: string, kind: 'INVITATION', now: number): Promise<void>;
}
export const ADMIN_MANAGEMENT_STORE = Symbol('identity.AdminManagementStore');
export interface AdminManagementStore {
  manageTransaction<T>(fn: (tx: AdminManagementTx) => Promise<T>): Promise<T>;
  getManaged(id: string): Promise<ManagedAccount | null>;
  /** 마지막 접속이 늦은 순(접속하지 않은 계정은 뒤)·ID 순. status는 보이는 상태(만료가 지난 INVITED는 INVITE_EXPIRED)로 거른다 */
  listManaged(q: { roles: readonly AdminRole[]; promoterId?: string; status?: AdminStatus; excludeRemoved?: boolean; after?: { lastLoginAt: number | null; id: string }; offset?: number; limit: number; now: number }): Promise<ManagedAccount[]>;
  liveSessions(id: string, now: number): Promise<{ id: string; createdAt: number; idleExpiresAt: number }[]>;
  /** 초대 메일을 보낼 때: 아직 INVITED이면 토큰 해시와 만료를 적는다(옛 토큰은 무효). 적었으면 true */
  setInviteToken(id: string, tokenHash: Buffer, expiresAt: number, now: number): Promise<boolean>;
  /** 만료가 지난 INVITED를 INVITE_EXPIRED로 바꾸고 토큰 해시를 지운다(정비 admin-invite-expired) */
  expireInvites(now: number): Promise<number>;
  /** 멱등 기록을 지운다(정비 admin-account-request-expired) */
  purgeRequests(before: number): Promise<number>;
}
