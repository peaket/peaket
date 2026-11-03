// 본인확인 컨텍스트의 포트: 본인확인기관, 연계정보·pid 해시, 저장소.
import type { Attempt, AttemptStatus } from './verification.js';

export const VERIFICATION_PROVIDER = Symbol('identity.VerificationProvider');
/** 본인확인기관(계약 전에는 시험 어댑터뿐, identity §5) */
export interface VerificationProvider {
  /** 브라우저가 미리 연 창에 제출할 기관 창 값(openapi VerificationStart.window) */
  window(attemptId: string): { url: string; method: 'GET' | 'POST'; fields: Record<string, string>; mode: 'POPUP' | 'REDIRECT' };
  /** 기관이 돌려준 값을 기관 규격대로 확인하고 그 건(attemptId)의 결과인지 본다. 연계정보(ci) 원문은 해시한 뒤 바로 버린다 */
  confirm(attemptId: string, providerResult: Record<string, string>): Promise<{ outcome: 'VERIFIED'; ci: string } | { outcome: 'CANCELLED' | 'FAILED' }>;
}

export const IDENTITY_HASHERS = Symbol('identity.IdentityHashers');
/** 연계정보 HMAC과 pid(= HMAC(pid 키, ci_hmac)). 운영은 KMS(BUILD_ORDER BOT-020) */
export interface IdentityHashers {
  ci(ci: string): { hmac: Buffer; version: number };
  pid(ciHmac: Buffer): { pid: Buffer; version: number };
}

export interface VerificationTx {
  insertAttempt(a: Attempt): Promise<void>;
  /** 건(쓰기 잠금). 없으면 null */
  attemptForUpdate(id: string): Promise<Attempt | null>;
  completeAttempt(id: string, status: Exclude<AttemptStatus, 'PENDING'>, now: number): Promise<void>;
  /** 그 계정의 본인확인 기록(쓰기 잠금) */
  verificationOf(accountId: string): Promise<{ ciHmac: Buffer; pid: Buffer } | null>;
  /** 그 연계정보 HMAC을 가진 계정 */
  accountByCiHmac(ciHmac: Buffer): Promise<string | null>;
  saveVerification(v: { accountId: string; ciHmac: Buffer; ciHmacKeyVersion: number; pid: Buffer; pidKeyVersion: number; verifiedAt: number; sourceRecord: string }): Promise<void>;
}

export const VERIFICATION_STORE = Symbol('identity.VerificationStore');
export interface VerificationStore {
  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T>;
  attempt(id: string): Promise<Attempt | null>;
  isVerified(accountId: string): Promise<boolean>;
  /** 토큰에 실을 값. 본인확인 전이면 null */
  claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null>;
}
