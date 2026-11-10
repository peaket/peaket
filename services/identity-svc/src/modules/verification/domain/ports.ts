// 본인확인 컨텍스트의 포트: 본인확인기관, 연계정보·pid 해시, 저장소.
import type { ReverificationSummary } from './reverification.js';
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
  confirm(attemptId: string, providerResult: Record<string, string>): Promise<{ outcome: 'VERIFIED'; ci: string; birthDate?: string; phone?: string } | { outcome: 'CANCELLED' | 'FAILED' }>;
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
  /** 설정한 pid 키 판(새 기록과 pid 키 전환이 쓰는 판, identity §5 'pid 키 전환의 첫 구현') */
  pidVersion(): number;
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

/** 이용 제한 중 탈퇴의 대조값 보관 행(docs/data.md restricted_ci_hold, identity §8 '대조값 보관의 첫 구현') */
export interface HoldRow {
  ciHmac: Buffer;
  ciHmacKeyVersion: number;
  fraudCaseId: string;
  state: 'CASE_OPEN' | 'RESTRICTED';
  until: number;
  sourceAccountId: string;
  carriedAccountId: string | null;
  version: number;
}

export interface VerificationTx {
  insertAttempt(a: Attempt): Promise<void>;
  /** 본인확인 번호의 PHONE 연락처 가명(세션 컨텍스트의 표 account_contact_ref를 같은 트랜잭션에서 쓴다, identity §9.1 '조사용 값의 첫 구현') */
  /** refPrev: 문자열이면 그 값, null이면 남은 옛 판 값을 그대로, 없으면 판이 바뀔 때 지금 값을 옛 판으로(세션의 nextRefPrev와 같은 규칙) */
  setPhoneRef(i: { accountId: string; ref: string; refPrev?: string | null; now: number }): Promise<void>;
  /** 건(쓰기 잠금). 없으면 null */
  attemptForUpdate(id: string): Promise<Attempt | null>;
  /**
   * personMismatch: 결과가 이 계정의 본인과 다른 사람이었다(본인확인한 계정의 다시 본인확인이 FAILED·DUPLICATE_ACCOUNT로 끝난 까닭).
   * 본인확인 재통과 확인(CheckReverification)의 PERSON_MISMATCH가 읽는다. 연계정보·HMAC은 남기지 않는다
   */
  completeAttempt(id: string, status: Exclude<AttemptStatus, 'PENDING'>, now: number, personMismatch?: boolean): Promise<void>;
  /** 그 계정의 본인확인 기록(쓰기 잠금) */
  verificationOf(accountId: string): Promise<VerificationRecord | null>;
  /** 그 연계정보 HMAC 가운데 하나를 가진 계정. exceptAccountId가 아닌 계정을 먼저 찾는다(보존 중인 모든 판의 값을 함께 준다) */
  accountByCiHmac(ciHmacs: readonly Buffer[], exceptAccountId: string): Promise<string | null>;
  saveVerification(v: { accountId: string; ciHmac: Buffer; ciHmacKeyVersion: number; pid: Buffer; pidKeyVersion: number; verifiedAt: number; sourceRecord: string }): Promise<void>;
  /** 옛 판 기록을 새 판 값으로 바꾼다(pid는 그대로, ADR-0050 결정 5) */
  updateCiHmac(accountId: string, ciHmac: Buffer, ciHmacKeyVersion: number): Promise<void>;
  insertConflictAttempt(c: ConflictAttempt): Promise<void>;
  /** 그 계정이 남긴 그 사건의 보관 행(멱등 키 (계정, 사건), 쓰기 잠금). 없으면 null */
  holdBySource(accountId: string, fraudCaseId: string): Promise<HoldRow | null>;
  /** (계정, 사건) 행을 넣거나 바꾼다(연계정보 HMAC·키 판·상태·끝·판) */
  upsertHold(row: HoldRow): Promise<void>;
  deleteHold(sourceAccountId: string, fraudCaseId: string): Promise<void>;
  /** 그 연계정보 HMAC들의 끝나지 않은 보관 행에 다시 가입한 계정을 적는다 */
  carryHolds(ciHmacs: readonly Buffer[], accountId: string, now: number): Promise<void>;
  /** 그 계정 행을 공유 잠금으로 읽은 상태(탈퇴의 쓰기 잠금과 순서를 맞춘다, identity §8 '탈퇴의 첫 구현'). 계정을 보지 못하는 저장소는 null */
  lockAccountForShare(accountId: string): Promise<string | null>;
  /** 그 계정의 상태를 잠그지 않고 읽는다(되돌아가지 않는 DELETED를 보는 데만 쓴다: 병합의 쓰기 잠금과 교착하지 않게, 재검토 2026-11-05). 계정을 보지 못하는 저장소는 null */
  accountStatusOf(accountId: string): Promise<string | null>;
}

/** pid 키 전환 기록 한 줄(docs/data.md pid_key_rotation) */
export interface PidRotationRecord {
  toVersion: number;
  startedAt: number;
  transitionEndsAt: number;
  movedAt: number | null;
  finishedAt: number | null;
}

/** pid 키 전환 저장소(identity §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025). 본인확인 저장소가 함께 구현한다 */
export interface PidRotationStore {
  /** 기록이 쓰는 pid 키 판들 */
  pidKeyVersionsInUse(): Promise<number[]>;
  /** 닫지 않은 전환(하나뿐). 없으면 null */
  openPidRotation(): Promise<PidRotationRecord | null>;
  beginPidRotation(r: { toVersion: number; startedAt: number; transitionEndsAt: number }): Promise<void>;
  /** 옮길 줄: pid 판이 version보다 작고 pid_prev가 빈 줄을 계정 ID 순으로 after 뒤부터 limit개 */
  pidRowsToMove(version: number, after: string, limit: number): Promise<{ accountId: string; ciHmac: Buffer }[]>;
  /** 옛 pid를 pid_prev로 옮기고 새 pid·판을 넣는다(판이 version보다 작고 pid_prev가 빈 줄만). 바꿨으면 true */
  movePid(accountId: string, pid: Buffer, version: number): Promise<boolean>;
  /** pid 판이 version보다 작은 줄 수 */
  pidRowsBelow(version: number): Promise<number>;
  /** 다 옮긴 시각을 적는다(다시 옮기면 그 시각으로 늦춘다) */
  markPidMoved(version: number, at: number): Promise<void>;
  /** pid_prev를 limit줄까지 지우고 지운 줄 수 */
  clearPidPrev(limit: number): Promise<number>;
  finishPidRotation(version: number, at: number): Promise<void>;
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
  /**
   * 그 계정의 목적 REVERIFY 건 가운데 확정 시각이 notBefore와 같거나 뒤인 것의 요약(본인확인 재통과 확인, identity.proto CheckReverification, I-T56).
   * 세션을 가리지 않는다(추가 검증은 계정 단위다)
   */
  reverificationSince(accountId: string, notBefore: number): Promise<ReverificationSummary>;
  /** before보다 앞서 남긴 다른 계정 시도 기록을 지우고 지운 줄 수(1년 [가정], 일정은 정비 잡 BAS-060) */
  purgeConflictAttempts(before: number): Promise<number>;
  /** 기록이 쓰는 연계정보 키 판들(시작할 때 설정과 견준다) */
  ciKeyVersionsInUse(): Promise<number[]>;
  /**
   * 탈퇴한 계정의 본인확인 기록 파기(identity §8 '탈퇴의 첫 구현'): 처리한 날 + 1년이 지나지 않은 처리 기록(source_record)은 보존 전용 표로 옮기고,
   * identity_verification을 지우며, 본인확인 건은 만 14세 미만 건만 남긴다. 지운 것이 있으면 true. 여러 번 불러도 된다
   */
  eraseAccount(accountId: string, now: number): Promise<boolean>;
  /** 그 계정이 남겼거나 이은 끝나지 않은 보관 행의 상태와 끝 */
  activeHoldsOf(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number }[]>;
  /** 그 계정이 이은 RESTRICTED 보관 행 가운데 끝나지 않은 가장 늦은 끝. 없으면 null */
  restrictedUntilOf(accountId: string, now: number): Promise<number | null>;
  /** 끝(until)이 지난 보관 행을 지우고 지운 줄 수(정비 restricted-hold-expired) */
  purgeExpiredHolds(now: number): Promise<number>;
  /** 보존 전용 표에서 지울 시각(처리한 날 + 1년)이 지난 처리 기록을 지우고 지운 줄 수(정비) */
  purgeVerificationRecords(now: number): Promise<number>;
}

export const PHONE_REFS = Symbol('identity.PhoneRefs');
/** 본인확인 결과 번호(기관 값 그대로)의 연락처 가명. 맞출 수 없는 번호거나 라벨 키가 없으면 undefined(번호는 저장하지 않는다, identity §9.1) */
export interface PhoneRefs {
  ref(rawPhone: string): string | undefined;
  /** 키 회전의 이음 기간에만: 옛 판의 값(BOT-046) */
  prevRef?(rawPhone: string): string | undefined;
}
