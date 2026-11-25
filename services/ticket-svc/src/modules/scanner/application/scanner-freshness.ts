// 스캐너 변경분 신선도 감시(O-T20, offline-gate §6.3·§12). 입장 시간대에 스캐너가 2분 넘게 변경분을 받지 못하면
// ops-svc의 기존 ops_alert 경로로 SEV2를 남기고, 다시 동기화하면 푼다. 스캐너의 오프라인 판정은 막지 않는다.
// 기준 시각은 마지막 변경분 수신 시각(scanner_device.last_changes_at)이다. 한 번도 받은 적 없는 기기는 경보하지 않는다.
import type { Clock } from '@peaket/platform';
import type { ScannerFreshnessDeviceView } from '../domain/scanner-gate.js';
import type { ScannerDeviceStore, ScannerEventPolicy, ScannerEventPolicyProvider, ScannerFreshnessAlert, ScannerFreshnessAlertSink, ScannerFreshnessResolution, ScannerShiftStore } from '../domain/ports.js';

export type { ScannerFreshnessAlert, ScannerFreshnessAlertSink, ScannerFreshnessResolution } from '../domain/ports.js';
export type { ScannerFreshnessDeviceView } from '../domain/scanner-gate.js';

/** 2분 [정본 offline-gate O-T20]. 경계(정확히 2분)는 아직 신선하다 */
export const SCANNER_FRESHNESS_ALERT_MS = 2 * 60_000;

export interface ScannerFreshnessDeps {
  devices: Pick<ScannerDeviceStore, 'findById'>;
  shifts: Pick<ScannerShiftStore, 'eventsWithPlacements' | 'placementsOf'>;
  policy?: ScannerEventPolicyProvider;
  sink: ScannerFreshnessAlertSink;
  clock: Clock;
  log?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
  /** 지표를 올리는 곳(선택). result: open·resolve·error */
  metric?: (result: 'open' | 'resolve' | 'error', eventId: string, deviceId: string) => void;
}

export interface ScannerFreshnessReport {
  checkedEvents: number;
  checkedDevices: number;
  opened: number;
  resolved: number;
  failed: number;
}

/** 입장 시간대인가. core-svc 정책에 입장 시작이 없으면 '모른다'로 보고 경보하지 않는다 */
export function inEntryWindow(policy: ScannerEventPolicy | undefined, nowMs: number): boolean {
  if (!policy || policy.entryOpensAtMs === undefined) return false;
  if (nowMs < policy.entryOpensAtMs) return false;
  if (policy.entryClosesAtMs !== undefined && nowMs > policy.entryClosesAtMs) return false;
  return true;
}

export function freshnessAlertKind(deviceId: string): string {
  return `scanner-freshness:${deviceId}`;
}

/**
 * 현장 책임자 변경분에 실을 같은 구역 지연 기기(offline-gate §7.2).
 * 같은 회차·같은 배치 구역·입장 창 안에서 2분을 넘긴 ACTIVE 기기만, 자기 기기는 뺀다.
 * 구역을 모르면 아무것도 싣지 않는다.
 */
export function staleDevicesOf(i: {
  placements: readonly { deviceId: string; gateZone: string }[];
  devices: ReadonlyMap<string, { name: string; status: string; lastChangesAtMs?: number }>;
  policy: { entryOpensAtMs?: number; entryClosesAtMs?: number } | undefined;
  nowMs: number;
  gateZone?: string;
  selfDeviceId?: string;
}): ScannerFreshnessDeviceView[] {
  if (!i.gateZone) return [];
  const policy = i.policy;
  const inWindow =
    policy !== undefined &&
    policy.entryOpensAtMs !== undefined &&
    i.nowMs >= policy.entryOpensAtMs &&
    (policy.entryClosesAtMs === undefined || i.nowMs <= policy.entryClosesAtMs);
  if (!inWindow) return [];
  const out: ScannerFreshnessDeviceView[] = [];
  for (const placement of i.placements) {
    if (placement.gateZone !== i.gateZone) continue;
    if (placement.deviceId === i.selfDeviceId) continue;
    const device = i.devices.get(placement.deviceId);
    if (!device || device.status !== 'ACTIVE' || device.lastChangesAtMs === undefined) continue;
    const ageMs = i.nowMs - device.lastChangesAtMs;
    if (ageMs <= SCANNER_FRESHNESS_ALERT_MS) continue;
    out.push({
      deviceId: placement.deviceId,
      deviceName: device.name,
      gateZone: placement.gateZone,
      lastChangesAt: new Date(device.lastChangesAtMs).toISOString(),
      ageMs,
      thresholdMs: SCANNER_FRESHNESS_ALERT_MS,
    });
  }
  return out;
}

export class ScannerFreshness {
  /** 지금 경보가 열려 있다고 아는 (eventId/deviceId) */
  readonly #open = new Set<string>();

  constructor(private readonly d: ScannerFreshnessDeps) {}

  /** 현장 책임자 변경분에 실을 같은 구역 지연 기기. 계산 실패는 빈 목록(변경분 응답을 막지 않는다) */
  async staleDevices(i: { eventId: string; gateZone?: string; selfDeviceId?: string; nowMs: number }): Promise<ScannerFreshnessDeviceView[]> {
    try {
      const placements = await this.d.shifts.placementsOf(i.eventId);
      let policy: ScannerEventPolicy | undefined;
      try {
        policy = await this.d.policy?.get(i.eventId);
      } catch {
        policy = undefined;
      }
      const devices = new Map<string, { name: string; status: string; lastChangesAtMs?: number }>();
      for (const placement of placements) {
        try {
          const device = await this.d.devices.findById(placement.deviceId);
          if (device) devices.set(placement.deviceId, { name: device.name, status: device.status, ...(device.lastChangesAtMs !== undefined ? { lastChangesAtMs: device.lastChangesAtMs } : {}) });
        } catch {
          // 한 기기를 읽지 못해도 나머지 목록은 만든다
        }
      }
      return staleDevicesOf({
        placements,
        devices,
        policy,
        nowMs: i.nowMs,
        ...(i.gateZone !== undefined ? { gateZone: i.gateZone } : {}),
        ...(i.selfDeviceId !== undefined ? { selfDeviceId: i.selfDeviceId } : {}),
      });
    } catch {
      return [];
    }
  }

  async run(): Promise<ScannerFreshnessReport> {
    const now = this.d.clock.now();
    const report: ScannerFreshnessReport = { checkedEvents: 0, checkedDevices: 0, opened: 0, resolved: 0, failed: 0 };
    const events = await this.d.shifts.eventsWithPlacements();
    for (const eventId of events) {
      report.checkedEvents += 1;
      let policy: ScannerEventPolicy | undefined;
      try {
        policy = await this.d.policy?.get(eventId);
      } catch {
        policy = undefined;
      }
      const openWindow = inEntryWindow(policy, now);
      const placements = await this.d.shifts.placementsOf(eventId);
      for (const placement of placements) {
        report.checkedDevices += 1;
        const key = `${eventId}/${placement.deviceId}`;
        const device = await this.d.devices.findById(placement.deviceId);
        const last = device?.lastChangesAtMs;
        const stale = openWindow && device?.status === 'ACTIVE' && last !== undefined && now - last > SCANNER_FRESHNESS_ALERT_MS;
        if (!stale) {
          if (this.#open.has(key)) {
            try {
              await this.d.sink.resolve({ eventKey: eventId, kind: freshnessAlertKind(placement.deviceId), reason: '스캐너가 다시 변경분을 받았다', atMs: now });
              this.#open.delete(key);
              report.resolved += 1;
              this.d.metric?.('resolve', eventId, placement.deviceId);
              this.d.log?.info?.({ eventId, deviceId: placement.deviceId, kind: 'scanner-freshness' }, '스캐너 변경분 신선도 경보를 풀었다');
            } catch (err) {
              report.failed += 1;
              this.d.metric?.('error', eventId, placement.deviceId);
              this.d.log?.warn({ eventId, deviceId: placement.deviceId, err: messageOf(err) }, '스캐너 신선도 경보 해제에 실패했다(다음에 다시 한다)');
            }
          }
          continue;
        }
        if (this.#open.has(key)) continue;
        const ageMs = now - last!;
        try {
          await this.d.sink.open({
            eventKey: eventId,
            kind: freshnessAlertKind(placement.deviceId),
            severity: 'SEV2',
            source: 'ticket-svc',
            reason: '스캐너가 2분 넘게 변경분을 받지 못했다',
            detail: {
              deviceId: placement.deviceId,
              deviceName: device?.name ?? '',
              lastChangesAt: new Date(last!).toISOString(),
              ageMs,
              thresholdMs: SCANNER_FRESHNESS_ALERT_MS,
              gateZone: placement.gateZone,
              mode: placement.mode,
            },
            atMs: now,
          });
          this.#open.add(key);
          report.opened += 1;
          this.d.metric?.('open', eventId, placement.deviceId);
          this.d.log?.warn({ eventId, deviceId: placement.deviceId, ageMs, kind: 'scanner-freshness', severity: 'SEV2' }, '스캐너 변경분 신선도 경보(SEV2)');
        } catch (err) {
          report.failed += 1;
          this.d.metric?.('error', eventId, placement.deviceId);
          this.d.log?.warn({ eventId, deviceId: placement.deviceId, err: messageOf(err) }, '스캐너 신선도 경보를 남기지 못했다(다음에 다시 한다)');
        }
      }
    }
    return report;
  }

  /** 지금 열려 있다고 아는 경보 수(지표 gauge) */
  openAlerts(): number {
    return this.#open.size;
  }

  /** 시험·재시작용. 다음 run이 다시 경보를 열 수 있게 한다 */
  reset(): void {
    this.#open.clear();
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
