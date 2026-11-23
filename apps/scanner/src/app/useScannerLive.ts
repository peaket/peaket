// SCR-033·SCR-035의 실제 연결 고리. live-runtime 하나를 화면들이 함께 본다(계획 §3).
// ?state= 퍼블리싱 모드에서는 아무것도 부르지 않는다. `?live=1`이거나 빌드가 실제 연결이면 기기 키·토큰으로 뜬다.
import { useSyncExternalStore } from 'react';
import type { GateFlagView, ScannerShiftResponse } from '../api/client';
import type { Freshness, LiveSetupState, LiveSyncState } from '../api/live';
import { liveRuntime } from './live-runtime';

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
  ready: boolean;
  queue: number;
  reportReadiness(): Promise<void>;
  syncNow(): Promise<void>;
  reload(): void;
}

export function useScannerLive(search: string): ScannerLive {
  liveRuntime.ensure(search);
  const view = useSyncExternalStore(liveRuntime.subscribe, liveRuntime.snapshot, liveRuntime.snapshot);
  return {
    mode: view.mode,
    ...(view.error ? { error: view.error } : {}),
    setupState: view.setupState,
    ...(view.shift ? { shift: view.shift } : {}),
    flags: view.flags,
    ...(view.sync ? { sync: view.sync } : {}),
    ready: view.ready,
    queue: view.queue,
    reportReadiness: () => liveRuntime.reportReadiness(),
    syncNow: () => liveRuntime.syncNow(),
    reload: () => liveRuntime.restart(),
  };
}
