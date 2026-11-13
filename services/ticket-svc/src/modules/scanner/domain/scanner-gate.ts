// 스캐너 목록·변경분·스캔·이상 표시의 값과 입력 규칙(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
// 개인정보는 싣지 않는다. 티켓 ID·좌석 표시·상태·키·입장 상태만 다룬다.
export type ScannerTicketStatus = 'ISSUED' | 'ACTIVE' | 'TRANSFER_PENDING' | 'CANCEL_REQUESTED' | 'REFUNDED' | 'FLAGGED' | 'VOIDED';
export type ScannerDirection = 'IN' | 'OUT';
export type ScanMethod = 'QR' | 'OVERRIDE' | 'VERIFY';
export type ScanResult = 'PASS' | 'REJECT' | 'CHECK';
export type ScanReason =
  | 'INVALID_QR'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_TICKET'
  | 'TICKET_CANCELLED'
  | 'KEY_REVOKED'
  | 'KEY_UNKNOWN'
  | 'BAD_SIGNATURE'
  | 'QR_EXPIRED'
  | 'WRONG_ZONE'
  | 'ALREADY_IN'
  | 'NO_EXIT_RECORD'
  | 'NO_ENTRY_RECORD'
  | 'VERIFY_ONLY'
  | 'OVERRIDE_CAMERA'
  | 'OVERRIDE_PHONE_DEAD'
  | 'OVERRIDE_KEY_UNKNOWN'
  | 'OVERRIDE_BOOTH_OFFLINE'
  | 'OVERRIDE_OTHER';
export type GateFlagKind = 'DUPLICATE' | 'NO_EXIT' | 'AFTER_CANCEL' | 'OUT_OF_SESSION' | 'AFTER_CLOSE' | 'OVERRIDE_REVIEW';
export type GateFlagAwareness = 'CONCURRENT' | 'KNOWN';
export type GateFlagStatus = 'OPEN' | 'OK' | 'SUSPECT' | 'UNDETERMINED';

export interface ScannerPackageTicket {
  ticketId: string;
  gateZone: string;
  /** 좌석 표시. ticket-svc에는 좌석 이름이 없어 지금은 seatId를 쓴다(좌석맵 연결은 후속) */
  seatLabel: string;
  status: ScannerTicketStatus;
  /** device_key 표가 아직 없어 지금은 빈 배열이다(GAT-140 키 등록 뒤 채운다) */
  keys: { keyId: string; publicKey: string }[];
  scanState?: {
    lastDirection: ScannerDirection;
    lastAt: string;
    lastDeviceName?: string;
    lastGateZone?: string;
  };
}

export interface ScannerPackageView {
  eventId: string;
  /** 회차 입장 정책의 원본은 core-svc event다. 아직 사본이 없어 false로 두고 GAT-180 후속에서 채운다 */
  reentryAllowed: boolean;
  gateZones: string[];
  serverTime: string;
  tickets: ScannerPackageTicket[];
  /** device_key keyId가 없어 지금은 빈 배열이다 */
  revokedKeyIds: string[];
  lastSeq: number;
  minAppVersion?: string;
}

export interface ScannerChangeView {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface ScannerChangesView {
  changes: ScannerChangeView[];
  lastSeq: number;
  hasMore: boolean;
  minAppVersion?: string;
}

export interface ScanEventInput {
  id: string;
  eventId: string;
  ticketId: string;
  scannerSessionId: string;
  direction: ScannerDirection;
  method: ScanMethod;
  result: ScanResult;
  reason?: ScanReason;
  overrideNote?: string;
  gateZone?: string;
  keyId?: string;
  qrTimestamp?: string;
  scannedAtDevice: string;
  clockOffsetMs?: number;
  knownSeq: number;
  deviceSeq: number;
}

export interface GateFlagView {
  flagId: string;
  ticketId: string;
  seatLabel: string;
  gateZone: string;
  kind: GateFlagKind;
  awareness: GateFlagAwareness;
  status: GateFlagStatus;
  createdAt: string;
}

export interface GateFlagPage {
  items: GateFlagView[];
  nextCursor?: string;
}

export interface ScanBatchResult {
  acceptedIds: string[];
  flags: GateFlagView[];
}

export class ScannerGateInputError extends Error {
  constructor(readonly code: 'EVENT' | 'TICKET' | 'SCAN' | 'AFTER' | 'LIMIT' | 'FLAG' | 'STATUS' | 'NOTE' | 'CURSOR') {
    super(`스캐너 게이트 입력 오류: ${code}`);
    this.name = 'ScannerGateInputError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTIONS = new Set(['IN', 'OUT']);
const METHODS = new Set(['QR', 'OVERRIDE', 'VERIFY']);
const RESULTS = new Set(['PASS', 'REJECT', 'CHECK']);
const REASONS = new Set([
  'INVALID_QR',
  'UNSUPPORTED_VERSION',
  'UNKNOWN_TICKET',
  'TICKET_CANCELLED',
  'KEY_REVOKED',
  'KEY_UNKNOWN',
  'BAD_SIGNATURE',
  'QR_EXPIRED',
  'WRONG_ZONE',
  'ALREADY_IN',
  'NO_EXIT_RECORD',
  'NO_ENTRY_RECORD',
  'VERIFY_ONLY',
  'OVERRIDE_CAMERA',
  'OVERRIDE_PHONE_DEAD',
  'OVERRIDE_KEY_UNKNOWN',
  'OVERRIDE_BOOTH_OFFLINE',
  'OVERRIDE_OTHER',
]);

export function assertEventId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerGateInputError('EVENT');
  return v.toLowerCase();
}

export function assertUuid(v: unknown, code: 'TICKET' | 'SCAN' | 'FLAG' = 'SCAN'): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerGateInputError(code);
  return v.toLowerCase();
}

export function assertAfter(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new ScannerGateInputError('AFTER');
  return n as number;
}

export function assertChangesLimit(v: unknown): number {
  if (v === undefined || v === '') return 5000;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 5000) throw new ScannerGateInputError('LIMIT');
  return n as number;
}

export function assertFlagLimit(v: unknown): number {
  if (v === undefined || v === '') return 20;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 100) throw new ScannerGateInputError('LIMIT');
  return n as number;
}

export function assertFlagStatus(v: unknown): GateFlagStatus {
  if (v === 'OK' || v === 'SUSPECT' || v === 'UNDETERMINED') return v;
  throw new ScannerGateInputError('STATUS');
}

export function assertNote(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > 100) throw new ScannerGateInputError('NOTE');
  return v;
}

export function assertFlagCursor(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 512) throw new ScannerGateInputError('CURSOR');
  return v;
}

function requireDate(name: string, v: unknown): string {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new ScannerGateInputError('SCAN');
  return new Date(Date.parse(v)).toISOString();
}

/** 업로드 한 건을 검사한다. 티켓·기기·세션 값은 서버가 정하는 값과 대조하므로 여기서는 모양만 본다. */
export function normalizeScan(v: unknown): ScanEventInput {
  if (!v || typeof v !== 'object') throw new ScannerGateInputError('SCAN');
  const s = v as Record<string, unknown>;
  if (typeof s.direction !== 'string' || !DIRECTIONS.has(s.direction)) throw new ScannerGateInputError('SCAN');
  if (typeof s.method !== 'string' || !METHODS.has(s.method)) throw new ScannerGateInputError('SCAN');
  if (typeof s.result !== 'string' || !RESULTS.has(s.result)) throw new ScannerGateInputError('SCAN');
  if (s.reason !== undefined && (typeof s.reason !== 'string' || !REASONS.has(s.reason))) throw new ScannerGateInputError('SCAN');
  if (s.overrideNote !== undefined && (typeof s.overrideNote !== 'string' || s.overrideNote.length > 100)) throw new ScannerGateInputError('SCAN');
  if (s.gateZone !== undefined && typeof s.gateZone !== 'string') throw new ScannerGateInputError('SCAN');
  if (s.keyId !== undefined && typeof s.keyId !== 'string') throw new ScannerGateInputError('SCAN');
  if (s.clockOffsetMs !== undefined && !Number.isSafeInteger(s.clockOffsetMs)) throw new ScannerGateInputError('SCAN');
  if (!Number.isSafeInteger(s.knownSeq) || (s.knownSeq as number) < 0) throw new ScannerGateInputError('SCAN');
  if (!Number.isSafeInteger(s.deviceSeq) || (s.deviceSeq as number) < 0) throw new ScannerGateInputError('SCAN');
  return {
    id: assertUuid(s.id, 'SCAN'),
    eventId: assertEventId(s.eventId),
    ticketId: assertUuid(s.ticketId, 'TICKET'),
    scannerSessionId: assertUuid(s.scannerSessionId, 'SCAN'),
    direction: s.direction as ScannerDirection,
    method: s.method as ScanMethod,
    result: s.result as ScanResult,
    ...(s.reason !== undefined ? { reason: s.reason as ScanReason } : {}),
    ...(s.overrideNote !== undefined ? { overrideNote: s.overrideNote } : {}),
    ...(s.gateZone !== undefined ? { gateZone: s.gateZone } : {}),
    ...(s.keyId !== undefined ? { keyId: s.keyId } : {}),
    ...(s.qrTimestamp !== undefined ? { qrTimestamp: requireDate('qrTimestamp', s.qrTimestamp) } : {}),
    scannedAtDevice: requireDate('scannedAtDevice', s.scannedAtDevice),
    ...(s.clockOffsetMs !== undefined ? { clockOffsetMs: s.clockOffsetMs as number } : {}),
    knownSeq: s.knownSeq as number,
    deviceSeq: s.deviceSeq as number,
  };
}

export function normalizeScanBatch(v: unknown): ScanEventInput[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 500) throw new ScannerGateInputError('SCAN');
  return v.map(normalizeScan);
}
