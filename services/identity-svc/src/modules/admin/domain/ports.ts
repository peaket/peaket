// 관리 계정 컨텍스트의 포트: 비밀번호 해시·확인, 페퍼, 유출 목록, 관리 계정 저장소(identity §6, BUILD_ORDER BOT-110).

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
