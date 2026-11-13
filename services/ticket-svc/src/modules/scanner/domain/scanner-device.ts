// 스캐너 기기 원장의 값·등록 코드 규칙(BUILD_ORDER GAT-170, offline-gate §6.1, ADR-0051·0062).
// 코드 원문은 응답에만 있고 서버는 SHA-256만 Redis에 둔다. 기기 키 지문(jkt)은 RFC 7638 base64url 43자다.
import { createHash, randomInt } from 'node:crypto';

export type ScannerDeviceStatus = 'ACTIVE' | 'REVOKED' | 'RETIRED';
export type ScannerCredentialType = 'DEVICE_KEY' | 'MTLS_CERT';

/** 기기 원장 한 행. 화면·계약에 필요한 값만 둔다 */
export interface ScannerDeviceRecord {
  deviceId: string;
  name: string;
  promoterId: string;
  status: ScannerDeviceStatus;
  credentialType: ScannerCredentialType;
  /** 기기 키 지문(jkt) 또는 인증서 지문. 등록 전이면 없다 */
  credentialThumbprint?: string;
  certExpiresAtMs?: number;
  enrolledBy: string;
  enrolledAtMs: number;
  lastSeenAtMs?: number;
  revokedAtMs?: number;
  revokeReason?: string;
}

/** 등록 코드(RFC 8628 §6.1 문자 집합, 4-4-4) */
export const ENROLLMENT_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const ENROLLMENT_CODE_TTL_MS = 10 * 60_000;
export const ENROLLMENT_CODE_LENGTH = 12;
export const ENROLLMENT_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** jkt는 SHA-256 base64url(채움 없음) 43자다 */
export const JKT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 80;
const REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ScannerDeviceInputError extends Error {
  constructor(readonly code: 'NAME' | 'PROMOTER' | 'DEVICE' | 'ACCOUNT' | 'CODE' | 'REASON' | 'JKT' | 'CURSOR' | 'LIMIT') {
    super(`스캐너 기기 입력 오류: ${code}`);
    this.name = 'ScannerDeviceInputError';
  }
}

/** 같은 기기 키 지문(jkt)을 두 기기에 묶으려 했다. DB 유일 인덱스와 메모리 저장소가 같은 뜻으로 던진다 */
export class ScannerDeviceKeyConflict extends Error {
  constructor() {
    super('이미 다른 기기에 묶인 기기 키 지문이다');
    this.name = 'ScannerDeviceKeyConflict';
  }
}

/** 등록 코드 하나를 만든다(대문자 20자 집합에서 12자) */
export function newEnrollmentCode(random: (max: number) => number = (max) => randomInt(max)): string {
  let compact = '';
  for (let i = 0; i < ENROLLMENT_CODE_LENGTH; i++) compact += ENROLLMENT_CODE_ALPHABET[random(ENROLLMENT_CODE_ALPHABET.length)];
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

/**
 * 입력 코드를 정규화한다(대소문자·하이픈·공백 무시). 모양이 틀리면 undefined.
 * 해시는 하이픈 없는 12자 정규형의 SHA-256 hex다.
 */
export function normalizeEnrollmentCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!new RegExp(`^[${ENROLLMENT_CODE_ALPHABET}]{${ENROLLMENT_CODE_LENGTH}}$`).test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

/** 등록 코드의 SHA-256(hex). Redis 키 `scanner:enroll:{해시}`에 쓴다 */
export function enrollmentCodeHash(code: string): string {
  const compact = code.replace(/[\s-]/g, '').toUpperCase();
  return createHash('sha256').update(compact).digest('hex');
}

export function assertDeviceName(v: unknown): string {
  if (typeof v !== 'string') throw new ScannerDeviceInputError('NAME');
  const name = v.trim();
  if (name.length < 1 || name.length > NAME_MAX) throw new ScannerDeviceInputError('NAME');
  return name;
}

export function assertPromoterId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerDeviceInputError('PROMOTER');
  return v.toLowerCase();
}

export function assertDeviceId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerDeviceInputError('DEVICE');
  return v.toLowerCase();
}

export function assertAccountId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerDeviceInputError('ACCOUNT');
  return v.toLowerCase();
}

export function assertRevokeReason(v: unknown): string {
  if (typeof v !== 'string') throw new ScannerDeviceInputError('REASON');
  const reason = v.trim();
  if (reason.length < 1 || reason.length > REASON_MAX) throw new ScannerDeviceInputError('REASON');
  return reason;
}

export function assertJkt(v: unknown): string {
  if (typeof v !== 'string' || !JKT_PATTERN.test(v)) throw new ScannerDeviceInputError('JKT');
  return v;
}

export function assertLimit(v: unknown): number {
  if (v === undefined) return 50;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 100) throw new ScannerDeviceInputError('LIMIT');
  return n as number;
}

export function assertCursor(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerDeviceInputError('CURSOR');
  return v.toLowerCase();
}

/** 화면·계약에 내보내는 모습. activeSessionNickname은 identity 데이터라 ticket-svc가 싣지 않는다 */
export interface ScannerDeviceView {
  deviceId: string;
  name: string;
  promoterId: string;
  status: ScannerDeviceStatus;
  credentialType: ScannerCredentialType;
  certExpiresAt?: string;
  lastSeenAt?: string;
}

export function deviceView(r: ScannerDeviceRecord): ScannerDeviceView {
  return {
    deviceId: r.deviceId,
    name: r.name,
    promoterId: r.promoterId,
    status: r.status,
    credentialType: r.credentialType,
    ...(r.certExpiresAtMs !== undefined ? { certExpiresAt: new Date(r.certExpiresAtMs).toISOString() } : {}),
    ...(r.lastSeenAtMs !== undefined ? { lastSeenAt: new Date(r.lastSeenAtMs).toISOString() } : {}),
  };
}
