// 시험·로컬용 부스 재발급 저장소(운영은 DrizzleBoothStore). MemoryDeviceKeyStore의 티켓·기기·배치·스캔·이상 표시를 읽어
// 부스 코드·허용·BOOTH 사용 표시와 SCR-052 기기 현황·내 예외 통과를 메모리에서 지킨다.
import { randomUUID } from 'node:crypto';
import { ScannerPlacementMissing } from '../../scanner/index.js';
import type { GateStatusView, OverridePassView, OverrideReviewStatus } from '../domain/booth.js';
import type { BoothStore } from '../domain/ports.js';

interface TicketLike {
  ticketId: string;
  eventId: string;
  accountId?: string;
  eventStartsAtMs?: number;
  seatId?: string;
  seatLabel?: string;
}
interface ScanLike {
  id: string;
  ticketId: string;
  method: string;
  result: string;
  reason?: string;
  gateZone?: string;
  scannedAtDevice: string;
  staffAccountId?: string;
}
interface FlagLike {
  flagId: string;
  eventId: string;
  ticketId: string;
  kind: string;
  status: string;
}
interface Deps {
  deviceKeys: { tickets: Map<string, TicketLike> };
  devices: { findById(deviceId: string): Promise<{ name: string } | undefined> };
  shift: {
    placementOf(eventId: string, deviceId: string): Promise<{ gateZone: string; mode: 'IN' | 'OUT'; version?: number } | undefined>;
    placementsOf(eventId: string): Promise<{ deviceId: string; gateZone: string; mode: 'IN' | 'OUT'; version?: number }[]>;
    readinessOf(eventId: string, deviceId: string): Promise<{ packageSeq: number; pendingUploads: number; reportedAtMs: number } | undefined>;
  };
  gate: { scans: Map<string, ScanLike>; flags: Map<string, FlagLike>; entryCloses: Map<string, number>; tickets?: Map<string, TicketLike> };
}

interface BoothRow {
  id: string;
  ticketId: string;
  eventId: string;
  codeHash: string;
  reverificationId?: string;
  status: 'PENDING' | 'ALLOWED' | 'USED' | 'EXPIRED';
  dayKey: string;
  requestedAtMs: number;
  codeExpiresAtMs: number;
  allowedAtMs?: number;
  expiresAtMs?: number;
  usedAtMs?: number;
}

export class MemoryBoothStore implements BoothStore {
  readonly rows = new Map<string, BoothRow>();
  constructor(private readonly d: Deps) {}

  #ticket(ticketId: string): TicketLike | undefined {
    return this.d.deviceKeys.tickets.get(ticketId) ?? this.d.gate.tickets?.get(ticketId);
  }

  #label(t: TicketLike): string {
    return t.seatLabel ?? t.seatId ?? t.ticketId;
  }

  async ownerOf(ticketId: string): Promise<string | undefined> {
    return this.#ticket(ticketId)?.accountId;
  }

  async createRequest(i: { ticketId: string; accountId: string; codeHash: string; nowMs: number; dayKey: string; expiresAtMs: number; reverificationId?: string }) {
    const t = this.#ticket(i.ticketId);
    if (!t || t.accountId !== i.accountId) return { kind: 'not_found' as const };
    if (t.eventStartsAtMs === undefined || i.nowMs < t.eventStartsAtMs) return { kind: 'before_entry' as const };
    if ([...this.rows.values()].filter((r) => r.ticketId === i.ticketId && r.dayKey === i.dayKey).length >= 3) return { kind: 'limit' as const };
    // 새 요청은 아직 찍히지 않은 옛 코드(PENDING)만 무효로 한다. 이미 허용된(ALLOWED) 코드는 그 허용으로 쓴다
    for (const r of this.rows.values()) if (r.ticketId === i.ticketId && r.status === 'PENDING') r.status = 'EXPIRED';
    const id = randomUUID();
    this.rows.set(id, {
      id,
      ticketId: i.ticketId,
      eventId: t.eventId,
      codeHash: i.codeHash,
      ...(i.reverificationId !== undefined ? { reverificationId: i.reverificationId } : {}),
      status: 'PENDING',
      dayKey: i.dayKey,
      requestedAtMs: i.nowMs,
      codeExpiresAtMs: i.expiresAtMs,
    });
    return { kind: 'created' as const, boothRequestId: id, expiresAtMs: i.expiresAtMs };
  }

  async authorize(i: { eventId: string; deviceId: string; codeHash: string; nowMs: number; allowUntilMs: number }) {
    const row = [...this.rows.values()].find((r) => r.eventId === i.eventId && r.codeHash === i.codeHash && (r.status === 'PENDING' || r.status === 'ALLOWED' || r.status === 'USED'));
    if (!row) return { kind: 'not_found' as const };
    if (row.eventId !== i.eventId) return { kind: 'event_mismatch' as const };
    if (row.status === 'USED' || row.usedAtMs !== undefined) return { kind: 'expired' as const };
    if (row.codeExpiresAtMs <= i.nowMs) return { kind: 'expired' as const };
    if (row.status === 'PENDING') {
      row.status = 'ALLOWED';
      row.allowedAtMs = i.nowMs;
      row.expiresAtMs = i.allowUntilMs;
    }
    return { kind: 'authorized' as const, ticketId: row.ticketId, seatLabel: this.#label(this.#ticket(row.ticketId)!), allowUntilMs: row.expiresAtMs! };
  }

  async consumeForRegistration(i: { ticketId: string; boothRequestId: string; nowMs: number }): Promise<boolean> {
    const row = this.rows.get(i.boothRequestId);
    if (!row || row.ticketId !== i.ticketId || row.status !== 'ALLOWED' || row.usedAtMs !== undefined) return false;
    if (row.expiresAtMs === undefined || row.expiresAtMs <= i.nowMs) return false;
    row.usedAtMs = i.nowMs;
    row.status = 'USED';
    return true;
  }

  async gateStatus(i: { eventId: string; deviceId: string }): Promise<GateStatusView> {
    const placement = await this.d.shift.placementOf(i.eventId, i.deviceId);
    if (!placement) throw new ScannerPlacementMissing();
    const placements = await this.d.shift.placementsOf(i.eventId);
    const devices = [];
    for (const p of placements) {
      const device = await this.d.devices.findById(p.deviceId);
      const ready = await this.d.shift.readinessOf(i.eventId, p.deviceId);
      devices.push({
        deviceId: p.deviceId,
        name: device?.name ?? p.deviceId,
        placement: { gateZone: p.gateZone, mode: p.mode },
        ready: ready !== undefined,
        ...(ready ? { packageSeq: ready.packageSeq, lastSyncAt: new Date(ready.reportedAtMs).toISOString(), pendingUploads: ready.pendingUploads } : { pendingUploads: 0 }),
      });
    }
    const scans = [...this.d.gate.scans.values()].filter((s) => s.ticketId && this.#ticket(s.ticketId)?.eventId === i.eventId);
    const entriesByZone: Record<string, number> = {};
    const rejectsByReason: Record<string, number> = {};
    let overrideCount = 0;
    for (const s of scans) {
      if (s.result === 'PASS') {
        const zone = s.gateZone ?? '';
        if (zone) entriesByZone[zone] = (entriesByZone[zone] ?? 0) + 1;
      } else if (s.result === 'REJECT' && s.reason) {
        rejectsByReason[s.reason] = (rejectsByReason[s.reason] ?? 0) + 1;
      }
      if (s.method === 'OVERRIDE') overrideCount++;
    }
    const flags = [...this.d.gate.flags.values()].filter((f) => f.eventId === i.eventId);
    return {
      devices,
      entriesByZone,
      rejectsByReason,
      openFlags: flags.filter((f) => f.status === 'OPEN').length,
      boothCount: [...this.rows.values()].filter((r) => r.eventId === i.eventId && r.status === 'USED').length,
      overrideCount,
      ...(this.d.gate.entryCloses.get(i.eventId) !== undefined ? { entryClosedAt: new Date(this.d.gate.entryCloses.get(i.eventId)!).toISOString() } : {}),
    };
  }

  async overridePasses(i: { eventId: string; staffAccountId: string; deviceId: string; limit: number }): Promise<OverridePassView[]> {
    if (!(await this.d.shift.placementOf(i.eventId, i.deviceId))) throw new ScannerPlacementMissing();
    const scans = [...this.d.gate.scans.values()]
      .filter((s) => s.method === 'OVERRIDE' && s.staffAccountId === i.staffAccountId && this.#ticket(s.ticketId)?.eventId === i.eventId)
      .sort((a, b) => Date.parse(b.scannedAtDevice) - Date.parse(a.scannedAtDevice))
      .slice(0, i.limit);
    const flags = [...this.d.gate.flags.values()];
    return scans.map((s) => {
      const flag = flags.find((f) => f.ticketId === s.ticketId && f.kind === 'OVERRIDE_REVIEW');
      const status: OverrideReviewStatus =
        flag?.status === 'OK' ? 'OK' : flag?.status === 'SUSPECT' ? 'SUSPECT' : flag?.status === 'UNDETERMINED' ? 'UNDETERMINED' : 'WAITING';
      return {
        scanId: s.id,
        at: s.scannedAtDevice,
        ticketId: s.ticketId,
        seatLabel: this.#label(this.#ticket(s.ticketId)!),
        reason: s.reason ?? 'OVERRIDE_OTHER',
        ...(s.reason ? {} : {}),
        reviewStatus: status,
      };
    });
  }
}
