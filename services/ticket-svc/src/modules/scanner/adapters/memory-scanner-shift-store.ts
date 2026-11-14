// 시험·로컬용 기기 배치·근무 준비 저장소. 운영은 DrizzleScannerShiftStore다.
// 배치 변경은 MemoryScannerGateStore의 변경 기록에 같은 일련번호로 들어가 목록·변경분·버전 벡터에 보인다.
import type { ScannerShiftStore } from '../domain/ports.js';
import { type ScannerPlacementMode, type ScannerPlacementRecord, ScannerPlacementConflict, type ScannerReadinessRecord } from '../domain/scanner-shift.js';

export interface ShiftChangeSink {
  appendChange(eventId: string, kind: string, payload: Record<string, unknown>): number;
  lastSeq(eventId: string): number;
}

export class MemoryScannerShiftStore implements ScannerShiftStore {
  readonly placements = new Map<string, ScannerPlacementRecord>();
  readonly readiness = new Map<string, ScannerReadinessRecord>();

  constructor(private readonly changes?: ShiftChangeSink) {}

  #key(eventId: string, deviceId: string): string {
    return `${eventId}/${deviceId}`;
  }

  async placementOf(eventId: string, deviceId: string): Promise<ScannerPlacementRecord | undefined> {
    const p = this.placements.get(this.#key(eventId, deviceId));
    return p ? { ...p } : undefined;
  }

  async placementsOf(eventId: string): Promise<ScannerPlacementRecord[]> {
    return [...this.placements.values()].filter((p) => p.eventId === eventId).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  async putPlacement(i: {
    eventId: string;
    deviceId: string;
    gateZone: string;
    mode: ScannerPlacementMode;
    setBy: string;
    atMs: number;
    expectedVersion: number;
  }): Promise<ScannerPlacementRecord> {
    const key = this.#key(i.eventId, i.deviceId);
    const current = this.placements.get(key);
    if (current) {
      if (current.version !== i.expectedVersion) throw new ScannerPlacementConflict();
    } else if (i.expectedVersion !== 0) {
      throw new ScannerPlacementConflict();
    }
    const next: ScannerPlacementRecord = {
      eventId: i.eventId,
      deviceId: i.deviceId,
      gateZone: i.gateZone,
      mode: i.mode,
      setBy: i.setBy,
      setAtMs: i.atMs,
      version: (current?.version ?? 0) + 1,
    };
    this.placements.set(key, next);
    this.changes?.appendChange(i.eventId, 'PLACEMENT', { v: 1, deviceId: i.deviceId, gateZone: i.gateZone, mode: i.mode, version: next.version });
    return { ...next };
  }

  async readinessOf(eventId: string, deviceId: string): Promise<ScannerReadinessRecord | undefined> {
    const r = this.readiness.get(this.#key(eventId, deviceId));
    return r ? { ...r } : undefined;
  }

  async reportReadiness(i: {
    eventId: string;
    deviceId: string;
    packageSeq: number;
    clockOffsetMs: number;
    pendingUploads: number;
    reportedBy: string;
    atMs: number;
  }): Promise<ScannerReadinessRecord> {
    const next: ScannerReadinessRecord = {
      eventId: i.eventId,
      deviceId: i.deviceId,
      packageSeq: i.packageSeq,
      clockOffsetMs: i.clockOffsetMs,
      pendingUploads: i.pendingUploads,
      reportedBy: i.reportedBy,
      reportedAtMs: i.atMs,
    };
    this.readiness.set(this.#key(i.eventId, i.deviceId), next);
    return { ...next };
  }

  async lastSeq(eventId: string): Promise<number> {
    return this.changes?.lastSeq(eventId) ?? 0;
  }
}
