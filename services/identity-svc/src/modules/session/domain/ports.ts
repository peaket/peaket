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
  terminateSessions(ids: readonly string[], now: number): Promise<void>;
  insertSession(row: NewSession): Promise<void>;
  /** 세션 행(쓰기 잠금). 없으면 null */
  getSessionForUpdate(id: string): Promise<SessionRow | null>;
  setRefreshHash(sessionId: string, hash: Uint8Array): Promise<void>;
}

export const SESSION_STORE = Symbol('identity.SessionStore');
export interface SessionStore {
  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T>;
}

export interface SignedToken {
  token: string;
  expiresAt: number;
}

export const TOKEN_SIGNER = Symbol('identity.TokenSigner');
/** 팬 토큰 키 서명(identity §3). 키 셋·회전·공개키 배포는 BUILD_ORDER PRF-030 */
export interface TokenSigner {
  access(c: { accountId: string; sessionId: string }, now: number): Promise<SignedToken>;
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
}
