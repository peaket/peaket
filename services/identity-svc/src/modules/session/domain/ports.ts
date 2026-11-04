// 세션 컨텍스트의 포트: 저장소(트랜잭션 하나에서 쓰는 일), 토큰 서명, 기기 가명, 운영 신호.
import type { ActiveSession, LoginVerdict, Provider, ReauthPurpose, ReauthStrength, TerminationReason } from './session.js';

export interface CreateKeyRecord {
  provider: Provider;
  providerUserId: string;
  sessionId: string;
  /** 처음 응답의 new_account(다시 보낼 때 같은 값을 준다) */
  newAccount: boolean;
}

export type AccountStatus = 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED';

export interface AccountRow {
  id: string;
  status: AccountStatus;
}

export interface SessionRow {
  id: string;
  accountId: string;
  deviceId: string | null;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  terminatedAt: number | null;
  loginVerdict: LoginVerdict;
  refreshFamily: string;
}

export interface NewSession {
  id: string;
  accountId: string;
  deviceId: string | null;
  refreshHash: Uint8Array;
  refreshFamily: string;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  /** 로그인 판정(identity §7). trust-svc가 생기기 전에는 UNKNOWN(판정을 받지 못함, identity §2 '첫 구현') */
  loginVerdict: LoginVerdict;
  createdAt: number;
}

/** 갱신에 쓰려고 리프레시 토큰 해시로 찾은 세션(쓰기 잠금) */
export interface RefreshRow extends SessionRow {
  match: 'current' | 'previous' | 'history';
  rotatedAt: number | null;
  refreshUsed: boolean;
}

/** 트랜잭션 하나 안에서 하는 일. 저장소 어댑터가 트랜잭션·잠금을 맡는다 */
export interface SessionTx {
  /**
   * 그 멱등 키로 들어온 다른 요청이 끝날 때까지 기다린 뒤(같은 키는 한 번에 하나만), 기억하는 기록을 돌려준다.
   * 10분이 지난 기록은 잊는다(지우고 null)
   */
  lockCreateKey(key: string, now: number): Promise<CreateKeyRecord | null>;
  saveCreateKey(key: string, rec: CreateKeyRecord, now: number): Promise<void>;
  /** 같은 (제공자, provider_user_id)의 로그인이 겹치면 한 번에 하나만 계정을 찾고 만든다(트랜잭션 끝까지) */
  lockProvider(provider: Provider, providerUserId: string): Promise<void>;
  /** 계정 단위로 기기 수를 세고 정리하는 일을 한 번에 하나만 한다(트랜잭션 끝까지) */
  lockAccount(accountId: string): Promise<void>;
  findAccountByProvider(provider: Provider, providerUserId: string): Promise<AccountRow | null>;
  createAccount(input: { id: string; email: string | null }, now: number): Promise<void>;
  linkProvider(accountId: string, provider: Provider, providerUserId: string, now: number): Promise<void>;
  isProviderLinked(accountId: string, provider: Provider, providerUserId: string): Promise<boolean>;
  /** 계정의 그 기기 가명 행 ID. 없으면 만든다 */
  bindDevice(accountId: string, deviceRef: string, now: number): Promise<string>;
  /** 끝나지 않았고 만료 전인 그 계정의 세션 */
  activeSessions(accountId: string, now: number): Promise<ActiveSession[]>;
  /** 끝나지 않은 그 계정의 세션 ID(만료와 상관없이, 쓰기 잠금). 탈퇴가 모두 끝낸다(만료 경계에서 갱신과 겹쳐도 남지 않게) */
  unterminatedSessions(accountId: string): Promise<string[]>;
  /** 세션을 끝내고 그 세션들의 리프레시 토큰 해시를 지우며, 같은 트랜잭션에 세션 종료 사건(control.sessions-terminated)을 적는다(ADR-0143 결정 3, R-255) */
  terminateSessions(ids: readonly string[], reason: TerminationReason, now: number): Promise<void>;
  /** ACTIVE 계정을 WITHDRAWAL_PENDING과 정리 사유·시작 시각으로 둔다. 이미 정리 중이거나 다른 상태면 그대로 둔다(멱등) */
  markClosure(accountId: string, reason: 'UNDER_14', now: number): Promise<void>;
  /** 정리 중(WITHDRAWAL_PENDING)인 계정의 정리 사유. 아니면 null */
  closureReasonOf(accountId: string): Promise<'UNDER_14' | null>;
  /** 계정 상태. 없으면 null */
  accountStatusOf(accountId: string): Promise<AccountStatus | null>;
  /**
   * 탈퇴 끝내기의 계정 쪽(identity §8 '탈퇴의 첫 구현'): DELETED·deleted_at, 프로필 칸 비우기, 로그인 수단 연결·기기 행·세션 생성 기억 지우기.
   * 세션 끝내기는 부르는 쪽이 terminateSessions로 한다
   */
  eraseAccount(accountId: string, now: number): Promise<void>;
  /** 정리 사유 UNDER_14로 before 때나 그 전에 정리를 시작한 정리 중 계정 ID(최대 limit개) */
  closuresStartedBefore(before: number, limit: number): Promise<string[]>;
  /** since 뒤에 탈퇴한(DELETED) 계정 ID를 ID 순으로 after 뒤부터 최대 limit개 */
  deletedSince(since: number, after: string, limit: number): Promise<string[]>;
  /**
   * 그 계정이 남겼거나 이은 끝나지 않은 대조값 보관 행 하나(RESTRICTED 먼저, 같으면 늦은 끝). 탈퇴가 계정을 잠근 뒤 같은 트랜잭션에서 다시 본다
   * (본인확인 컨텍스트의 표를 같은 DB 트랜잭션에서 읽는다. 표를 보지 못하는 저장소는 null)
   */
  activeHoldOf(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number } | null>;
  /** 재인증 토큰의 jti를 한 번 쓴다. 이미 썼으면 false */
  useReauth(r: { jti: string; accountId: string; usedAt: number; expiresAt: number }): Promise<boolean>;
  insertSession(row: NewSession): Promise<void>;
  /** 세션 행(쓰기 잠금). 없으면 null */
  getSessionForUpdate(id: string): Promise<SessionRow | null>;
  /** 지금 리프레시 토큰만 바꾼다(CreateSession 다시 보내기, 갱신 재시도). 앞 토큰·회전 시각은 그대로 */
  setRefreshHash(sessionId: string, hash: Uint8Array): Promise<void>;
  /** 회전: 지금 토큰을 앞 토큰으로 옮기고 새 토큰을 둔다. rotated_at = now, refresh_used = false, 유휴 만료를 고친다 */
  rotateRefresh(sessionId: string, hash: Uint8Array, now: number, idleExpiresAt: number): Promise<void>;
  /** 발급한 리프레시 토큰 해시를 그 세션의 절대 만료까지 남긴다(재사용 탐지) */
  recordRefreshHash(r: { hash: Uint8Array; sessionId: string; refreshFamily: string; issuedAt: number; expiresAt: number }): Promise<void>;
  /** 리프레시 토큰 해시로 세션을 찾는다(지금·바로 앞·예전 발급). 없으면 null */
  findByRefreshHash(hash: Uint8Array): Promise<RefreshRow | null>;
  /** 그 패밀리의 끝나지 않은 세션 ID */
  familySessions(refreshFamily: string): Promise<string[]>;
}

export const SESSION_STORE = Symbol('identity.SessionStore');
export interface SessionStore {
  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T>;
  /** 끝났거나 유휴·절대 만료가 지난 세션의 리프레시 토큰 해시를 지우고 지운 줄 수(정비 refresh-hash-expired, R-255) */
  purgeExpiredRefreshHashes(now: number, signal?: AbortSignal): Promise<number>;
  /** 토큰 만료가 지난 재인증 토큰 사용 기록을 지우고 지운 줄 수(정비) */
  purgeReauthUses(now: number): Promise<number>;
}

export interface SignedToken {
  token: string;
  expiresAt: number;
}

export const TOKEN_SIGNER = Symbol('identity.TokenSigner');
/** 팬 토큰 키 서명(identity §3). 키 셋·회전·공개키 배포는 BUILD_ORDER PRF-030 */
export interface TokenSigner {
  /** 발급자(iss). 재인증 토큰을 확인할 때 같은 값을 본다 */
  readonly issuer: string;
  access(c: { accountId: string; sessionId: string; scopes?: string[]; pid?: string; pidPrev?: string }, now: number): Promise<SignedToken>;
  reauth(c: { accountId: string; sessionId: string; provider: Provider; strength: ReauthStrength; purpose: ReauthPurpose }, now: number): Promise<SignedToken>;
}

export const DEVICE_REFS = Symbol('identity.DeviceRefs');
/** 기기 가명 invRef("device", deviceId)(docs/security/secrets-and-keys.md). 라벨 키가 없으면 undefined(기기 행을 쓰지 않는다, identity §10) */
export interface DeviceRefs {
  ref(deviceId: string): string | undefined;
}

export const SESSION_SIGNALS = Symbol('identity.SessionSignals');
/** 운영 확인 신호(identity §10.1) */
export interface SessionSignals {
  created(provider: Provider, newAccount: boolean): void;
  replayed(provider: Provider): void;
  terminated(reason: TerminationReason, count: number): void;
  reauthIssued(provider: Provider, strength: ReauthStrength): void;
  reauthMismatch(provider: Provider): void;
  reverifyRequired(provider: Provider): void;
  refreshed(aud: 'fan', result: 'rotated' | 'retried' | 'reused' | 'invalid'): void;
}

export const PUBLIC_KEYS = Symbol('identity.PublicKeys');
/** 공개키 묶음(JWKS)을 내는 쪽(identity §3 '토큰 수명주기 구현' 공개키 배포). 키 셋은 fan·admin·staff */
export interface PublicKeys {
  jwks(set: 'fan' | 'admin' | 'staff', now: number): { keys: object[] };
}

export const ACCOUNT_CLAIMS = Symbol('identity.AccountClaims');
/** 액세스 토큰에 실을 계정 값(identity §3): 본인확인을 마친 계정의 scope(ticket:buy)·pid·pid_prev. 본인확인 컨텍스트가 채운다 */
export interface AccountClaims {
  of(accountId: string): Promise<{ scopes: string[]; pid?: string; pidPrev?: string }>;
}

export const REVERIFICATIONS = Symbol('identity.Reverifications');
/** 본인확인 재통과 기록(본인확인 컨텍스트가 내준다, identity §5 '키 판·만 14세…'·§7.1 ③) */
export interface Reverifications {
  /** 그 세션에서 목적 REVERIFY 건이 since 뒤에 VERIFIED로 확정됐는가 */
  recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean>;
}
/** 재통과 기록이 없는 경우(시험) */
export const noReverifications: Reverifications = { recentlyReverified: async () => false };

export const ACCOUNT_CLOSURE = Symbol('identity.AccountClosure');
/** 계정 정리 시작(세션 컨텍스트가 내준다). 본인확인이 만 14세 미만을 찾으면 부른다. 멱등이다 */
export interface AccountClosure {
  start(accountId: string, reason: 'UNDER_14'): Promise<void>;
  /** 정리 중(WITHDRAWAL_PENDING)이면 그 사유, 아니면 null. 정리 중인 계정은 다시 본인확인하지 못한다(새 맥락 리뷰 중간 2) */
  closureReasonOf(accountId: string): Promise<'UNDER_14' | null>;
  /** 구매·본인확인을 할 수 없는 계정인가(ACTIVE가 아님: 정리·탈퇴 유예 중, 탈퇴, 병합). 그 계정의 토큰에는 ticket:buy·pid를 싣지 않는다(identity §8 '탈퇴의 첫 구현') */
  isClosing(accountId: string): Promise<boolean>;
}

export const ACCOUNT_ERASER = Symbol('identity.AccountEraser');
/** 탈퇴한 계정의 본인확인 기록 파기(본인확인 컨텍스트가 채운다, identity §8 '탈퇴의 첫 구현'). 여러 번 불러도 된다 */
export interface AccountEraser {
  /** 지운 것이 있으면 true */
  erase(accountId: string, now: number): Promise<boolean>;
}

export const REAUTH_VERIFIER = Symbol('identity.ReauthVerifier');
/** 재인증 토큰 확인(typ reauth+jwt, 팬 토큰 키, 세션·작업 묶음). 맞지 않으면 ReauthRejected를 던진다 */
export interface ReauthVerifier {
  verify(token: string, o: { sessionId: string; act: string }): Promise<{ jti: string; accountId: string; expiresAt: number }>;
}

/** 재인증 토큰이 없거나 맞지 않는다(403 reauth-required, docs/api/guidelines.md 재인증 토큰) */
export class ReauthRejected extends Error {
  constructor(readonly why: string) {
    super(`재인증 토큰이 맞지 않는다: ${why}`);
    this.name = 'ReauthRejected';
  }
}

export const FRAUD_HOLDS = Symbol('identity.FraudHolds');
/** 탈퇴 전 대조값 보관 안내(본인확인 컨텍스트가 채운다, identity §8 '대조값 보관의 첫 구현'). 그 계정이 남겼거나 이은 끝나지 않은 행 하나 */
export interface FraudHolds {
  activeHold(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number } | null>;
}
