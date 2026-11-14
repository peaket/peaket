// 스캐너 기기 원장·등록 코드·DPoP jti·목록/스캔/이상 표시 저장소의 포트(BUILD_ORDER GAT-170·GAT-180).
import type {
  GateFlagPage,
  GateFlagStatus,
  GateFlagView,
  ScanBatchResult,
  ScanEventInput,
  ScannerChangesView,
  ScannerPackageView,
} from './scanner-gate.js';
import type { ScannerDeviceRecord } from './scanner-device.js';

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
  changes(i: { eventId: string; after: number; limit: number }): Promise<ScannerChangesView>;
  acceptScans(i: {
    eventId: string;
    deviceId: string;
    staffAccountId: string;
    sessionId: string;
    scans: readonly ScanEventInput[];
    nowMs: number;
  }): Promise<ScanBatchResult>;
  listFlags(i: { eventId: string; cursor?: string; limit: number }): Promise<GateFlagPage>;
  /** 이상 표시의 회차. 없으면 undefined. 다른 회차면 403으로 닫는 데 쓴다 */
  flagEventId(flagId: string): Promise<string | undefined>;
  resolveFlag(i: { eventId: string; flagId: string; status: GateFlagStatus; note?: string; resolvedBy: string; nowMs: number }): Promise<GateFlagView | undefined>;
}

export const SCANNER_GATE_STORE = Symbol('ticket.ScannerGateStore');
