// 스캐너 오프라인 스냅샷 버전 벡터와 동기화 신선도(offline-gate §6.3, GAT-160).
// 서버 package·changes가 주는 종류별 마지막 일련번호를 저장하고, 재접속 때 낡은 스냅샷을 가려낸다.
export interface ScannerVersionVector {
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

export type VersionRelation = 'same' | 'ahead' | 'behind' | 'diverged';

const FIELDS = ['seq', 'ticketSeq', 'keySeq', 'policySeq', 'placementSeq', 'flagSeq'] as const;

/** 두 벡터의 각 칸을 견준다. 모든 칸이 같으면 same, 한쪽만 크면 ahead/behind, 섞이면 diverged */
export function compareVersionVectors(a: ScannerVersionVector, b: ScannerVersionVector): VersionRelation {
  let aAhead = false;
  let bAhead = false;
  for (const k of FIELDS) {
    if (a[k] > b[k]) aAhead = true;
    else if (b[k] > a[k]) bAhead = true;
  }
  if (aAhead && bAhead) return 'diverged';
  if (aAhead) return 'ahead';
  if (bAhead) return 'behind';
  return 'same';
}

/** 스냅샷을 받은 뒤 서버가 정한 오프라인 허용 시간을 넘겼는가. 경계값(같음)은 아직 신선하다 */
export function isSnapshotStale(vector: Pick<ScannerVersionVector, 'issuedAt' | 'maxOfflineMs'>, syncedAtMs: number, nowMs: number): boolean {
  if (nowMs - syncedAtMs > vector.maxOfflineMs) return true;
  return nowMs - Date.parse(vector.issuedAt) > vector.maxOfflineMs;
}

/**
 * 재동기화가 필요한가.
 * - 저장한 스냅샷이 오프라인 허용 시간을 넘겼다.
 * - 서버 벡터가 저장 벡터보다 뒤처졌거나(diverged) 서버가 더 새 변경을 갖고 있다(behind).
 * 서버 벡터가 저장 벡터보다 앞서면(ahead) 변경분만 받으면 되므로 전체 재동기화는 필요 없다.
 */
export function needsResync(stored: ScannerVersionVector, current: ScannerVersionVector, syncedAtMs: number, nowMs: number): boolean {
  if (stored.eventId !== current.eventId) return true;
  if (isSnapshotStale(stored, syncedAtMs, nowMs)) return true;
  const rel = compareVersionVectors(current, stored);
  return rel === 'behind' || rel === 'diverged';
}

export interface VersionVectorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const VERSION_VECTOR_STORAGE_KEY = 'peaket.scanner.version-vector';

export function saveVersionVector(storage: VersionVectorStorage, vector: ScannerVersionVector): void {
  storage.setItem(VERSION_VECTOR_STORAGE_KEY, JSON.stringify(vector));
}

export function loadVersionVector(storage: VersionVectorStorage): ScannerVersionVector | undefined {
  const raw = storage.getItem(VERSION_VECTOR_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.eventId !== 'string' || typeof v.issuedAt !== 'string' || !Number.isFinite(Date.parse(v.issuedAt))) return undefined;
    for (const k of [...FIELDS, 'maxOfflineMs'] as const) if (!Number.isSafeInteger(v[k]) || (v[k] as number) < 0) return undefined;
    return {
      eventId: v.eventId,
      seq: v.seq as number,
      ticketSeq: v.ticketSeq as number,
      keySeq: v.keySeq as number,
      policySeq: v.policySeq as number,
      placementSeq: v.placementSeq as number,
      flagSeq: v.flagSeq as number,
      issuedAt: v.issuedAt,
      maxOfflineMs: v.maxOfflineMs as number,
    };
  } catch {
    return undefined;
  }
}

export function clearVersionVector(storage: VersionVectorStorage): void {
  storage.removeItem(VERSION_VECTOR_STORAGE_KEY);
}
