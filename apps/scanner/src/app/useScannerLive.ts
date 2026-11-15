// SCR-033·SCR-035의 실제 API 연결 고리(offline-gate §6.2·§6.3, GAT-170).
// 퍼블리싱 모드(?state=)에서는 아무것도 부르지 않고, `?live=1`이거나 빌드가 실제 연결이면
// IndexedDB의 기기 키·스태프 토큰으로 근무 준비·목록·변경분을 받는다. 토큰이 없으면 로그인 안내 상태다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { openScanQueue } from '../storage/scan-queue';
import { loadVersionVector, saveVersionVector } from '../storage/version-vector';
import { ScannerApi, ScannerApiError, type GateFlagView, type ScannerShiftResponse, type ScannerVersionVector } from '../api/client';
import { liveRequested, SCANNER_API_ORIGIN } from '../api/config';
import { generateDpopKey } from '../api/dpop';
import { clearStaffToken, loadDeviceKey, loadStaffSession, loadStaffToken, saveDeviceKey } from '../api/key-store';
import { freshnessOf, loadSyncSnapshot, reloginRequired, saveSyncSnapshot, serverClockOffsetMs, sessionExpiryDelayMs, syncChangePages, syncStateOf, type Freshness, type LiveSetupState, type LiveSyncState, type SyncSnapshot } from '../api/live';
import { navigate } from './router';

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
  /** 서버 시각 - 기기 시각. DPoP iat와 준비 보고를 서버 시계에 맞춘다(C1-07) */
  const clockOffsetRef = useRef(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  /** 401·세션 종료·기기 폐기·만료는 토큰을 지우고 로그인으로 돌린다(C1-08·C1-09) */
  const relogin = useCallback(async (message: string) => {
    await clearStaffToken().catch(() => undefined);
    apiRef.current = undefined;
    shiftRef.current = undefined;
    setMode('error');
    setError(message);
    navigate('/login?live=1');
  }, []);

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
        const api = new ScannerApi({ origin: SCANNER_API_ORIGIN, key, token, now: () => Date.now() + clockOffsetRef.current });
        apiRef.current = api;
        const s = await api.shift();
        clockOffsetRef.current = serverClockOffsetMs(s.serverTime, Date.now());
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
        // 토큰 만료·세션 종료·기기 폐기는 저장 토큰을 지워 재로그인으로 돌린다(C1-09).
        if (e instanceof ScannerApiError && reloginRequired(e.status, e.type)) {
          if (alive) await relogin(e.title);
          return;
        }
        setMode('error');
        setError(e instanceof ScannerApiError ? e.title : e instanceof Error ? e.message : '스캐너 API에 닿지 못했습니다');
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [search, tick, relogin]);

  // 스태프 토큰 만료 시각에 맞춰 로그인으로 돌린다. 서버 시계 보정값을 더해 잰다(C1-08).
  useEffect(() => {
    if (mode !== 'live') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadStaffSession(Date.now() + clockOffsetRef.current)
      .then((session) => {
        if (!session) return relogin('스태프 세션이 끝났습니다. 다시 로그인해 주세요.');
        const delay = sessionExpiryDelayMs(session.expiresAtMs, Date.now() + clockOffsetRef.current);
        if (delay === undefined) return;
        if (delay <= 0) return relogin('스태프 세션이 만료되었습니다. 다시 로그인해 주세요.');
        timer = setTimeout(() => void relogin('스태프 세션이 만료되었습니다. 다시 로그인해 주세요.'), delay);
      })
      .catch(() => undefined);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mode, relogin]);

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
    try {
    const queue = await openScanQueue().then((q) => q.count()).catch(() => 0);
    const storage = window.localStorage;
    const stored = loadVersionVector(storage);
    const saved = loadSyncSnapshot(storage);
    const pkg = await api.package(s.eventId);
    // 저장한 마지막 번호가 있으면 그 번호부터 받는다. 처음 받는 기기만 목록의 lastSeq부터 받는다(C1-06).
    const cursor = saved?.eventId === s.eventId ? saved.lastSeq : pkg.lastSeq;
    const beforeSnapshot: SyncSnapshot = saved ?? { eventId: s.eventId, lastSeq: cursor, syncedAtMs: 0 };
    const now = Date.now();
    // 페이지를 끝까지 받는다. 서버 lastSeq는 페이지 끝 번호라 그 값을 다음 커서로 쓴다(C1-05).
    const synced = await syncChangePages({
      snapshot: beforeSnapshot,
      after: cursor,
      deviceId: s.device.deviceId,
      fetchPage: (after) => api.changes(s.eventId, after, 5000),
      nowMs: now,
    });
    // 기기 폐기로 이 기기의 세션이 끝났으면 토큰을 지우고 로그인 화면으로 돌려보낸다(O-T27).
    if (synced.terminated) {
      await relogin('이 기기의 스캐너 세션이 끝났습니다. 기기 승인 로그인(SCR-036)을 다시 마쳐 주세요.');
      return;
    }
    if (!synced.last) return;
    const before = synced.snapshot;
    const changes = synced.last;
    const current: ScannerVersionVector = changes.versionVector;
    const freshness = freshnessOf({ ...(stored ? { stored } : {}), current, snapshot: { ...before, syncedAtMs: now }, nowMs: now, queue });
    saveVersionVector(storage, current);
    saveSyncSnapshot(storage, before);
    setSync({
      queue,
      ...(before.lastUploadAtMs !== undefined ? { lastUploadAtMs: before.lastUploadAtMs } : {}),
      lastSeq: before.lastSeq,
      lastSyncAtMs: now,
      freshness,
      state: syncStateOf({ freshness, queue }),
      ...(pkg.minAppVersion ? { minAppVersion: pkg.minAppVersion } : {}),
    });
    } catch (e) {
      if (e instanceof ScannerApiError && reloginRequired(e.status, e.type)) {
        await relogin(e.title);
        return;
      }
      throw e;
    }
  }, [relogin]);

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
