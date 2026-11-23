// 스캐너 회차 목록 상태와 변경분 반영(offline-gate §6.3 '변경분 판 1', 계획 docs/review/plans/F-05-4.md §3).
// 순수 함수다(저장소를 모른다). 넘긴 상태는 바꾸지 않고 새 값을 돌려준다.
import type { ScannerChangesResponse, ScannerPackageResponse } from '../api/client.ts';
import { isReadablePublicKey } from '../judge/qr-v1.ts';

export interface StoredTicket {
  ticketId: string;
  gateZone: string;
  seatLabel: string;
  status: string;
  statusVersion: number;
  keys: { keyId: string; publicKey?: string }[];
}

export interface EntryState {
  /** 마지막 방향. 이 기기 통과(LOCAL)와 변경분(CHANGES)·목록(PACKAGE) 가운데 늦은 쪽 */
  lastDirection: 'IN' | 'OUT';
  lastAtMs: number;
  gateZone: string;
  source: 'PACKAGE' | 'CHANGES' | 'LOCAL';
}

export interface Placement {
  gateZone: string;
  mode: 'IN' | 'OUT';
  /** 근무 준비 응답 placement.version(배치 행의 판). 판이 없는 옛 응답은 0 */
  version: number;
}

export interface ScannerVersionVectorLike {
  eventId: string;
  seq: number;
  ticketSeq: number;
  keySeq: number;
  policySeq: number;
  placementSeq: number;
  flagSeq: number;
  issuedAt: string;
  maxOfflineMs: number;
}

export interface PackageState {
  eventId: string;
  reentryAllowed: boolean;
  gateZones: string[];
  tickets: ReadonlyMap<string, StoredTicket>;
  revoked: ReadonlySet<string>;
  entries: ReadonlyMap<string, EntryState>;
  lastSeq: number;
  versionVector: ScannerVersionVectorLike;
  placement: Placement;
  resyncRequired: boolean;
}

/**
 * 전체 목록을 상태로 옮긴다. keepLocal에 이 기기의 입장 상태를 주면 목록 값보다 늦은 것만 남긴다
 * (아직 올리지 않은 통과를 잃지 않는다, §6.4).
 */
export function packageStateOf(pkg: ScannerPackageResponse, placement: Placement, keepLocal?: ReadonlyMap<string, EntryState>): PackageState {
  const tickets = new Map<string, StoredTicket>();
  const entries = new Map<string, EntryState>();
  for (const t of pkg.tickets) {
    tickets.set(t.ticketId, {
      ticketId: t.ticketId,
      gateZone: t.gateZone,
      seatLabel: t.seatLabel,
      status: t.status,
      statusVersion: 0,
      keys: t.keys.map((k) => ({ keyId: k.keyId, ...(k.publicKey !== undefined ? { publicKey: k.publicKey } : {}) })),
    });
    if (t.scanState) {
      entries.set(t.ticketId, {
        lastDirection: t.scanState.lastDirection,
        lastAtMs: Date.parse(t.scanState.lastAt),
        gateZone: t.scanState.lastGateZone ?? t.gateZone,
        source: 'PACKAGE',
      });
    }
  }
  if (keepLocal) {
    for (const [ticketId, local] of keepLocal) {
      const fromPackage = entries.get(ticketId);
      if (!fromPackage || local.lastAtMs > fromPackage.lastAtMs) entries.set(ticketId, local);
    }
  }
  return {
    eventId: pkg.eventId,
    reentryAllowed: pkg.reentryAllowed,
    gateZones: [...pkg.gateZones],
    tickets,
    revoked: new Set(pkg.revokedKeyIds),
    entries,
    lastSeq: pkg.lastSeq,
    versionVector: pkg.versionVector,
    placement,
    resyncRequired: false,
  };
}

/** 이 기기 입장 상태 하나를 더한다(넘긴 상태는 그대로) */
export function withLocalEntry(state: PackageState, ticketId: string, entry: EntryState): PackageState {
  const entries = new Map(state.entries);
  entries.set(ticketId, entry);
  return { ...state, entries };
}

const isV1 = (payload: Record<string, unknown>): boolean => payload.v === 1;
const stringOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const numberish = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * 변경분 한 쪽을 반영한다. 저장한 마지막 번호 이하의 변경은 버리고, 모르는 종류·판은 건너뛴다.
 * 반영이 끝나면 마지막 번호·저장 벡터는 그 쪽 응답의 값이 된다(RV-05).
 */
export function applyChangePage(state: PackageState, page: ScannerChangesResponse, deviceId: string): PackageState {
  let tickets = new Map(state.tickets);
  let revoked = new Set(state.revoked);
  let entries = new Map(state.entries);
  let reentryAllowed = state.reentryAllowed;
  let placement = state.placement;
  let resyncRequired = state.resyncRequired;

  for (const change of [...page.changes].sort((a, b) => a.seq - b.seq)) {
    if (change.seq <= state.lastSeq) continue;
    const payload = change.payload;
    if (!payload || !isV1(payload)) continue;
    switch (change.kind) {
      case 'KEY_REGISTERED': {
        const ticketId = stringOf(payload.ticketId);
        const keyId = stringOf(payload.keyId);
        const publicKey = stringOf(payload.publicKey);
        if (!ticketId || !keyId) break;
        const ticket = tickets.get(ticketId);
        if (!ticket) break;
        if (!publicKey || !isReadablePublicKey(publicKey)) {
          resyncRequired = true;
          break;
        }
        const keys = ticket.keys.filter((k) => k.keyId !== keyId);
        keys.push({ keyId, publicKey });
        tickets = new Map(tickets);
        tickets.set(ticketId, { ...ticket, keys });
        break;
      }
      case 'KEY_REVOKED': {
        const keyId = stringOf(payload.keyId);
        const ticketId = stringOf(payload.ticketId);
        if (!keyId || !ticketId) break;
        revoked = new Set(revoked);
        revoked.add(keyId);
        const ticket = tickets.get(ticketId);
        if (ticket) {
          tickets = new Map(tickets);
          tickets.set(ticketId, { ...ticket, keys: ticket.keys.filter((k) => k.keyId !== keyId) });
        }
        break;
      }
      case 'TICKET_STATUS': {
        const ticketId = stringOf(payload.ticketId);
        const status = stringOf(payload.status);
        const version = numberish(payload.version);
        if (!ticketId || !status || version === undefined) break;
        const ticket = tickets.get(ticketId);
        if (!ticket || version <= ticket.statusVersion) break;
        tickets = new Map(tickets);
        tickets.set(ticketId, { ...ticket, status, statusVersion: version });
        break;
      }
      case 'SCAN_STATE': {
        const ticketId = stringOf(payload.ticketId);
        const direction = payload.direction === 'IN' || payload.direction === 'OUT' ? payload.direction : undefined;
        const at = stringOf(payload.scannedAtDevice);
        if (!ticketId || !direction || !at) break;
        const atMs = Date.parse(at);
        if (!Number.isFinite(atMs)) break;
        const current = entries.get(ticketId);
        if (current && atMs < current.lastAtMs) break;
        entries = new Map(entries);
        entries.set(ticketId, { lastDirection: direction, lastAtMs: atMs, gateZone: stringOf(payload.gateZone) ?? '', source: 'CHANGES' });
        break;
      }
      case 'POLICY': {
        if (typeof payload.reentryAllowed !== 'boolean') break;
        reentryAllowed = payload.reentryAllowed;
        break;
      }
      case 'PLACEMENT': {
        const forDevice = stringOf(payload.deviceId);
        const version = numberish(payload.version);
        const gateZone = stringOf(payload.gateZone);
        const mode = payload.mode === 'IN' || payload.mode === 'OUT' ? payload.mode : undefined;
        if (forDevice !== deviceId || version === undefined || !gateZone || !mode) break;
        if (version <= placement.version) break;
        placement = { gateZone, mode, version };
        break;
      }
      default:
        // FLAG·SESSION_TERMINATED·모르는 종류는 상태를 바꾸지 않는다
        break;
    }
  }
  return {
    ...state,
    tickets,
    revoked,
    entries,
    reentryAllowed,
    placement,
    resyncRequired,
    lastSeq: page.lastSeq,
    versionVector: page.versionVector,
  };
}
