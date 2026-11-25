// SCR-033·SCR-035의 실제 데이터를 화면 값으로 바꾸는 순수 함수와 저장 규칙(offline-gate §6.2·§6.3).
// React를 모르므로 단위 시험(node --test)이 그대로 부른다.
import type { ScannerChangesResponse, ScannerShiftResponse, ScannerVersionVector } from './client';
import { needsResync } from '../storage/version-vector.ts';

export const LIVE_SETUP_STATES = ['준비 중', '준비 완료', '배치 없음', '목록 받기 제한', '목록 받기 거부', '앱 판이 낮음', '미등록·폐기 기기'] as const;
export type LiveSetupState = (typeof LIVE_SETUP_STATES)[number];
export const LIVE_SYNC_STATES = ['정상', '변경분 지연', '업로드 실패'] as const;
export type LiveSyncState = (typeof LIVE_SYNC_STATES)[number];

export interface SyncSnapshot {
  eventId: string;
  /** 마지막으로 받은 서버 변경 일련번호 */
  lastSeq: number;
  /** 목록·변경분을 마지막으로 받은 시각(ms) */
  syncedAtMs: number;
  /** 마지막 업로드 성공 시각(ms). 없으면 아직 올린 기록이 없다 */
  lastUploadAtMs?: number;
}

export const SYNC_STORAGE_KEY = 'peaket.scanner.sync';

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveSyncSnapshot(storage: SyncStorage, s: SyncSnapshot): void {
  storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(s));
}

export function loadSyncSnapshot(storage: SyncStorage): SyncSnapshot | undefined {
  const raw = storage.getItem(SYNC_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.eventId !== 'string' || typeof v.lastSeq !== 'number' || typeof v.syncedAtMs !== 'number') return undefined;
    return {
      eventId: v.eventId,
      lastSeq: v.lastSeq,
      syncedAtMs: v.syncedAtMs,
      ...(typeof v.lastUploadAtMs === 'number' ? { lastUploadAtMs: v.lastUploadAtMs } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 근무 준비 응답에서 화면 상태를 고른다. 403·409는 부르는 쪽이 ScannerApiError로 가른다 */
export function setupStateOf(shift: ScannerShiftResponse): LiveSetupState {
  if (shift.device.status !== 'ACTIVE' || !shift.device.enrolled) return '미등록·폐기 기기';
  if (shift.package.stale) return '준비 중';
  return '준비 완료';
}

/** 401·기기 폐기·세션 종료는 저장 토큰을 지우고 재로그인으로 돌린다(C1-09) */
export function reloginRequired(status: number, type: string): boolean {
  return status === 401 || (status === 403 && (type === 'device-revoked' || type === 'invalid_token'));
}

/** 서버 시각과 기기 시각의 차이(ms). DPoP iat와 준비 보고를 서버 시계에 맞춘다(C1-07) */
export function serverClockOffsetMs(serverTime: string, nowMs: number): number {
  const server = Date.parse(serverTime);
  if (!Number.isFinite(server)) return 0;
  return Math.round(server - nowMs);
}

/**
 * 큐 비움 보고를 보낼 순간인가(offline-gate §7.3 '큐 비움 보고' 끝, F-05-12).
 * 첫 '비었음'(emptyReported=false)과 1건 이상에서 0건이 된 순간에만 보낸다. 0건이 이어지면 보내지 않는다.
 */
export function queueReportDue(i: { previousPending: number; nextPending: number; emptyReported: boolean }): boolean {
  return i.nextPending === 0 && (i.previousPending > 0 || !i.emptyReported);
}

/** 세션이 끝날 때까지 남은 시간(ms). 이미 끝났으면 0, 만료를 모르면 undefined(C1-08) */
export function sessionExpiryDelayMs(expiresAtMs: number, nowMs: number): number | undefined {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs === Number.MAX_SAFE_INTEGER) return undefined;
  return Math.max(0, expiresAtMs - nowMs);
}

/** 준비 보고에 실을 시계 오차. 화면은 +0.4초처럼 보인다 */
export function formatClockOffset(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs}ms`;
  return `${sign}${(abs / 1000).toFixed(1)}초`;
}

/** 마지막 수신 뒤 지난 시간. 0~59초는 'N초 전', 60분 이상은 'N시간 전' */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '—';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

export interface Freshness {
  /** 화면에 보일 마지막 수신 표기 */
  label: string;
  ageMs: number;
  stale: boolean;
  /** 전체 재동기화가 필요한가(저장 벡터가 낡았거나 서버가 뒤처짐) */
  resync: boolean;
}

/**
 * SCR-035 신선도. 마지막 수신 시각과 저장 벡터를 지금 서버 벡터와 견준다.
 * 경계값(정확히 maxOfflineMs)은 아직 신선하다(storage/version-vector.ts와 같은 규칙).
 */
export function freshnessOf(i: {
  stored?: ScannerVersionVector;
  current: ScannerVersionVector;
  snapshot?: SyncSnapshot;
  nowMs: number;
  queue: number;
  uploadFailed?: boolean;
}): Freshness {
  if (!i.snapshot || !i.stored) {
    return { label: '받은 적 없음', ageMs: Number.POSITIVE_INFINITY, stale: true, resync: true };
  }
  const ageMs = Math.max(0, i.nowMs - i.snapshot.syncedAtMs);
  const resync = needsResync(i.stored, i.current, i.snapshot.syncedAtMs, i.nowMs);
  const stale = resync || ageMs > i.current.maxOfflineMs;
  return { label: formatAge(ageMs), ageMs, stale, resync };
}

export function syncStateOf(i: { freshness: Freshness; queue: number; uploadFailed?: boolean }): LiveSyncState {
  if (i.queue > 0 && i.uploadFailed) return '업로드 실패';
  if (i.freshness.stale) return '변경분 지연';
  return '정상';
}

/** 변경분을 반영한 새 스냅샷. 마지막 번호는 서버가 준 lastSeq를 쓴다 */
export function applyChanges(snapshot: SyncSnapshot, changes: ScannerChangesResponse, nowMs: number): SyncSnapshot {
  return { ...snapshot, eventId: changes.versionVector.eventId, lastSeq: changes.lastSeq, syncedAtMs: nowMs };
}

/** 이 기기의 세션이 끝났다는 변경분(SESSION_TERMINATED)이 있으면 그 까닭을 준다(O-T27) */
export function sessionTerminatedOf(changes: ScannerChangesResponse, deviceId: string): { reason?: string } | undefined {
  for (const c of changes.changes) {
    if (c.kind !== 'SESSION_TERMINATED') continue;
    if (c.payload.deviceId !== deviceId) continue;
    return typeof c.payload.reason === 'string' ? { reason: c.payload.reason } : {};
  }
  return undefined;
}

/**
 * 변경분을 페이지 끝까지 받는다. 서버 lastSeq는 페이지 끝 번호이므로 그 값을 다음 after로 쓴다(C1-05·C1-06).
 * 세션 종료 변경분을 만나면 그때 멈추고 snapshot을 더 진행하지 않는다. 부르는 쪽이 재로그인으로 돌린다.
 */
export async function syncChangePages(i: {
  snapshot: SyncSnapshot;
  after: number;
  deviceId: string;
  fetchPage: (after: number) => Promise<ScannerChangesResponse>;
  nowMs: number;
  maxPages?: number;
}): Promise<{ snapshot: SyncSnapshot; last?: ScannerChangesResponse; terminated?: { reason?: string }; pages: number }> {
  let cursor = i.after;
  let snapshot = i.snapshot;
  let last: ScannerChangesResponse | undefined;
  const maxPages = i.maxPages ?? 50;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await i.fetchPage(cursor);
    const terminated = sessionTerminatedOf(page, i.deviceId);
    if (terminated) return { snapshot, last: page, terminated, pages };
    snapshot = applyChanges({ ...snapshot, lastSeq: cursor, syncedAtMs: i.nowMs }, page, i.nowMs);
    last = page;
    if (!page.hasMore || page.lastSeq === cursor) return { snapshot, last, pages };
    cursor = page.lastSeq;
  }
  return { snapshot, last, pages: maxPages };
}
