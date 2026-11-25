// SCR-052 실제 API 연결(TR-01). `?live=1`이면 manage-model의 ManageController로 기기·이상 표시·내 예외 통과를 읽는다.
// 퍼블리싱 미리보기에서는 아무것도 부르지 않는다.
import { useEffect, useState } from "react";
import { liveRequested } from "../api/config";
import { useLocation } from "../app/router";
import { liveRuntime } from "../app/live-runtime";
import { ManageController, type ManageSnapshot } from "./manage-model";

export function LiveManageBridge() {
  const { search } = useLocation();
  const [snap, setSnap] = useState<ManageSnapshot | undefined>();
  const live = liveRequested(search);

  useEffect(() => {
    if (!live) return;
    const shift = liveRuntime.snapshot().shift;
    const api = liveRuntime.manageApi();
    if (!shift || !api) return;
    let cancelled = false;
    const controller = new ManageController({
      api,
      eventId: shift.eventId,
      role: shift.role,
      deviceId: shift.device.deviceId,
      online: () => navigator.onLine,
    });
    void controller.load().then((s) => {
      if (!cancelled) setSnap(s);
    });
    return () => {
      cancelled = true;
    };
  }, [live, search]);

  if (!live || !snap) return null;
  return (
    <div className="banner" role="status" style={{ marginBottom: 8 }}>
      <div className="banner-body t-sm">
        <span className="banner-title">실제 API</span>
        {snap.state === "ready"
          ? `기기 ${snap.devices.length} · 이상 표시 ${snap.flags.length} · 내 예외 통과 ${snap.overrides.length}`
          : `상태: ${snap.state}${snap.error ? ` (${snap.error})` : ""}`}
      </div>
    </div>
  );
}
