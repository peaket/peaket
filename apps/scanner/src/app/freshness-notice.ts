// 현장 책임자 신선도 배너(O-T20, offline-gate §7.2). React를 모르는 순수 모듈이다.
export interface StaleDeviceView {
  deviceId: string;
  deviceName: string;
  gateZone: string;
  lastChangesAt: string;
  ageMs: number;
  thresholdMs: number;
}

export interface FreshnessBanner {
  deviceId: string;
  title: string;
  detail: string;
}

/** 경계(정확히 2분)는 아직 신선하다 */
export function isFreshnessStale(i: { lastChangesAtMs: number; nowMs: number; thresholdMs?: number }): boolean {
  const threshold = i.thresholdMs ?? 120_000;
  const age = i.nowMs - i.lastChangesAtMs;
  if (!Number.isFinite(age)) return false;
  return age > threshold;
}

/**
 * gate_lead에게만, 배치 구역과 같은 구역의 지연 기기만 배너로 만든다.
 * 서버가 다른 구역을 섞어 보내도 화면에서 한 번 더 거른다.
 */
export function freshnessBannersOf(i: {
  role?: 'gate_staff' | 'gate_lead';
  placementZone?: string;
  staleDevices?: readonly StaleDeviceView[];
}): FreshnessBanner[] {
  if (i.role !== 'gate_lead') return [];
  const zone = i.placementZone;
  if (!zone) return [];
  return (i.staleDevices ?? [])
    .filter((d) => d.gateZone === zone)
    .map((d) => {
      const minutes = Math.max(2, Math.floor(d.ageMs / 60_000));
      return {
        deviceId: d.deviceId,
        title: `${d.deviceName} 동기화 2분 넘음`,
        detail: `${minutes}분 넘게 변경분을 받지 못했습니다`,
      };
    });
}
