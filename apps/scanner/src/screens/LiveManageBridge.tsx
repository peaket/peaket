// SCR-052 실제 API 연결(TR-01). `?live=1`이면 manage-model의 ManageController로 기기·이상 표시·부스·내 예외 통과를 읽는다.
// 화면 본문은 이 훅이 준 snapshot을 그리고, 실패한 화면 상태는 ManageScreen이 그린다. 퍼블리싱 미리보기에서는 아무것도 부르지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { liveRequested } from "../api/config";
import { liveRuntime } from "../app/live-runtime";
import { useLocation } from "../app/router";
import { useScannerLive } from "../app/useScannerLive";
import { ManageController, type BoothView, type ManageSnapshot } from "./manage-model";

export interface LiveManage {
  live: boolean;
  loading: boolean;
  error?: string;
  snap?: ManageSnapshot;
  resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void>;
  authorizeBooth(code: string): Promise<BoothView>;
  reload(): void;
}

const RESOLVED_LABEL: Record<'OK' | 'SUSPECT' | 'UNDETERMINED', string> = { OK: '정상', SUSPECT: '부적정', UNDETERMINED: '판단 불가' };

/**
 * `?live=1`일 때만 ManageController를 만든다. shift(회차·기기·역할)가 준비되면 한 번 load하고,
 * 화면이 끝난 상태(403·409·오프라인·오류)에서는 다시 부르지 않는다(manage-model의 terminal).
 */
export function useLiveManage(): LiveManage {
  const { search } = useLocation();
  const live = liveRequested(search);
  const scanner = useScannerLive(search);
  const [snap, setSnap] = useState<ManageSnapshot | undefined>();
  const [controller, setController] = useState<ManageController | undefined>();
  const [version, setVersion] = useState(0);
  const cancelled = useRef(false);
  const shift = scanner.shift;
  const eventId = shift?.eventId;
  const deviceId = shift?.device.deviceId;
  const role = shift?.role;

  useEffect(() => {
    if (!live || !eventId || !deviceId || !role) return;
    const api = liveRuntime.manageApi();
    if (!api) return;
    cancelled.current = false;
    const c = new ManageController({ api, eventId, role, deviceId, online: () => navigator.onLine });
    setController(c);
    void c.load().then((s) => {
      if (!cancelled.current) setSnap(s);
    });
    return () => {
      cancelled.current = true;
    };
  }, [live, eventId, deviceId, role, version]);

  const resolveFlag = useCallback(
    async (flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string) => {
      if (!controller) throw new Error('현장 관리 연결이 아직 준비되지 않았습니다');
      await controller.resolveFlag(flagId, status, note);
      setSnap((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              flags: prev.flags.map((f) => (f.flagId === flagId ? { ...f, resolved: true, statusLabel: RESOLVED_LABEL[status] } : f)),
            },
      );
    },
    [controller],
  );

  const authorizeBooth = useCallback(
    async (code: string) => {
      if (!controller) return { kind: 'error' as const };
      return controller.authorizeBooth(code);
    },
    [controller],
  );

  const reload = useCallback(() => {
    setSnap(undefined);
    setController(undefined);
    setVersion((v) => v + 1);
  }, []);

  const error = live && scanner.mode === "error" && snap === undefined ? (scanner.error ?? "실시간 연결에 닿지 못했습니다") : undefined;
  const loading = live && snap === undefined && error === undefined;
  return useMemo(
    () => ({ live, loading, ...(error ? { error } : {}), ...(snap ? { snap } : {}), resolveFlag, authorizeBooth, reload }),
    [live, loading, error, snap, resolveFlag, authorizeBooth, reload],
  );
}

/** 실제 API 배너(화면 위 한 줄). 화면 상태는 ManageScreen이 본문으로 그린다 */
export function LiveManageBridge({ state, error, counts }: { state?: string; error?: string; counts?: string }) {
  if (state === undefined) return null;
  return (
    <div className="banner" role="status" style={{ marginBottom: 8 }}>
      <div className="banner-body t-sm">
        <span className="banner-title">실제 API</span>
        {counts ?? `상태: ${state}${error ? ` (${error})` : ""}`}
      </div>
    </div>
  );
}
