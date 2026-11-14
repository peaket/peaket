// 근무 준비(SCR-033)·기기 배치(SCR-037·SCR-052)·준비 보고의 값과 입력 규칙
// (BUILD_ORDER GAT-170, offline-gate §6.2, ADR-0081).
// 배치의 원본은 ticket DB `scanner_placement`(docs/data.md)이고, 근무 창·배정은 identity의 스캐너 세션 판정이 준다.
// 이 파일은 저장소를 모른다. 화면에 나가는 모양과 입력 검사만 둔다.
import type { ScannerVersionVector } from './scanner-gate.js';
import type { ScannerCredentialType, ScannerDeviceStatus } from './scanner-device.js';

export type ScannerPlacementMode = 'IN' | 'OUT';
export type ScannerStaffRole = 'gate_staff' | 'gate_lead';

/** 저장소가 돌려주는 배치 한 행 */
export interface ScannerPlacementRecord {
  eventId: string;
  deviceId: string;
  gateZone: string;
  mode: ScannerPlacementMode;
  setBy: string;
  setAtMs: number;
  version: number;
}

/** 응답의 배치(openapi ScannerPlacement와 같은 칸) */
export interface ScannerPlacementView {
  gateZone: string;
  mode: ScannerPlacementMode;
}

/** 기기의 마지막 근무 준비 보고 */
export interface ScannerReadinessRecord {
  eventId: string;
  deviceId: string;
  packageSeq: number;
  clockOffsetMs: number;
  pendingUploads: number;
  reportedBy: string;
  reportedAtMs: number;
}

export interface ScannerShiftReadinessView {
  reported: boolean;
  reportedAt?: string;
  packageSeq?: number;
  clockOffsetMs?: number;
  pendingUploads?: number;
}

export interface ScannerShiftDeviceView {
  deviceId: string;
  name: string;
  status: ScannerDeviceStatus;
  credentialType: ScannerCredentialType;
  /** 기기 키 지문(jkt)이나 인증서 지문이 묶였는가 */
  enrolled: boolean;
  lastSeenAt?: string;
  /** mTLS 선택지를 쓰는 기기인가. 기본안은 DPoP라 false다 */
  mtls: boolean;
}

export interface ScannerShiftAssignmentView {
  assignmentId: string;
  role: ScannerStaffRole;
  validFrom: string;
  validUntil: string;
  proxy: boolean;
}

/** core-svc 회차에서 읽은 판매·입장 창. 없는 값은 싣지 않는다 */
export interface ScannerShiftEventWindows {
  salesOpensAt?: string;
  salesEndsAt?: string;
  entryOpensAt?: string;
  entryClosesAt?: string;
  endsAt?: string;
}

/** 목록 동기화 나이와 버전 벡터 신선도. 마지막 준비 보고가 없으면 ageMs·reportedAt이 없다 */
export interface ScannerShiftPackageView {
  seq: number;
  issuedAt: string;
  maxOfflineMs: number;
  reportedAt?: string;
  ageMs?: number;
  reportedPackageSeq?: number;
  /** 마지막 준비 보고의 시계 오차·업로드 대기 수. 없으면 싣지 않는다 */
  clockOffsetMs?: number;
  pendingUploads?: number;
  stale: boolean;
}

export interface ScannerShiftAuthView {
  deviceProof: 'DPOP' | 'MTLS';
  staffSession: true;
}

/** GET /v1/scanner/shift 응답. 서버 시각을 실으므로 Cache-Control: no-store다 */
export interface ScannerShiftView {
  serverTime: string;
  eventId: string;
  reentryAllowed: boolean;
  placement: ScannerPlacementView;
  packageSeq: number;
  role: ScannerStaffRole;
  proxy: boolean;
  device: ScannerShiftDeviceView;
  assignment: ScannerShiftAssignmentView;
  eventWindows?: ScannerShiftEventWindows;
  package: ScannerShiftPackageView;
  versionVector: ScannerVersionVector;
  auth: ScannerShiftAuthView;
}

export interface ScannerPlacementResultView extends ScannerPlacementView {
  eventId: string;
  deviceId: string;
  version: number;
  setBy: string;
  setAt: string;
}

export class ScannerShiftInputError extends Error {
  constructor(readonly code: 'EVENT' | 'DEVICE' | 'ZONE' | 'MODE' | 'IF_MATCH' | 'PACKAGE_SEQ' | 'CLOCK' | 'PENDING') {
    super(`스캐너 근무 준비 입력 오류: ${code}`);
    this.name = 'ScannerShiftInputError';
  }
}

/** 배치가 없을 때 409 NO_PLACEMENT로 닫는다(openapi getScannerShift) */
export class ScannerPlacementMissing extends Error {
  constructor() {
    super('배치되지 않은 기기다');
    this.name = 'ScannerPlacementMissing';
  }
}

/** 다른 사람이 먼저 고쳤다(If-Match 불일치). 412 */
export class ScannerPlacementConflict extends Error {
  constructor() {
    super('다른 사람이 먼저 배치를 고쳤다');
    this.name = 'ScannerPlacementConflict';
  }
}

/** If-Match가 없다. 428 */
export class ScannerPlacementPreconditionRequired extends Error {
  constructor() {
    super('고칠 판(If-Match)을 보내야 한다');
    this.name = 'ScannerPlacementPreconditionRequired';
  }
}

/** 재입장을 허용하지 않는 회차의 OUT 배치. 422 */
export class ScannerPlacementReentryNotAllowed extends Error {
  constructor() {
    super('재입장을 허용하지 않는 회차에는 퇴장 모드를 배치할 수 없다');
    this.name = 'ScannerPlacementReentryNotAllowed';
  }
}

/** 폐기·퇴역 기기는 배치할 수 없다. 409 */
export class ScannerPlacementDeviceInactive extends Error {
  constructor() {
    super('폐기·퇴역한 기기는 배치할 수 없다');
    this.name = 'ScannerPlacementDeviceInactive';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONE_MAX = 80;

export function assertShiftEventId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerShiftInputError('EVENT');
  return v.toLowerCase();
}

export function assertShiftDeviceId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ScannerShiftInputError('DEVICE');
  return v.toLowerCase();
}

export function assertGateZone(v: unknown): string {
  if (typeof v !== 'string') throw new ScannerShiftInputError('ZONE');
  const zone = v.trim();
  if (zone.length < 1 || zone.length > ZONE_MAX) throw new ScannerShiftInputError('ZONE');
  return zone;
}

export function assertPlacementMode(v: unknown): ScannerPlacementMode {
  if (v === 'IN' || v === 'OUT') return v;
  throw new ScannerShiftInputError('MODE');
}

/** If-Match의 강한 ETag(`"3"`)를 판 번호로 읽는다. 없으면 undefined(428로 닫는 것은 쓰임새가 정한다) */
export function parsePlacementIfMatch(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new ScannerShiftInputError('IF_MATCH');
  const m = /^"(0|[1-9][0-9]{0,8})"$/.exec(v);
  if (!m) throw new ScannerShiftInputError('IF_MATCH');
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n)) throw new ScannerShiftInputError('IF_MATCH');
  return n;
}

/** 새 배치의 If-Match는 `"0"`이다. 응답 ETag는 `"<version>"` */
export function placementEtag(version: number): string {
  return `"${version}"`;
}

export function assertReadinessPackageSeq(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new ScannerShiftInputError('PACKAGE_SEQ');
  return n as number;
}

export function assertClockOffsetMs(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) throw new ScannerShiftInputError('CLOCK');
  return n as number;
}

export function assertPendingUploads(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > 100_000) throw new ScannerShiftInputError('PENDING');
  return n as number;
}
