// SCR-033·SCR-035의 실제 API 연결 고리(offline-gate §6.2·§6.3, GAT-170).
// 퍼블리싱 모드(?state=)에서는 아무것도 부르지 않고, `?live=1`이거나 빌드가 실제 연결이면
// IndexedDB의 기기 키·스태프 토큰으로 근무 준비·목록·변경분을 받는다. 토큰이 없으면 로그인 안내 상태다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { openScanQueue } from '../storage/scan-queue';
import { loadVersionVector, saveVersionVector } from '../storage/version-vector';
import { ScannerApi, ScannerApiError, type GateFlagView, type ScannerShiftResponse, type ScannerVersionVector } from '../api/client';
import { liveRequested, SCANNER_API_ORIGIN } from '../api/config';
import { generateDpopKey } from '../api/dpop';
import { loadDeviceKey, loadStaffToken, saveDeviceKey } from '../api/key-store';
import { applyChanges, freshnessOf, loadSyncSnapshot, saveSyncSnapshot, syncStateOf, type Freshness, type LiveSetupState, type LiveSyncState, type SyncSnapshot } from '../api/live';

export interface LiveSyncView {
  queue: number;
  lastUploadAtMs?: number;
  lastSeq: number;
  lastSyncAtMs?: number;
  freshness: Freshness;
  state: LiveSyncState;
  minAppVersion?: string;
}

export interface ScannerLive {
  mode: 'preview' | 'loading' | 'live' | 'error';
  error?: string;
  setupState: LiveSetupState;
  shift?: ScannerShiftResponse;
  flags: GateFlagView[];
  sync?: LiveSyncView;
  reportReadiness(): Promise<void>;
  syncNow(): Promise<void>;
  reload(): void;
}

export function useScannerLive(search: string): ScannerLive {
  const [mode, setMode] = useState<ScannerLive['mode']>(liveRequested(search) ? 'loading' : 'preview');
  const [error, setError] = useState<string>();
  const [shift, setShift] = useState<ScannerShiftResponse>();
  const [flags, setFlags] = useState<GateFlagView[]>([]);
  const [sync, setSync] = useState<LiveSyncView>();
  const [tick, setTick] = useState(0);
  const apiRef = useRef<ScannerApi | undefined>(undefined);
  const shiftRef = useRef<ScannerShiftResponse | undefined>(undefined);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!liveRequested(search)) {
      setMode('preview');
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      if (alive) {
        setMode('error');
        setError('스태프 로그인이 필요합니다. 기기 승인 로그인(SCR-036)을 먼저 마쳐 주세요.');
      }
    }, 2_500);
    void (async () => {
      try {
        const token = await loadStaffToken();
        if (!token) {
          if (alive) {
            clearTimeout(timer);
            setMode('error');
            setError('스태프 로그인이 필요합니다. 기기 승인 로그인(SCR-036)을 먼저 마쳐 주세요.');
          }
          return;
        }
        const existing = await loadDeviceKey();
        const key = existing ?? (await (async () => {
          const created = await generateDpopKey();
          await saveDeviceKey(created);
          return created;
        })());
        const api = new ScannerApi({ origin: SCANNER_API_ORIGIN, key, token });
        apiRef.current = api;
        const s = await api.shift();
        shiftRef.current = s;
        if (!alive) return;
        setShift(s);
        setMode('live');
        setError(undefined);
        clearTimeout(timer);
        if (s.role === 'gate_lead') {
          const f = await api.flags(s.eventId).catch(() => []);
          if (alive) setFlags(f);
        }
      } catch (e) {
        if (!alive) return;
        clearTimeout(timer);
        setMode('error');
        setError(e instanceof ScannerApiError ? e.title : e instanceof Error ? e.message : '스캐너 API에 닿지 못했습니다');
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [search, tick]);

  const reportReadiness = useCallback(async () => {
    const api = apiRef.current;
    const s = shiftRef.current;
    if (!api || !s) return;
    const queue = await openScanQueue().then((q) => q.count()).catch(() => 0);
    const clockOffsetMs = Math.round(Date.parse(s.serverTime) - Date.now());
    await api.readiness({ packageSeq: s.packageSeq, clockOffsetMs, pendingUploads: queue });
    const next = await api.shift();
    shiftRef.current = next;
    setShift(next);
  }, []);

  const syncNow = useCallback(async () => {
    const api = apiRef.current;
    const s = shiftRef.current;
    if (!api || !s) return;
    const queue = await openScanQueue().then((q) => q.count()).catch(() => 0);
    const storage = window.localStorage;
    const stored = loadVersionVector(storage);
    const before: SyncSnapshot = loadSyncSnapshot(storage) ?? { eventId: s.eventId, lastSeq: 0, syncedAtMs: 0 };
    const pkg = await api.package(s.eventId);
    const changes = await api.changes(s.eventId, pkg.lastSeq);
    const now = Date.now();
    const current: ScannerVersionVector = changes.versionVector;
    const freshness = freshnessOf({ ...(stored ? { stored } : {}), current, snapshot: { ...before, syncedAtMs: now }, nowMs: now, queue });
    const next = applyChanges({ ...before, eventId: s.eventId, lastSeq: pkg.lastSeq, syncedAtMs: now }, changes, now);
    saveVersionVector(storage, current);
    saveSyncSnapshot(storage, next);
    setSync({
      queue,
      ...(next.lastUploadAtMs !== undefined ? { lastUploadAtMs: next.lastUploadAtMs } : {}),
      lastSeq: next.lastSeq,
      lastSyncAtMs: now,
      freshness,
      state: syncStateOf({ freshness, queue }),
      ...(pkg.minAppVersion ? { minAppVersion: pkg.minAppVersion } : {}),
    });
  }, []);

  useEffect(() => {
    if (mode !== 'live') return;
    void syncNow().catch(() => undefined);
    const timer = setInterval(() => void syncNow().catch(() => undefined), 60_000);
    return () => clearInterval(timer);
  }, [mode, syncNow]);

  return {
    mode,
    ...(error ? { error } : {}),
    setupState: shift ? (shift.device.status !== 'ACTIVE' || !shift.device.enrolled ? '미등록·폐기 기기' : shift.package.stale ? '준비 중' : '준비 완료') : mode === 'error' ? '목록 받기 거부' : '준비 중',
    ...(shift ? { shift } : {}),
    flags,
    ...(sync ? { sync } : {}),
    reportReadiness,
    syncNow,
    reload,
  };
}
