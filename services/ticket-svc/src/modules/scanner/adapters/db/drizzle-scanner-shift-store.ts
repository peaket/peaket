// ticket DB의 기기 배치·근무 준비 보고 저장소(Drizzle, GAT-170 잔여, offline-gate §6.2).
// 배치를 바꾸면 같은 트랜잭션에서 scanner_seq를 올리고 scanner_change(PLACEMENT)를 적는다(ADR-0086).
import type { Database } from '@peaket/platform';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ScannerShiftStore } from '../../domain/ports.js';
import { type ScannerPlacementMode, type ScannerPlacementRecord, ScannerPlacementConflict, type ScannerReadinessRecord } from '../../domain/scanner-shift.js';
import { scannerChange, scannerPlacement, scannerReadiness, scannerSeq } from './schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const modeOf = (v: string): ScannerPlacementMode => {
  if (v === 'IN' || v === 'OUT') return v;
  throw new Error(`알 수 없는 배치 모드: ${v}`);
};

const placementOf = (r: typeof scannerPlacement.$inferSelect): ScannerPlacementRecord => ({
  eventId: r.eventId,
  deviceId: r.scannerDeviceId,
  gateZone: r.gateZone,
  mode: modeOf(r.mode),
  setBy: r.setBy,
  setAtMs: r.setAt.getTime(),
  version: r.version,
});

const readinessOf = (r: typeof scannerReadiness.$inferSelect): ScannerReadinessRecord => ({
  eventId: r.eventId,
  deviceId: r.scannerDeviceId,
  packageSeq: r.packageSeq,
  clockOffsetMs: r.clockOffsetMs,
  pendingUploads: r.pendingUploads,
  reportedBy: r.reportedBy,
  reportedAtMs: r.reportedAt.getTime(),
});

/** 변경 일련번호를 올리고 변경 기록을 적는다. 커밋 순서와 번호 순서를 맞추려고 행 잠금을 쓴다(ADR-0086) */
async function appendChange(tx: Tx, eventId: string, kind: 'PLACEMENT', payload: Record<string, unknown>, nowMs: number): Promise<number> {
  const [row] = await tx
    .insert(scannerSeq)
    .values({ eventId, lastSeq: 1 })
    .onConflictDoUpdate({ target: scannerSeq.eventId, set: { lastSeq: sql`${scannerSeq.lastSeq} + 1` } })
    .returning({ lastSeq: scannerSeq.lastSeq });
  if (!row) throw new Error('회차 변경 일련번호를 올리지 못했다');
  await tx.insert(scannerChange).values({ eventId, seq: row.lastSeq, kind, payload, createdAt: new Date(nowMs) });
  return row.lastSeq;
}

export class DrizzleScannerShiftStore implements ScannerShiftStore {
  constructor(private readonly database: Database) {}

  async placementOf(eventId: string, deviceId: string): Promise<ScannerPlacementRecord | undefined> {
    const [row] = await this.database.db
      .select()
      .from(scannerPlacement)
      .where(and(eq(scannerPlacement.eventId, eventId), eq(scannerPlacement.scannerDeviceId, deviceId)))
      .limit(1);
    return row ? placementOf(row) : undefined;
  }

  async placementsOf(eventId: string): Promise<ScannerPlacementRecord[]> {
    const rows = await this.database.db
      .select()
      .from(scannerPlacement)
      .where(eq(scannerPlacement.eventId, eventId))
      .orderBy(asc(scannerPlacement.scannerDeviceId));
    return rows.map(placementOf);
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
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(scannerPlacement)
        .where(and(eq(scannerPlacement.eventId, i.eventId), eq(scannerPlacement.scannerDeviceId, i.deviceId)))
        .limit(1)
        .for('update');
      let row: typeof scannerPlacement.$inferSelect | undefined;
      if (current) {
        if (current.version !== i.expectedVersion) throw new ScannerPlacementConflict();
        [row] = await tx
          .update(scannerPlacement)
          .set({ gateZone: i.gateZone, mode: i.mode, setBy: i.setBy, setAt: new Date(i.atMs), version: current.version + 1 })
          .where(and(eq(scannerPlacement.eventId, i.eventId), eq(scannerPlacement.scannerDeviceId, i.deviceId)))
          .returning();
      } else {
        if (i.expectedVersion !== 0) throw new ScannerPlacementConflict();
        [row] = await tx
          .insert(scannerPlacement)
          .values({ eventId: i.eventId, scannerDeviceId: i.deviceId, gateZone: i.gateZone, mode: i.mode, setBy: i.setBy, setAt: new Date(i.atMs), version: 1 })
          .returning();
      }
      if (!row) throw new Error('배치를 쓰지 못했다');
      await appendChange(tx, i.eventId, 'PLACEMENT', { v: 1, deviceId: i.deviceId, gateZone: i.gateZone, mode: i.mode, version: row.version }, i.atMs);
      return placementOf(row);
    });
  }

  async readinessOf(eventId: string, deviceId: string): Promise<ScannerReadinessRecord | undefined> {
    const [row] = await this.database.db
      .select()
      .from(scannerReadiness)
      .where(and(eq(scannerReadiness.eventId, eventId), eq(scannerReadiness.scannerDeviceId, deviceId)))
      .limit(1);
    return row ? readinessOf(row) : undefined;
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
    const [row] = await this.database.db
      .insert(scannerReadiness)
      .values({
        eventId: i.eventId,
        scannerDeviceId: i.deviceId,
        packageSeq: i.packageSeq,
        clockOffsetMs: i.clockOffsetMs,
        pendingUploads: i.pendingUploads,
        reportedBy: i.reportedBy,
        reportedAt: new Date(i.atMs),
      })
      .onConflictDoUpdate({
        target: [scannerReadiness.eventId, scannerReadiness.scannerDeviceId],
        set: {
          packageSeq: i.packageSeq,
          clockOffsetMs: i.clockOffsetMs,
          pendingUploads: i.pendingUploads,
          reportedBy: i.reportedBy,
          reportedAt: new Date(i.atMs),
        },
      })
      .returning();
    if (!row) throw new Error('근무 준비 보고를 쓰지 못했다');
    return readinessOf(row);
  }

  async lastSeq(eventId: string): Promise<number> {
    const [row] = await this.database.db.select({ lastSeq: scannerSeq.lastSeq }).from(scannerSeq).where(eq(scannerSeq.eventId, eventId)).limit(1);
    return row?.lastSeq ?? 0;
  }
}
