// 스캐너 실제 연결 고리(offline-gate §6.2~§6.5, 계획 docs/review/plans/F-05-4.md §3).
// 한 문서에서 한 번만 뜨고, 화면(근무 준비·판정·동기화)이 이 값을 함께 본다. React를 모르므로 훅이 구독한다.
// - 근무 준비: shift → package → shift(배치 판) → 시계 오차·스캐너 세션 ID를 기기 저장소 meta에 남긴다.
// - 목록: `peaket-scanner`에 저장하고 60초마다 변경분을 반영한다. resyncRequired면 다음 동기화에 전체 목록.
// - 판정: runScan(판정→deviceSeq→큐→입장 상태→저장) 뒤 uploader.queued().
// - 업로드: online·visibilitychange·[지금 동기화]는 바로, 로그아웃은 큐를 10초까지 올린 뒤 토큰을 지운다.
import { liveRequested, SCANNER_API_ORIGIN } from '../api/config';
import { ScannerApi, ScannerApiError, type GateFlagView, type ScannerShiftResponse } from '../api/client';
import { generateDpopKey } from '../api/dpop';
import { clearStaffToken, loadDeviceKey, loadStaffSession, loadStaffToken, saveDeviceKey } from '../api/key-store';
import { reloginRequired, serverClockOffsetMs } from '../api/live';
import { runScan, scannerSessionIdOf } from '../judge/scan-flow';
import type { JudgeOutcome } from '../judge/judge';
import { RESULT_HOLD_MS } from './scan-live-state';
import { applyChangePage, packageStateOf, type PackageState, type Placement } from '../storage/package-state';
import { openPackageStore, type DeviceMeta, type PackageStore } from '../storage/package-store';
import { openScanQueue, type ScanQueue } from '../storage/scan-queue';
import { logoutAfterFlush, ScanUploader, type UploadState } from '../sync/uploader';
import { navigate } from './router';
import { freshnessOf, type Freshness, type LiveSetupState, type LiveSyncState } from '../api/live';

export interface LiveScanVerdict {
  outcome: JudgeOutcome;
  atMs: number;
}

export interface LiveSyncView {
  queue: number;
  lastUploadAtMs?: number;
  lastSeq: number;
  lastSyncAtMs?: number;
  freshness: Freshness;
  state: LiveSyncState;
  minAppVersion?: string;
}

export interface LiveView {
  mode: 'preview' | 'loading' | 'live' | 'error';
  error?: string;
  setupState: LiveSetupState;
  shift?: ScannerShiftResponse;
  state?: PackageState;
  placement?: Placement;
  clockOffsetMs?: number;
  scannerSessionId?: string;
  queue: number;
  uploadFailed: boolean;
  lastUploadAtMs?: number;
  lastChangesAtMs?: number;
  needsResync: boolean;
  /** 목록·시계 오차·배치가 모두 있어 판정할 수 있는가 */
  ready: boolean;
  verdict?: LiveScanVerdict;
  flags: GateFlagView[];
  sync?: LiveSyncView;
}

const TOKEN_MESSAGE = '스태프 로그인이 필요합니다. 기기 승인 로그인(SCR-036)을 먼저 마쳐 주세요.';

class LiveRuntime {
  #view: LiveView = { mode: 'preview', setupState: '준비 중', queue: 0, uploadFailed: false, needsResync: false, ready: false, flags: [] };
  #listeners = new Set<() => void>();
  #started = false;
  #starting: Promise<void> | undefined;
  #api: ScannerApi | undefined;
  #key: Awaited<ReturnType<typeof generateDpopKey>> | undefined;
  #token: string | undefined;
  #store: PackageStore | undefined;
  #queue: ScanQueue | undefined;
  #uploader: ScanUploader | undefined;
  #shift: ScannerShiftResponse | undefined;
  #state: PackageState | undefined;
  #clockOffsetMs: number | undefined;
  #scannerSessionId: string | undefined;
  #sameQr = new Map<string, number>();
  #verdictTimer: ReturnType<typeof setTimeout> | undefined;
  #changesTimer: ReturnType<typeof setInterval> | undefined;
  #uploadState: UploadState = { pending: 0, failed: false };
  #lastChangesAtMs: number | undefined;
  #needsResync = false;
  #flags: GateFlagView[] = [];

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  snapshot = (): LiveView => this.#view;

  /** ?live=1이면 한 번 뜬다. 이미 떴으면 아무것도 하지 않는다 */
  ensure(search: string): void {
    if (!liveRequested(search)) {
      if (this.#view.mode !== 'preview') this.#set({ mode: 'preview' });
      return;
    }
    if (this.#started) return;
    this.#started = true;
    this.#set({ mode: 'loading' });
    this.#starting = this.#start().catch((e: unknown) => {
      this.#errorOf(e);
    });
  }

  async #start(): Promise<void> {
    const token = await loadStaffToken();
    if (!token) {
      this.#set({ mode: 'error', error: TOKEN_MESSAGE });
      return;
    }
    this.#token = token;
    const existing = await loadDeviceKey();
    this.#key = existing ?? (await (async () => {
      const created = await generateDpopKey();
      await saveDeviceKey(created);
      return created;
    })());
    this.#store = await openPackageStore();
    this.#queue = await openScanQueue();
    const meta = await this.#store.meta();
    if (meta.clockOffsetMs !== undefined) this.#clockOffsetMs = meta.clockOffsetMs;
    if (meta.scannerSessionId !== undefined) this.#scannerSessionId = meta.scannerSessionId;
    const stored = await this.#store.load();
    this.#state = stored;

    this.#api = new ScannerApi({ origin: SCANNER_API_ORIGIN, key: this.#key, token: this.#token, now: () => Date.now() + (this.#clockOffsetMs ?? 0) });
    try {
      const first = await this.#api.shift();
      this.#shift = first;
      this.#clockOffsetMs = serverClockOffsetMs(first.serverTime, Date.now());
      this.#scannerSessionId = scannerSessionIdOf(this.#token) ?? this.#scannerSessionId;
      await this.#store.setMeta({
        ...(this.#clockOffsetMs !== undefined ? { clockOffsetMs: this.#clockOffsetMs } : {}),
        ...(this.#scannerSessionId !== undefined ? { scannerSessionId: this.#scannerSessionId } : {}),
      });
      const pkg = await this.#api.package(first.eventId);
      // 목록 뒤 근무 준비를 한 번 더 받아 그 배치(판)를 쓴다(offline-gate §6.3, RV-17)
      const second = await this.#api.shift().catch(() => first);
      this.#shift = second;
      const placement: Placement = {
        gateZone: second.placement.gateZone,
        mode: second.placement.mode,
        version: second.placement.version ?? 0,
      };
      this.#state = packageStateOf(pkg, placement, stored?.eventId === pkg.eventId ? stored.entries : undefined);
      await this.#store.save(this.#state);
      if (second.role === 'gate_lead') this.#flags = await this.#api.flags(second.eventId).catch(() => []);
    } catch (e) {
      if (e instanceof ScannerApiError && reloginRequired(e.status, e.type)) {
        await this.#relogin(e.title);
        return;
      }
      // 서버에 닿지 못해도 기기에 목록·오차·배치가 있으면 오프라인 판정을 계속한다(§6.4, O-T5)
      if (!this.#state || this.#clockOffsetMs === undefined) {
        this.#errorOf(e);
        return;
      }
      if (!this.#state.placement.gateZone) {
        this.#errorOf(new Error('기기 배치가 없습니다'));
        return;
      }
    }
    this.#uploader = new ScanUploader({
      queue: this.#queue,
      port: {
        upload: async (batch, o) => {
          if (!this.#api) throw new Error('스캐너 API가 준비되지 않았다');
          const api = new ScannerApi({ origin: SCANNER_API_ORIGIN, key: this.#key!, token: o.withToken ? this.#token : undefined, now: () => Date.now() + (this.#clockOffsetMs ?? 0) });
          const r = await api.uploadScans(batch as Record<string, unknown>[]);
          return { acceptedIds: r.acceptedIds, resyncRequired: r.resyncRequired };
        },
      },
      hasToken: async () => this.#token !== undefined,
      clearToken: async () => {
        this.#token = undefined;
        await clearStaffToken().catch(() => undefined);
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onState: (s) => {
        this.#uploadState = s;
        this.#publish();
      },
      onResync: () => {
        this.#needsResync = true;
        this.#publish();
      },
      onSignedOut: () => {
        this.#token = undefined;
        this.#publish();
        navigate('/login?live=1');
      },
    });
    this.#bindBrowserEvents();
    this.#changesTimer = setInterval(() => void this.syncChanges(), 60_000);
    this.#uploadState = { ...this.#uploadState, pending: await this.#queue.count() };
    this.#view = { ...this.#view, mode: 'live' };
    delete this.#view.error;
    this.#publish();
    if (this.#uploadState.pending > 0) void this.#uploader.flushNow().catch(() => undefined);
  }

  #bindBrowserEvents(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => void this.flushNow());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.flushNow();
    });
  }

  #errorOf(e: unknown): void {
    const message = e instanceof ScannerApiError ? e.title : e instanceof Error ? e.message : '스캐너 API에 닿지 못했습니다';
    this.#set({ mode: 'error', error: message });
  }

  async #relogin(message: string): Promise<void> {
    await clearStaffToken().catch(() => undefined);
    this.#token = undefined;
    this.#set({ mode: 'error', error: message });
    navigate('/login?live=1');
  }

  #set(patch: Partial<LiveView>): void {
    this.#view = { ...this.#view, ...patch };
    this.#publish();
  }

  #publish(): void {
    const state = this.#state;
    const sync: LiveSyncView | undefined = state
      ? this.#syncView(state)
      : undefined;
    this.#view = {
      ...this.#view,
      ...(this.#shift ? { shift: this.#withOffset(this.#shift) } : {}),
      ...(state ? { state, placement: state.placement } : {}),
      ...(this.#clockOffsetMs !== undefined ? { clockOffsetMs: this.#clockOffsetMs } : {}),
      ...(this.#scannerSessionId !== undefined ? { scannerSessionId: this.#scannerSessionId } : {}),
      queue: this.#uploadState.pending,
      uploadFailed: this.#uploadState.failed,
      ...(this.#uploadState.lastUploadAtMs !== undefined ? { lastUploadAtMs: this.#uploadState.lastUploadAtMs } : {}),
      ...(this.#lastChangesAtMs !== undefined ? { lastChangesAtMs: this.#lastChangesAtMs } : {}),
      needsResync: this.#needsResync,
      ready: this.#ready(),
      setupState: this.#setupState(),
      ...(sync ? { sync } : {}),
      flags: this.#flags,
    };
    for (const fn of this.#listeners) fn();
  }

  #withOffset(shift: ScannerShiftResponse): ScannerShiftResponse {
    if (this.#clockOffsetMs === undefined) return shift;
    return { ...shift, package: { ...shift.package, clockOffsetMs: this.#clockOffsetMs } };
  }

  #ready(): boolean {
    const s = this.#state;
    return s !== undefined && this.#clockOffsetMs !== undefined && s.placement.gateZone !== '';
  }

  #setupState(): LiveSetupState {
    if (this.#view.mode === 'error') return this.#shift ? '미등록·폐기 기기' : '목록 받기 거부';
    const shift = this.#shift;
    if (!shift) return '준비 중';
    if (shift.device.status !== 'ACTIVE' || !shift.device.enrolled) return '미등록·폐기 기기';
    if (this.#ready()) return '준비 완료';
    return '준비 중';
  }

  #syncView(state: PackageState): LiveSyncView {
    const now = Date.now();
    const freshness = freshnessOf({
      stored: state.versionVector,
      current: state.versionVector,
      snapshot: this.#lastChangesAtMs !== undefined ? { eventId: state.eventId, lastSeq: state.lastSeq, syncedAtMs: this.#lastChangesAtMs } : undefined,
      nowMs: now,
      queue: this.#uploadState.pending,
      uploadFailed: this.#uploadState.failed,
    });
    const syncState: LiveSyncState = this.#uploadState.pending > 0 && this.#uploadState.failed ? '업로드 실패' : freshness.stale ? '변경분 지연' : '정상';
    return {
      queue: this.#uploadState.pending,
      ...(this.#uploadState.lastUploadAtMs !== undefined ? { lastUploadAtMs: this.#uploadState.lastUploadAtMs } : {}),
      lastSeq: state.lastSeq,
      ...(this.#lastChangesAtMs !== undefined ? { lastSyncAtMs: this.#lastChangesAtMs } : {}),
      freshness,
      state: syncState,
    };
  }

  /** 근무 준비 보고. 실패해도 화면은 스캔으로 넘어간다 */
  async reportReadiness(): Promise<void> {
    const api = this.#api;
    const st = this.#state;
    if (!api || !st || this.#clockOffsetMs === undefined) return;
    const pending = (await this.#queue?.count()) ?? 0;
    try {
      await api.readiness({ packageSeq: st.lastSeq, clockOffsetMs: this.#clockOffsetMs, pendingUploads: pending });
    } catch {
      // 준비 보고는 화면 이동을 막지 않는다
    }
  }

  /** [지금 동기화]: 큐를 바로 올리고 변경분을 받는다 */
  async syncNow(): Promise<void> {
    await this.flushNow();
    await this.syncChanges();
  }

  async flushNow(): Promise<void> {
    if (!this.#uploader) return;
    await this.#uploader.flushNow().catch(() => undefined);
    this.#publish();
  }

  /** 60초 변경분. resyncRequired면 전체 목록을 다시 받는다 */
  async syncChanges(): Promise<void> {
    const api = this.#api;
    const store = this.#store;
    const current = this.#state;
    if (!api || !store || !current) return;
    try {
      if (this.#needsResync) {
        const pkg = await api.package(current.eventId);
        this.#state = packageStateOf(pkg, current.placement, current.entries);
        await store.save(this.#state);
        this.#needsResync = false;
        this.#lastChangesAtMs = Date.now();
        this.#publish();
        return;
      }
      const page = await api.changes(current.eventId, current.lastSeq);
      const terminated = page.changes.find((c) => c.kind === 'SESSION_TERMINATED' && c.payload.deviceId === this.#shift?.device.deviceId);
      if (terminated) {
        await this.#relogin('이 기기의 스캐너 세션이 끝났습니다. 기기 승인 로그인(SCR-036)을 다시 마쳐 주세요.');
        return;
      }
      this.#state = applyChangePage(current, page, this.#shift?.device.deviceId ?? '');
      await store.save(this.#state);
      this.#lastChangesAtMs = Date.now();
      this.#publish();
    } catch (e) {
      if (e instanceof ScannerApiError && reloginRequired(e.status, e.type)) {
        await this.#relogin(e.title);
      }
    }
  }

  /** 판정 한 번. 준비가 안 됐으면 아무것도 하지 않는다. 같은 QR은 3초 안에 버린다 */
  async scan(raw: string): Promise<void> {
    const store = this.#store;
    const queue = this.#queue;
    const state = this.#state;
    if (!this.#ready() || !store || !queue || !state || this.#clockOffsetMs === undefined) return;
    const now = Date.now();
    const last = this.#sameQr.get(raw);
    if (last !== undefined && now - last < 3_000) return;
    this.#sameQr.set(raw, now);
    const sessionId = this.#scannerSessionId;
    const r = await runScan({
      raw,
      state,
      store,
      queue,
      nowMs: now,
      clockOffsetMs: this.#clockOffsetMs,
      ...(sessionId !== undefined ? { scannerSessionId: sessionId } : { scannerSessionId: '' }),
    });
    this.#state = r.state;
    this.#publishVerdict(r.outcome);
    if (r.recorded) {
      this.#uploadState = { ...this.#uploadState, pending: await queue.count() };
      void this.#uploader?.queued().catch(() => undefined);
    }
    this.#publish();
  }

  #publishVerdict(outcome: JudgeOutcome): void {
    if (this.#verdictTimer !== undefined) clearTimeout(this.#verdictTimer);
    this.#set({ verdict: { outcome, atMs: Date.now() } });
    this.#verdictTimer = setTimeout(() => {
      this.#verdictTimer = undefined;
      this.#set({ verdict: undefined });
    }, RESULT_HOLD_MS);
  }

  /** 로그아웃: 큐를 10초까지 올린 뒤 토큰을 지운다(7.4.4) */
  async logout(): Promise<number> {
    this.#changesTimer !== undefined && clearInterval(this.#changesTimer);
    this.#changesTimer = undefined;
    const queue = this.#queue;
    const uploader = this.#uploader;
    let remaining = 0;
    if (queue && uploader) {
      const online = typeof navigator === 'undefined' ? true : navigator.onLine;
      const r = await logoutAfterFlush({
        uploader,
        online,
        queue,
        clearToken: async () => {
          this.#token = undefined;
          await clearStaffToken().catch(() => undefined);
        },
        now: () => Date.now(),
      });
      remaining = r.remaining;
    } else {
      await clearStaffToken().catch(() => undefined);
      this.#token = undefined;
    }
    navigate('/login?live=1');
    return remaining;
  }

  /** 시험·개발용: 이 문서의 실제 연결을 버린다 */
  reset(): void {
    if (this.#changesTimer !== undefined) clearInterval(this.#changesTimer);
    if (this.#verdictTimer !== undefined) clearTimeout(this.#verdictTimer);
    this.#changesTimer = undefined;
    this.#verdictTimer = undefined;
    this.#started = false;
    this.#starting = undefined;
    this.#view = { mode: 'preview', setupState: '준비 중', queue: 0, uploadFailed: false, needsResync: false, ready: false, flags: [] };
    this.#listeners.clear();
  }
}

export const liveRuntime = new LiveRuntime();
