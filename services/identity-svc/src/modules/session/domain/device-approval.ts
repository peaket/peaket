// 스캐너 기기 승인 로그인(RFC 8628, identity §6.1, offline-gate §6.1, GAT-220).
// 기기 코드는 CSPRNG 256비트이고 서버에는 SHA-256만 둔다. 사용자 확인 코드는 RFC 8628 §6.1 문자 집합 8자를 4-4로 나눈다.
// 기기 승인은 5분 [가정]이고, 토큰 폴링 최소 간격은 5초 [가정]이다. 두 값은 정본의 [가정]을 그대로 쓴다.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { StaffRole } from './staff.js';

export const DEVICE_CODE_TTL_MS = 5 * 60_000;
export const DEVICE_CODE_INTERVAL_SEC = 5;
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_LENGTH = 8;
export const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** 기기당 시간당 승인 코드 발급 한도 [가정](identity §6.1) */
export const DEVICE_AUTHORIZATION_PER_HOUR = 10;
/** 계정당 10분 승인 시도 한도 [가정](identity §6.1) */
export const DEVICE_APPROVAL_ATTEMPTS = 5;
export const DEVICE_APPROVAL_WINDOW_MS = 10 * 60_000;

export type DeviceAuthorizationStatus = 'PENDING' | 'APPROVED' | 'DENIED';

/** 승인된 스캐너 세션의 값. 토큰 발급 때 그대로 토큰에 싣는다 */
export interface ApprovedScannerSession {
  scannerSessionId: string;
  assignmentId: string;
  accountId: string;
  eventId: string;
  role: StaffRole;
  proxy: boolean;
  approvedBySession: string;
  expiresAtMs: number;
}

/** 기기 승인 요청 한 건. 키는 기기 코드의 SHA-256(hex)이다 */
export interface DeviceAuthorizationRecord {
  deviceCodeHash: string;
  userCode: string;
  deviceId: string;
  deviceName: string;
  promoterId: string;
  jkt: string;
  status: DeviceAuthorizationStatus;
  createdAtMs: number;
  expiresAtMs: number;
  intervalSec: number;
  lastPolledAtMs?: number;
  approved?: ApprovedScannerSession;
}

export function newDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDeviceCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** 사용자 확인 코드를 만든다(대문자 20자 집합에서 8자, 4-4) */
export function newUserCode(random: (max: number) => number = (max) => randomInt(max)): string {
  let compact = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) compact += USER_CODE_ALPHABET[random(USER_CODE_ALPHABET.length)];
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

/** 입력 코드를 정규화한다(대소문자·하이픈·공백 무시). 모양이 틀리면 undefined */
export function normalizeUserCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`).test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

export type DeviceAuthorizationPoll =
  | { result: 'PENDING' }
  | { result: 'SLOW_DOWN'; retryAfterMs: number }
  | { result: 'DENIED' }
  | { result: 'EXPIRED' }
  | { result: 'APPROVED'; approved: ApprovedScannerSession };
