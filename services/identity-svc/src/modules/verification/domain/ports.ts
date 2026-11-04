// 본인확인 컨텍스트의 포트: 본인확인기관, 연계정보·pid 해시, 저장소.
import type { Attempt, AttemptStatus } from './verification.js';

export const VERIFICATION_PROVIDER = Symbol('identity.VerificationProvider');
/** 본인확인기관(계약 전에는 시험 어댑터뿐, identity §5) */
export interface VerificationProvider {
  /** 브라우저가 미리 연 창에 제출할 기관 창 값(openapi VerificationStart.window) */
  window(attemptId: string): { url: string; method: 'GET' | 'POST'; fields: Record<string, string>; mode: 'POPUP' | 'REDIRECT' };
  /**
   * 기관이 돌려준 값을 기관 규격대로 확인하고 그 건(attemptId)의 결과인지 본다. 연계정보(ci) 원문은 해시한 뒤 바로 버린다.
   * 생년월일(birthDate, YYYY-MM-DD)은 만 나이 계산에만 쓰고 남기지 않는다(identity §5 만 14세 확인)
   */
  confirm(attemptId: string, providerResult: Record<string, string>): Promise<{ outcome: 'VERIFIED'; ci: string; birthDate?: string } | { outcome: 'CANCELLED' | 'FAILED' }>;
}

export const IDENTITY_HASHERS = Symbol('identity.IdentityHashers');
/**
 * 연계정보 HMAC(판마다 따로 된 키)과 pid(= HMAC(pid 키, ci_hmac)). 운영은 KMS GenerateMac, local·ci·demo는 설정값 키도 된다(identity §5).
 * 키를 쓸 수 없으면 KeyServiceUnavailable을 던진다
 */
export interface IdentityHashers {
  /**
   * 보존 중인 모든 판의 연계정보 HMAC. 첫째가 쓰기 판(새 기록에 쓰는 판)이고 나머지는 큰 판부터다.
   * 새 판은 모든 파드에 조회용으로 둔 뒤에 쓰기 판으로 올린다(docs/security/secrets-and-keys.md 연계정보 행, 새 맥락 리뷰 중간 3)
   */
  ciAll(ci: string): Promise<{ hmac: Buffer; version: number }[]>;
  pid(ciHmac: Buffer): Promise<{ pid: Buffer; version: number }>;
  /** 설정한 연계정보 키 판 목록 */
  versions(): number[];
}

/** 이 계정의 본인확인 기록 */
export interface VerificationRecord {
  ciHmac: Buffer;
  ciHmacKeyVersion: number;
  pid: Buffer;
}

/** 같은 본인확인을 다른 계정에서 시도한 기록 한 줄(연계정보·HMAC은 싣지 않는다, I-T65) */
export interface ConflictAttempt {
  id: string;
  attemptedAccountId: string;
  existingAccountId: string;
  attemptedAt: number;
}

export interface VerificationTx {
  insertAttempt(a: Attempt): Promise<void>;
  /** 건(쓰기 잠금). 없으면 null */
  attemptForUpdate(id: string): Promise<Attempt | null>;
  completeAttempt(id: string, status: Exclude<AttemptStatus, 'PENDING'>, now: number): Promise<void>;
  /** 그 계정의 본인확인 기록(쓰기 잠금) */
  verificationOf(accountId: string): Promise<VerificationRecord | null>;
  /** 그 연계정보 HMAC 가운데 하나를 가진 계정. exceptAccountId가 아닌 계정을 먼저 찾는다(보존 중인 모든 판의 값을 함께 준다) */
  accountByCiHmac(ciHmacs: readonly Buffer[], exceptAccountId: string): Promise<string | null>;
  saveVerification(v: { accountId: string; ciHmac: Buffer; ciHmacKeyVersion: number; pid: Buffer; pidKeyVersion: number; verifiedAt: number; sourceRecord: string }): Promise<void>;
  /** 옛 판 기록을 새 판 값으로 바꾼다(pid는 그대로, ADR-0050 결정 5) */
  updateCiHmac(accountId: string, ciHmac: Buffer, ciHmacKeyVersion: number): Promise<void>;
  insertConflictAttempt(c: ConflictAttempt): Promise<void>;
}

export const VERIFICATION_STORE = Symbol('identity.VerificationStore');
export interface VerificationStore {
  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T>;
  attempt(id: string): Promise<Attempt | null>;
  isVerified(accountId: string): Promise<boolean>;
  /** 토큰에 실을 값. 본인확인 전이면 null */
  claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null>;
  /** 그 세션에서 목적 REVERIFY 건이 since 뒤에 VERIFIED로 확정됐는가(고위험 재인증의 재통과, I-T55 ④) */
  recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean>;
  /** before보다 앞서 남긴 다른 계정 시도 기록을 지우고 지운 줄 수(1년 [가정], 일정은 정비 잡 BAS-060) */
  purgeConflictAttempts(before: number): Promise<number>;
  /** 기록이 쓰는 연계정보 키 판들(시작할 때 설정과 견준다) */
  ciKeyVersionsInUse(): Promise<number[]>;
}
