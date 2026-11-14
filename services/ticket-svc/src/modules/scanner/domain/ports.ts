// 스캐너 기기 원장·등록 코드·DPoP jti·목록/스캔/이상 표시 저장소의 포트(BUILD_ORDER GAT-170·GAT-180).
import type {
  GateFlagPage,
  GateFlagStatus,
  GateFlagView,
  ScanBatchResult,
  ScanEventInput,
  ScannerChangesView,
  ScannerPackageView,
  ScannerVersionVector,
} from './scanner-gate.js';
import type { ScannerDeviceRecord } from './scanner-device.js';
import type { ScannerPlacementMode, ScannerPlacementRecord, ScannerReadinessRecord } from './scanner-shift.js';

export interface ScannerDeviceListInput {
  readonly cursor?: string;
  readonly limit: number;
}

export interface ScannerDeviceListResult {
  readonly devices: readonly ScannerDeviceRecord[];
  readonly nextCursor?: string;
}

export interface ScannerDeviceStore {
  list(i: ScannerDeviceListInput): Promise<ScannerDeviceListResult>;
  findById(deviceId: string): Promise<ScannerDeviceRecord | undefined>;
  register(i: { deviceId: string; name: string; promoterId: string; enrolledBy: string; atMs: number }): Promise<ScannerDeviceRecord>;
  revoke(i: { deviceId: string; reason: string; atMs: number }): Promise<ScannerDeviceRecord | undefined>;
  /** ACTIVE 기기에 기기 키 지문을 묶는다(재등록은 덮어쓴다). 없거나 ACTIVE가 아니면 undefined */
  bindCredential(i: { deviceId: string; jkt: string; atMs: number }): Promise<ScannerDeviceRecord | undefined>;
  /** platform ScannerGuard의 기기 찾기. 없으면 null, 있으면 상태와 파트너를 준다 */
  byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null>;
  /** 마지막 연락 시각(관측용). 없거나 실패해도 요청을 막지 않는다 */
  touch(deviceId: string, atMs: number): Promise<void>;
}

export const SCANNER_DEVICE_STORE = Symbol('ticket.ScannerDeviceStore');

/** 등록 코드 저장소. 원문은 넘기지 않고 SHA-256 해시만 다룬다 */
export interface EnrollmentCodeStore {
  /** 새 코드 해시를 기기에 묶는다. 같은 기기의 옛 코드는 무효가 된다 */
  put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void>;
  /** 코드 해시를 한 번만 꺼낸다. 없으면 undefined(만료·사용됨) */
  take(codeHash: string): Promise<string | undefined>;
}

export const ENROLLMENT_CODE_STORE = Symbol('ticket.EnrollmentCodeStore');

/** DPoP jti 저장소(platform DpopReplayStore와 같은 모양) */
export interface DpopReplayStore {
  claim(jti: string, ttlMs: number): Promise<boolean>;
}

export const DPOP_REPLAY_STORE = Symbol('ticket.DpopReplayStore');

/** 스캐너 목록·변경분·스캔·이상 표시 저장소. 판정과 일련번호 매기기는 저장소 트랜잭션 안에서 끝낸다. */
export interface ScannerGateStore {
  package(i: { eventId: string; nowMs: number }): Promise<ScannerPackageView>;
  /** 회차의 지금 버전 벡터(근무 준비 응답용, GAT-160). 변경 종류별 마지막 일련번호 */
  versionVector(eventId: string, nowMs: number): Promise<ScannerVersionVector>;
  changes(i: { eventId: string; after: number; limit: number; nowMs?: number }): Promise<ScannerChangesView>;
  acceptScans(i: {
    eventId: string;
    deviceId: string;
    /** 기기 인증만으로 올라온 기록은 없다(세션 밖 기록으로 표시한다) */
    staffAccountId?: string;
    sessionId?: string;
    scans: readonly ScanEventInput[];
    nowMs: number;
    /** 낡은 버전 벡터로 판정한 기록 ID(GAT-160). STALE_VERSION 이상 표시를 만든다 */
    staleVersionIds?: readonly string[];
  }): Promise<ScanBatchResult>;
  listFlags(i: { eventId: string; cursor?: string; limit: number }): Promise<GateFlagPage>;
  /** 이상 표시의 회차. 없으면 undefined. 다른 회차면 403으로 닫는 데 쓴다 */
  flagEventId(flagId: string): Promise<string | undefined>;
  resolveFlag(i: { eventId: string; flagId: string; status: GateFlagStatus; note?: string; resolvedBy: string; nowMs: number }): Promise<GateFlagView | undefined>;
}

export const SCANNER_GATE_STORE = Symbol('ticket.ScannerGateStore');

/** 기기 배치·근무 준비 보고 저장소(GAT-170 잔여, offline-gate §6.2). 배치를 바꾸면 PLACEMENT 변경을 같은 트랜잭션에 적는다 */
export interface ScannerShiftStore {
  placementOf(eventId: string, deviceId: string): Promise<ScannerPlacementRecord | undefined>;
  placementsOf(eventId: string): Promise<ScannerPlacementRecord[]>;
  /**
   * 배치를 넣거나 고친다. expectedVersion은 If-Match의 판(새 배치는 0)이고, 다르면 ScannerPlacementConflict를 던진다.
   * 바꾼 배치를 scanner_change(PLACEMENT)에 같은 트랜잭션으로 적는다.
   */
  putPlacement(i: {
    eventId: string;
    deviceId: string;
    gateZone: string;
    mode: ScannerPlacementMode;
    setBy: string;
    atMs: number;
    expectedVersion: number;
  }): Promise<ScannerPlacementRecord>;
  readinessOf(eventId: string, deviceId: string): Promise<ScannerReadinessRecord | undefined>;
  reportReadiness(i: { eventId: string; deviceId: string; packageSeq: number; clockOffsetMs: number; pendingUploads: number; reportedBy: string; atMs: number }): Promise<ScannerReadinessRecord>;
  /** 회차의 지금 마지막 변경 일련번호(scanner_seq). 없으면 0 */
  lastSeq(eventId: string): Promise<number>;
}

export const SCANNER_SHIFT_STORE = Symbol('ticket.ScannerShiftStore');

/** 기기 폐기 때 identity 스캐너 세션을 끝내고 control.sessions-terminated를 남기는 포트 */
export interface ScannerSessionTerminator {
  terminateByDevice(i: { deviceId: string; reason: 'DEVICE_REVOKED'; atMs: number }): Promise<number>;
}

export const SCANNER_SESSION_TERMINATOR = Symbol('ticket.ScannerSessionTerminator');

/** core-svc 회차의 판매·입장 창(offline-gate §6.2). ticket-svc는 core DB에 직접 붙지 않는다 */
export interface ScannerEventPolicy {
  /** 회차 판매자(테넌트). 파트너 배치의 회차 소유 확인에 쓴다 */
  promoterId: string;
  reentryAllowed: boolean;
  salesOpensAtMs?: number;
  salesEndsAtMs?: number;
  entryOpensAtMs?: number;
  entryClosesAtMs?: number;
  endsAtMs?: number;
}

export interface ScannerEventPolicyProvider {
  /** 회차가 없거나 core-svc가 답하지 못하면 undefined. 배치 검사는 undefined를 '모른다'로 닫는다 */
  get(eventId: string): Promise<ScannerEventPolicy | undefined>;
}

export const SCANNER_EVENT_POLICY = Symbol('ticket.ScannerEventPolicy');

/** 등록 시도 IP 실패 제한(offline-gate §6.1, O-T42). 성공은 세지 않는다 */
export interface EnrollmentAttemptLimiter {
  /** 지금 이 IP가 막히지 않았는가. false면 코드를 꺼내기 전에 429로 닫는다 */
  allowed(ip: string): Promise<boolean>;
  /** 실패 한 번을 세고, 전체 실패가 SEV3 경보 경계를 넘었는지 알린다 */
  failed(ip: string): Promise<{ globalAlert: boolean; globalFailures: number }>;
}

export const ENROLLMENT_ATTEMPT_LIMITER = Symbol('ticket.EnrollmentAttemptLimiter');
