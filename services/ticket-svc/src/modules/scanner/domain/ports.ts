// 스캐너 기기 원장·등록 코드·DPoP jti 저장소의 포트(BUILD_ORDER GAT-170).
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
