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
