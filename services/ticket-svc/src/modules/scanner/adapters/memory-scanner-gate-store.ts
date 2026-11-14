// 시험·로컬용 스캐너 목록·스캔·이상 표시 저장소. 운영은 DrizzleScannerGateStore다.
import { randomUUID } from 'node:crypto';
import type { DeviceKeyStore } from '../../ticket/index.js';
import type { ScannerGateStore } from '../domain/ports.js';
import type {
  GateFlagAwareness,
  GateFlagKind,
  GateFlagPage,
  GateFlagStatus,
  GateFlagView,
  ScanBatchResult,
  ScanEventInput,
  ScanResult,
  ScannerChangesView,
  ScannerPackageView,
  ScannerTicketStatus,
  ScannerVersionVector,
} from '../domain/scanner-gate.js';

export interface ScannerGateTicketSeed {
  ticketId: string;
  eventId: string;
  seatId: string;
  gateZone: string;
  status: ScannerTicketStatus;
}

interface StoredScan extends Omit<ScanEventInput, 'result' | 'reason'> {
  result: ScanResult;
  reason?: string;
  receivedAt: string;
  flag: GateFlagKind | 'NONE';
}

interface StoredFlag {
  flagId: string;
  eventId: string;
  ticketId: string;
  kind: GateFlagKind;
  awareness: GateFlagAwareness;
  status: GateFlagStatus;
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
  createdAt: string;
}

interface StoredChange {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

const cursorOf = (createdAt: string, flagId: string): string => Buffer.from(JSON.stringify([Date.parse(createdAt), flagId]), 'utf8').toString('base64url');
const parseCursor = (raw: string): { atMs: number; flagId: string } | undefined => {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { atMs: v[0], flagId: v[1] };
  } catch {
    return undefined;
  }
};

export class MemoryScannerGateStore implements ScannerGateStore {
  readonly tickets = new Map<string, ScannerGateTicketSeed>();
  readonly scans = new Map<string, StoredScan>();
  readonly flags = new Map<string, StoredFlag>();
  readonly changeLog = new Map<string, StoredChange[]>();
  readonly seq = new Map<string, number>();

  constructor(private readonly deviceKeys?: DeviceKeyStore) {}

  seedTicket(t: ScannerGateTicketSeed): void {
    this.tickets.set(t.ticketId, { ...t });
  }

  #appendChange(eventId: string, kind: string, payload: Record<string, unknown>): number {
    const seq = (this.seq.get(eventId) ?? 0) + 1;
    this.seq.set(eventId, seq);
    const list = this.changeLog.get(eventId) ?? [];
    list.push({ seq, kind, payload });
    this.changeLog.set(eventId, list);
    return seq;
  }

  /** 배치 저장소가 같은 변경 기록·일련번호를 쓰게 연다(시험·로컬). 운영은 DrizzleScannerShiftStore가 같은 트랜잭션에서 적는다 */
  appendChange(eventId: string, kind: string, payload: Record<string, unknown>): number {
    return this.#appendChange(eventId, kind, payload);
  }

  lastSeq(eventId: string): number {
    return this.seq.get(eventId) ?? 0;
  }

  #versionVector(eventId: string, nowMs: number) {
    const list = this.changeLog.get(eventId) ?? [];
    const lastOf = (...kinds: string[]) => list.filter((c) => kinds.includes(c.kind)).at(-1)?.seq ?? 0;
    return {
      eventId,
      seq: this.seq.get(eventId) ?? 0,
      ticketSeq: lastOf('TICKET_STATUS'),
      keySeq: lastOf('KEY_REGISTERED', 'KEY_REVOKED'),
      policySeq: lastOf('POLICY'),
      placementSeq: lastOf('PLACEMENT'),
      flagSeq: lastOf('FLAG'),
      issuedAt: new Date(nowMs).toISOString(),
      maxOfflineMs: 0,
    };
  }

  async versionVector(eventId: string, nowMs: number): Promise<ScannerVersionVector> {
    return this.#versionVector(eventId, nowMs);
  }

  async package(i: { eventId: string; nowMs: number }): Promise<ScannerPackageView> {
    const tickets = [...this.tickets.values()].filter((t) => t.eventId === i.eventId).sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    const zones = [...new Set(tickets.map((t) => t.gateZone).filter((z) => z !== ''))].sort();
    const keysByTicket = this.deviceKeys ? await this.deviceKeys.activeKeysByEvent(i.eventId) : new Map<string, { keyId: string; publicKey: string }[]>();
    const revokedKeyIds = this.deviceKeys ? await this.deviceKeys.revokedKeyIdsByEvent(i.eventId) : [];
    const views = tickets.map((t) => {
      const last = this.#latestScan(t.ticketId);
      return {
        ticketId: t.ticketId,
        gateZone: t.gateZone,
        seatLabel: t.seatId,
        status: t.status,
        keys: keysByTicket.get(t.ticketId) ?? [],
        ...(last && last.method !== 'VERIFY'
          ? {
              scanState: {
                lastDirection: last.direction,
                lastAt: last.scannedAtDevice,
                ...(last.gateZone ? { lastGateZone: last.gateZone } : {}),
              },
            }
          : {}),
      };
    });
    return {
      eventId: i.eventId,
      reentryAllowed: false,
      gateZones: zones,
      serverTime: new Date(i.nowMs).toISOString(),
      tickets: views,
      revokedKeyIds,
      lastSeq: this.seq.get(i.eventId) ?? 0,
      versionVector: this.#versionVector(i.eventId, i.nowMs),
    };
  }

  async changes(i: { eventId: string; after: number; limit: number; nowMs?: number }): Promise<ScannerChangesView> {
    const all = (this.changeLog.get(i.eventId) ?? []).filter((c) => c.seq > i.after).sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, i.limit);
    return {
      changes: page.map((c) => ({ seq: c.seq, kind: c.kind, payload: c.payload })),
      lastSeq: this.seq.get(i.eventId) ?? 0,
      hasMore: all.length > i.limit,
      versionVector: this.#versionVector(i.eventId, i.nowMs ?? Date.now()),
    };
  }

  async acceptScans(i: {
    eventId: string;
    deviceId: string;
    staffAccountId?: string;
    sessionId?: string;
    scans: readonly ScanEventInput[];
    nowMs: number;
    staleVersionIds?: readonly string[];
  }): Promise<ScanBatchResult> {
    const acceptedIds: string[] = [];
    const createdFlags: GateFlagView[] = [];
    const stale = new Set(i.staleVersionIds ?? []);
    for (const scan of i.scans) {
      if (this.scans.has(scan.id)) {
        acceptedIds.push(scan.id);
        continue;
      }
      const ticket = this.tickets.get(scan.ticketId);
      const latest = this.#latestScan(scan.ticketId);
      let result: ScanResult = scan.result;
      let reason: string | undefined = scan.reason;
      const kinds: GateFlagKind[] = [];
      let keyBad: 'INVALID_QR' | 'KEY_REVOKED' | 'KEY_UNKNOWN' | undefined;
      if (scan.keyId !== undefined) {
        const keyId = /^[A-Za-z0-9_-]{11}$/.test(scan.keyId) ? Buffer.from(scan.keyId, 'base64url') : undefined;
        if (!keyId || keyId.length !== 8) keyBad = 'INVALID_QR';
        else {
          const state = this.deviceKeys ? await this.deviceKeys.keyState(scan.ticketId, new Uint8Array(keyId)) : 'UNKNOWN';
          if (state === 'REVOKED') keyBad = 'KEY_REVOKED';
          else if (state === 'UNKNOWN') keyBad = 'KEY_UNKNOWN';
        }
      }
      if (!ticket || ticket.eventId !== i.eventId) {
        result = 'REJECT';
        reason = 'UNKNOWN_TICKET';
      } else if (ticket.status === 'CANCEL_REQUESTED' || ticket.status === 'REFUNDED' || ticket.status === 'VOIDED') {
        result = 'REJECT';
        reason = 'TICKET_CANCELLED';
        if (scan.direction === 'IN') kinds.push('AFTER_CANCEL');
      } else if (scan.method === 'VERIFY') {
        result = 'CHECK';
        reason = 'VERIFY_ONLY';
      } else if (keyBad) {
        result = 'REJECT';
        reason = keyBad;
      } else if (scan.direction === 'IN' && latest?.direction === 'IN') {
        result = 'REJECT';
        reason = 'ALREADY_IN';
        kinds.push('DUPLICATE');
      } else if (scan.direction === 'OUT' && latest?.direction !== 'IN') {
        result = 'CHECK';
        reason = 'NO_ENTRY_RECORD';
      }
      if (scan.scannerSessionId !== i.sessionId) kinds.push('OUT_OF_SESSION');
      if (stale.has(scan.id)) kinds.push('STALE_VERSION');
      const stored: StoredScan = {
        ...scan,
        result,
        ...(reason !== undefined ? { reason } : {}),
        receivedAt: new Date(i.nowMs).toISOString(),
        flag: kinds[0] ?? 'NONE',
      };
      this.scans.set(scan.id, stored);
      acceptedIds.push(scan.id);
      for (const kind of kinds) {
        const flag = this.#createFlag(i.eventId, scan.ticketId, kind, scan.knownSeq, i.nowMs);
        createdFlags.push(this.#flagView(flag));
        this.#appendChange(i.eventId, 'FLAG', { v: 1, flagId: flag.flagId, ticketId: flag.ticketId, kind: flag.kind, status: flag.status });
      }
      if (result === 'PASS' && scan.method !== 'VERIFY') {
        this.#appendChange(i.eventId, 'SCAN_STATE', {
          v: 1,
          ticketId: scan.ticketId,
          direction: scan.direction,
          scannedAtDevice: scan.scannedAtDevice,
          gateZone: scan.gateZone ?? '',
          deviceId: i.deviceId,
        });
      }
    }
    return { acceptedIds, flags: createdFlags, resyncRequired: stale.size > 0, staleIds: [...stale] };
  }

  async listFlags(i: { eventId: string; cursor?: string; limit: number }): Promise<GateFlagPage> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    const all = [...this.flags.values()]
      .filter((f) => f.eventId === i.eventId)
      .sort((a, b) => (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || b.flagId.localeCompare(a.flagId));
    const filtered = cursor ? all.filter((f) => Date.parse(f.createdAt) < cursor.atMs || (Date.parse(f.createdAt) === cursor.atMs && f.flagId < cursor.flagId)) : all;
    const page = filtered.slice(0, i.limit);
    const last = page.at(-1);
    return { items: page.map((f) => this.#flagView(f)), ...(filtered.length > i.limit && last ? { nextCursor: cursorOf(last.createdAt, last.flagId) } : {}) };
  }

  async flagEventId(flagId: string): Promise<string | undefined> {
    return this.flags.get(flagId)?.eventId;
  }

  async resolveFlag(i: { eventId: string; flagId: string; status: GateFlagStatus; note?: string; resolvedBy: string; nowMs: number }): Promise<GateFlagView | undefined> {
    const flag = this.flags.get(i.flagId);
    if (!flag || flag.eventId !== i.eventId) return undefined;
    const next: StoredFlag = { ...flag, status: i.status, resolvedBy: i.resolvedBy, resolvedAt: new Date(i.nowMs).toISOString(), ...(i.note !== undefined ? { note: i.note } : {}) };
    this.flags.set(i.flagId, next);
    this.#appendChange(i.eventId, 'FLAG', { v: 1, flagId: next.flagId, ticketId: next.ticketId, kind: next.kind, status: next.status });
    return this.#flagView(next);
  }

  #latestScan(ticketId: string): StoredScan | undefined {
    return [...this.scans.values()]
      .filter((s) => s.ticketId === ticketId && s.method !== 'VERIFY' && s.result === 'PASS')
      .sort((a, b) => Date.parse(b.scannedAtDevice) - Date.parse(a.scannedAtDevice) || b.deviceSeq - a.deviceSeq)[0];
  }

  #createFlag(eventId: string, ticketId: string, kind: GateFlagKind, knownSeq: number, nowMs: number): StoredFlag {
    const flag: StoredFlag = {
      flagId: randomUUID(),
      eventId,
      ticketId,
      kind,
      awareness: knownSeq < (this.seq.get(eventId) ?? 0) ? 'CONCURRENT' : 'KNOWN',
      status: 'OPEN',
      createdAt: new Date(nowMs).toISOString(),
    };
    this.flags.set(flag.flagId, flag);
    return flag;
  }

  #flagView(f: StoredFlag): GateFlagView {
    const ticket = this.tickets.get(f.ticketId);
    return {
      flagId: f.flagId,
      ticketId: f.ticketId,
      seatLabel: ticket?.seatId ?? '',
      gateZone: ticket?.gateZone ?? '',
      kind: f.kind,
      awareness: f.awareness,
      status: f.status,
      createdAt: f.createdAt,
    };
  }
}
