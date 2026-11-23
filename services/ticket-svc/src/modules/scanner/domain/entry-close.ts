// 입장 기록 마감의 순수 규칙(offline-gate §7.3 'GAT-180 마감 규칙', BUILD_ORDER GAT-180).
// - 로그인했던 기기: 그 회차에 근무 준비 보고(scanner_readiness)가 있는 기기다(저장소가 고른다).
// - 비웠다는 보고: 그 기기의 마지막 큐 비움 보고가 pendingUploads = 0이고 받은 시각이 역할 유효 끝 이상인 것뿐이다.
// - 판단: 역할 유효 끝 전에는 마감하지 않는다. 모두 보고했으면 ALL_REPORTED, 아니면 역할 유효 끝 + 24시간 [가정] 뒤 TIMEOUT.
// - 미보고 건 eventKey: scanner-unreported:{회차}:{기기}의 SHA-256 앞 16바이트 UUID(transfer-refund §3.1 ②와 같은 꼴).
import { createHash } from 'node:crypto';
import { ScannerGateInputError } from './scanner-gate.js';

/** 역할 유효 끝 = ends_at + 2시간 [가정](offline-gate §7.3) */
export const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 미보고 대기 = 역할 유효 끝 + 24시간 [가정](offline-gate §7.3) */
export const UNREPORTED_WAIT_MS = 86_400_000;

/** 한 회차에 로그인했던 기기 하나와 그 기기의 마지막 큐 비움 보고 */
export interface EntryCloseDevice {
  deviceId: string;
  report?: { pendingUploads: number; reportedAtMs: number };
}

export type EntryCloseReason = 'ALL_REPORTED' | 'TIMEOUT';

export type EntryCloseDecision =
  | { close: false }
  | { close: true; reason: EntryCloseReason; roleEndsAtMs: number; unreportedDeviceIds: string[] };

/**
 * 마감 여부를 정한다. 경계 판단은 nowMs로 하고(역할 유효 끝 이상·+24시간 이상), 마감 시각은 저장소가 잠금 뒤에 읽는다.
 * 로그인했던 기기가 없으면 역할 유효 끝 뒤 첫 판단에서 ALL_REPORTED로 마감한다.
 */
export function decideEntryClose(i: { nowMs: number; endsAtMs: number; devices: readonly EntryCloseDevice[] }): EntryCloseDecision {
  const roleEndsAtMs = i.endsAtMs + ROLE_END_AFTER_ENDS_MS;
  if (i.nowMs < roleEndsAtMs) return { close: false };
  const unreported: string[] = [];
  for (const d of i.devices) {
    const report = d.report;
    if (report !== undefined && report.pendingUploads === 0 && report.reportedAtMs >= roleEndsAtMs) continue;
    unreported.push(d.deviceId);
  }
  if (unreported.length === 0) return { close: true, reason: 'ALL_REPORTED', roleEndsAtMs, unreportedDeviceIds: [] };
  if (i.nowMs < roleEndsAtMs + UNREPORTED_WAIT_MS) return { close: false };
  return { close: true, reason: 'TIMEOUT', roleEndsAtMs, unreportedDeviceIds: unreported };
}

/** 미보고 스캐너 건의 eventKey. 같은 회차·기기는 늘 같은 키라 다시 보내도 ops-svc에서 한 건이다 */
export function scannerUnreportedEventKey(eventId: string, deviceId: string): string {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 큐 비움 보고 본문(openapi putScannerEventQueueReport). pendingUploads만 있는 0 이상 정수가 아니면 400이다 */
export function assertQueueReport(body: unknown): { pendingUploads: number } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ScannerGateInputError('QUEUE');
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1 || keys[0] !== 'pendingUploads') throw new ScannerGateInputError('QUEUE');
  const n = o.pendingUploads;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ScannerGateInputError('QUEUE');
  return { pendingUploads: n };
}
