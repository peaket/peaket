// SCR-034 판정 화면의 실제 연결 고리(계획 §3). live-runtime을 구독하고 스캔 한 번을 넘긴다.
// 화면 모양(상태 이름·2초 유지)은 순수 모듈 scan-live-state.ts가 정한다.
import { useSyncExternalStore } from 'react';
import { liveRuntime, type LiveView } from './live-runtime';

export interface ScanLive extends LiveView {
  scan(raw: string): Promise<void>;
}

export function useScanLive(search: string): ScanLive {
  liveRuntime.ensure(search);
  const view = useSyncExternalStore(liveRuntime.subscribe, liveRuntime.snapshot, liveRuntime.snapshot);
  return { ...view, scan: (raw: string) => liveRuntime.scan(raw) };
}
