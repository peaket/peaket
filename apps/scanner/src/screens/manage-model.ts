// SCR-052 현장 관리의 실제 API 조립(d5 §8.5, docs/features/offline-gate.md §7.2·§9.1, docs/review/plans/F-05-12.md §4).
// 화면(.tsx)은 그리기만 하고, 부르는 순서·실패 갈래·다시 부르지 않기는 이 순수 클래스가 지킨다.
import type { GateFlagView, GateStatusView, OverridePassView } from '../api/client.ts';

export type ManageTab = 'devices' | 'flags' | 'booth' | 'mine';
export type ManageState = 'ready' | 'forbidden' | 'no-placement' | 'offline' | 'error';

export interface DeviceRow {
  deviceId: string;
  name: string;
  placement: string;
  ready: boolean;
  lastSyncAt?: string;
  pendingUploads: number;
  self: boolean;
}
export interface FlagRow {
  flagId: string;
  seatLabel: string;
  kindLabel: string;
  awarenessLabel: string;
  statusLabel: string;
  resolved: boolean;
}
export interface BoothView {
  kind: 'authorized' | 'expired' | 'forbidden' | 'not-found' | 'offline' | 'error';
  seatLabel?: string;
  allowUntil?: string;
}
export interface OverrideRow {
  scanId: string;
  at: string;
  seatLabel: string;
  reason: string;
  reviewLabel: string;
}
export interface ManageSnapshot {
  tabs: ManageTab[];
  state: ManageState;
  devices: DeviceRow[];
  flags: FlagRow[];
  overrides: OverrideRow[];
  /** SCR-052 상단 요약(서버 GateStatus의 집계). 시험은 이 칸을 보지 않는다 */
  summary?: {
    entriesByZone: Record<string, number>;
    rejectsByReason: Record<string, number>;
    openFlags: number;
    boothCount: number;
    overrideCount: number;
    entryClosedAt?: string;
  };
  error?: string;
}

export interface ManageApi {
  devices(eventId: string): Promise<GateStatusView>;
  flags(eventId: string): Promise<GateFlagView[]>;
  overridePasses(eventId: string): Promise<{ items: OverridePassView[] }>;
  boothAuthorization(boothCode: string): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }>;
  resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void>;
}

/** 일반 스태프에게는 기기 탭만 준다. d5 §8.5 '일반 스태프 | 메뉴가 없고, API는 403' */
export function manageTabsFor(role: 'gate_staff' | 'gate_lead'): ManageTab[] {
  return role === 'gate_lead' ? ['devices', 'flags', 'booth', 'mine'] : ['devices'];
}

export function devicesViewOf(s: { devices: GateStatusView['devices']; selfDeviceId: string }): DeviceRow[] {
  return s.devices.map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    placement: d.placement ? `${d.placement.gateZone} · ${d.placement.mode === 'IN' ? '입장' : '퇴장'}` : '배치 없음',
    ready: d.ready,
    lastSyncAt: d.lastSyncAt,
    pendingUploads: d.pendingUploads,
    self: d.deviceId === s.selfDeviceId,
  }));
}

const KIND: Record<string, string> = {
  DUPLICATE: '중복 입장',
  NO_EXIT: '퇴장 기록 없음',
  AFTER_CANCEL: '취소 뒤 입장',
  OUT_OF_SESSION: '세션 밖 기록',
  AFTER_CLOSE: '마감 뒤 도착',
  TIME_UNCERTAIN: '시각 불확실',
  STALE_VERSION: '낡은 판',
  OVERRIDE_REVIEW: '예외 통과 사후 검토',
};
const STATUS: Record<string, string> = { OPEN: '처리 전', OK: '정상', SUSPECT: '부적정', UNDETERMINED: '판단 불가' };

export function flagsViewOf(items: GateFlagView[]): FlagRow[] {
  return items.map((f) => ({
    flagId: f.flagId,
    seatLabel: f.seatLabel,
    kindLabel: f.kind === 'DUPLICATE' && f.awareness === 'CONCURRENT' ? '중복 입장(동시)' : (KIND[f.kind] ?? f.kind),
    awarenessLabel: f.awareness === 'CONCURRENT' ? '몰랐음' : f.awareness === 'KNOWN' ? '알고도 통과' : f.awareness,
    statusLabel: STATUS[f.status] ?? f.status,
    resolved: f.status !== 'OPEN',
  }));
}

export function boothViewOf(r: { ticketId: string; seatLabel: string; allowUntil: string } | { status: number; type: string }): BoothView {
  if ('status' in r) {
    if (r.status === 410) return { kind: 'expired' };
    if (r.status === 403) return { kind: 'forbidden' };
    if (r.status === 404) return { kind: 'not-found' };
    return { kind: 'error' };
  }
  return { kind: 'authorized', seatLabel: r.seatLabel, allowUntil: r.allowUntil };
}

const REVIEW: Record<string, string> = { WAITING: '검토 대기', OK: '정상', SUSPECT: '부적정', UNDETERMINED: '판단 불가' };
export function overridesViewOf(items: OverridePassView[]): OverrideRow[] {
  return items.map((p) => ({ scanId: p.scanId, at: p.at, seatLabel: p.seatLabel, reason: p.reason, reviewLabel: REVIEW[p.reviewStatus] ?? p.reviewStatus }));
}

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined;
}
function typeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' ? (e as { type: string }).type : undefined;
}

export class ManageController {
  #state: ManageState = 'ready';
  #terminal = false;
  readonly #d: { api: ManageApi; eventId: string; role: 'gate_staff' | 'gate_lead'; deviceId: string; online?: () => boolean };
  constructor(d: { api: ManageApi; eventId: string; role: 'gate_staff' | 'gate_lead'; deviceId: string; online?: () => boolean }) {
    this.#d = d;
  }

  async load(): Promise<ManageSnapshot> {
    const tabs = manageTabsFor(this.#d.role);
    if (this.#terminal) return this.#snapshot(tabs, this.#state);
    if (this.#d.online && !this.#d.online()) {
      this.#state = 'offline';
      this.#terminal = true;
      return this.#snapshot(tabs, this.#state);
    }
    let status: GateStatusView;
    try {
      status = await this.#d.api.devices(this.#d.eventId);
    } catch (e) {
      this.#state = statusOf(e) === 403 ? 'forbidden' : statusOf(e) === 409 && typeOf(e) === 'no-placement' ? 'no-placement' : 'error';
      this.#terminal = true;
      return this.#snapshot(tabs, this.#state, typeOf(e) ?? '스캐너 API에 닿지 못했습니다');
    }
    let flags: GateFlagView[] = [];
    let overrides: OverridePassView[] = [];
    if (this.#d.role === 'gate_lead') {
      try {
        [flags, { items: overrides }] = await Promise.all([this.#d.api.flags(this.#d.eventId), this.#d.api.overridePasses(this.#d.eventId)]);
      } catch (e) {
        this.#state = statusOf(e) === 403 ? 'forbidden' : 'error';
        this.#terminal = true;
        return this.#snapshot(tabs, this.#state, typeOf(e) ?? '스캐너 API에 닿지 못했습니다');
      }
    }
    this.#state = 'ready';
    return {
      tabs,
      state: 'ready',
      devices: devicesViewOf({ devices: status.devices, selfDeviceId: this.#d.deviceId }),
      flags: flagsViewOf(flags),
      overrides: overridesViewOf(overrides),
      summary: {
        entriesByZone: status.entriesByZone,
        rejectsByReason: status.rejectsByReason,
        openFlags: status.openFlags,
        boothCount: status.boothCount,
        overrideCount: status.overrideCount,
        ...(status.entryClosedAt !== undefined ? { entryClosedAt: status.entryClosedAt } : {}),
      },
    };
  }

  async authorizeBooth(code: string): Promise<BoothView> {
    if (this.#d.online && !this.#d.online()) return { kind: 'offline' };
    try {
      return boothViewOf(await this.#d.api.boothAuthorization(code));
    } catch (e) {
      return boothViewOf({ status: statusOf(e) ?? 0, type: typeOf(e) ?? '' });
    }
  }

  async resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void> {
    await this.#d.api.resolveFlag(flagId, status, note);
  }

  #snapshot(tabs: ManageTab[], state: ManageState, error?: string): ManageSnapshot {
    return { tabs, state, devices: [], flags: [], overrides: [], ...(error !== undefined ? { error } : {}) };
  }
}
