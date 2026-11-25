// F-05-10 현장 책임자 신선도 알림(서버) 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/features/offline-gate.md §7.2 '현장 책임자 신선도 알림', O-T20(입장 창, 2분 [정본], 경계는 아직 신선).
// 새 함수는 동적으로 읽어 '함수가 없다' 단언에서 떨어진다. DB는 쓰지 않고 순수 계산·응용 경계를 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { ScannerGate } from '../src/modules/scanner/application/scanner-gate.js';

type Device = { name: string; status: string; lastChangesAtMs?: number };
type Placement = { deviceId: string; gateZone: string };
type Policy = { entryOpensAtMs?: number; entryClosesAtMs?: number };
type StaleDevice = { deviceId: string; deviceName: string; gateZone: string; lastChangesAt: string; ageMs: number; thresholdMs: number };
type FreshnessModule = {
  staleDevicesOf(i: {
    placements: readonly Placement[];
    devices: ReadonlyMap<string, Device>;
    policy: Policy | undefined;
    nowMs: number;
    gateZone?: string;
    selfDeviceId?: string;
  }): StaleDevice[];
};

const NOW = Date.parse('2026-11-26T10:00:00Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5481';
const SELF = '0190f3a1-7c2e-7a00-8000-0000000f5490';
const D1 = '0190f3a1-7c2e-7a00-8000-0000000f5491';
const D2 = '0190f3a1-7c2e-7a00-8000-0000000f5492';
const D3 = '0190f3a1-7c2e-7a00-8000-0000000f5493';
const OPEN = { entryOpensAtMs: NOW - 3_600_000, entryClosesAtMs: NOW + 3_600_000 };

const freshnessLoaded = (await import('../src/modules/scanner/application/scanner-freshness.js').catch(() => ({}))) as Partial<FreshnessModule>;
function fresh(): FreshnessModule {
  expect(typeof freshnessLoaded.staleDevicesOf, 'scanner-freshness.ts의 staleDevicesOf가 없다').toBe('function');
  return freshnessLoaded as FreshnessModule;
}
/** 구현 전 트리에는 changes의 6번째 인자와 staleDevices 칸이 없다. 시험은 구현 모양을 느슨하게 불러 실패를 단언한다 */
type GateLike = { changes(...args: unknown[]): Promise<{ changes: unknown[]; lastSeq: number; staleDevices?: StaleDevice[] }> };
const Gate = ScannerGate as unknown as new (d: unknown) => GateLike;
type MonitorLike = { staleDevices(i: { eventId: string; gateZone?: string; selfDeviceId?: string; nowMs: number }): Promise<StaleDevice[]> };
const Monitor = (await import('../src/modules/scanner/application/scanner-freshness.js').catch(() => ({}))) as {
  ScannerFreshness?: new (d: unknown) => MonitorLike;
};

const placements: Placement[] = [
  { deviceId: D1, gateZone: '동문' },
  { deviceId: D2, gateZone: '동문' },
  { deviceId: D3, gateZone: '서문' },
];
const devices = new Map<string, Device>([
  [D1, { name: '동문-03', status: 'ACTIVE', lastChangesAtMs: NOW - 180_001 }],
  [D2, { name: '동문-04', status: 'ACTIVE', lastChangesAtMs: NOW - 60_000 }],
  [D3, { name: '서문-01', status: 'ACTIVE', lastChangesAtMs: NOW - 180_001 }],
]);

describe('O-T20 현장 책임자 신선도(서버)', () => {
  test('O-T20 현장 책임자 변경분은 같은 구역에서 2분 넘게 동기화하지 못한 기기만 알린다', () => {
    const rows = fresh().staleDevicesOf({ placements, devices, policy: OPEN, nowMs: NOW, gateZone: '동문', selfDeviceId: SELF });
    expect(rows).toEqual([
      {
        deviceId: D1,
        deviceName: '동문-03',
        gateZone: '동문',
        lastChangesAt: new Date(NOW - 180_001).toISOString(),
        ageMs: 180_001,
        thresholdMs: 120_000,
      },
    ]);
  });

  test('O-T20 현장 책임자는 폐기·한 번도 받지 않은·다른 구역 기기와 입장 시간 밖을 알리지 않는다', () => {
    const f = fresh();
    expect(f.staleDevicesOf({ placements, devices, policy: OPEN, nowMs: NOW, gateZone: '동문' })).toHaveLength(1);

    // 경계: 정확히 2분은 아직 신선하다
    const boundary = new Map(devices);
    boundary.set(D1, { name: '동문-03', status: 'ACTIVE', lastChangesAtMs: NOW - 120_000 });
    expect(f.staleDevicesOf({ placements, devices: boundary, policy: OPEN, nowMs: NOW, gateZone: '동문', selfDeviceId: SELF })).toEqual([]);
    boundary.set(D1, { name: '동문-03', status: 'ACTIVE', lastChangesAtMs: NOW - 120_001 });
    expect(f.staleDevicesOf({ placements, devices: boundary, policy: OPEN, nowMs: NOW, gateZone: '동문', selfDeviceId: SELF })).toHaveLength(1);

    // 입장 시간 밖·정책 없음
    expect(f.staleDevicesOf({ placements, devices, policy: { entryOpensAtMs: NOW - 7_200_000, entryClosesAtMs: NOW - 3_600_000 }, nowMs: NOW, gateZone: '동문' })).toEqual([]);
    expect(f.staleDevicesOf({ placements, devices, policy: undefined, nowMs: NOW, gateZone: '동문' })).toEqual([]);
    expect(f.staleDevicesOf({ placements, devices, policy: { entryClosesAtMs: NOW + 1 }, nowMs: NOW, gateZone: '동문' })).toEqual([]);

    // 폐기·한 번도 받지 않은 기기
    const revoked = new Map(devices);
    revoked.set(D1, { name: '동문-03', status: 'REVOKED', lastChangesAtMs: NOW - 180_001 });
    expect(f.staleDevicesOf({ placements, devices: revoked, policy: OPEN, nowMs: NOW, gateZone: '동문' })).toEqual([]);
    const never = new Map(devices);
    never.set(D1, { name: '동문-03', status: 'ACTIVE' });
    expect(f.staleDevicesOf({ placements, devices: never, policy: OPEN, nowMs: NOW, gateZone: '동문' })).toEqual([]);

    // 자기 기기·구역 없음·다른 구역
    expect(f.staleDevicesOf({ placements, devices, policy: OPEN, nowMs: NOW, gateZone: '동문', selfDeviceId: D1 })).toEqual([]);
    expect(f.staleDevicesOf({ placements, devices, policy: OPEN, nowMs: NOW })).toEqual([]);
    expect(f.staleDevicesOf({ placements, devices, policy: OPEN, nowMs: NOW, gateZone: '서문', selfDeviceId: SELF })).toEqual([
      expect.objectContaining({ deviceId: D3, gateZone: '서문' }),
    ]);
  });

  test('O-T20 신선도 감시는 기존 포트에서 같은 구역 지연 기기를 모아 현장 책임자 알림에 쓴다', async () => {
    expect(typeof Monitor.ScannerFreshness, 'ScannerFreshness.staleDevices가 없다').toBe('function');
    const monitor = new Monitor.ScannerFreshness!({
      devices: { findById: async (deviceId: string) => devices.get(deviceId) },
      shifts: { eventsWithPlacements: async () => [EVENT], placementsOf: async () => placements },
      policy: { get: async () => ({ ...OPEN, promoterId: 'p-1', reentryAllowed: false }) },
      sink: { open: async () => undefined, resolve: async () => undefined },
      clock: fakeClock({ now: NOW }),
    });
    const rows = await monitor.staleDevices({ eventId: EVENT, gateZone: '동문', selfDeviceId: SELF, nowMs: NOW });
    expect(rows).toEqual([expect.objectContaining({ deviceId: D1, deviceName: '동문-03', gateZone: '동문', ageMs: 180_001 })]);
    expect(await monitor.staleDevices({ eventId: EVENT, gateZone: '서문', selfDeviceId: SELF, nowMs: NOW })).toEqual([
      expect.objectContaining({ deviceId: D3, gateZone: '서문' }),
    ]);
    expect(await monitor.staleDevices({ eventId: EVENT, gateZone: '동문', selfDeviceId: SELF, nowMs: NOW + 7_200_000 })).toEqual([]);
  });

  test('O-T20 현장 책임자 변경분에만 같은 구역 지연 기기를 싣고 일반 스태프 응답에는 싣지 않는다', async () => {
    const store = new MemoryScannerGateStore();
    const clock = fakeClock({ now: NOW });
    const calls: unknown[] = [];
    const row: StaleDevice = {
      deviceId: D1,
      deviceName: '동문-03',
      gateZone: '동문',
      lastChangesAt: new Date(NOW - 180_000).toISOString(),
      ageMs: 180_000,
      thresholdMs: 120_000,
    };
    const gate = new Gate({
      store,
      clock,
      shifts: {
        placementOf: async () => ({ eventId: EVENT, deviceId: SELF, gateZone: '동문', mode: 'IN', setBy: 'admin', setAtMs: NOW, version: 1 }),
      },
      freshness: {
        staleDevices: async (i: { eventId: string; gateZone?: string; selfDeviceId?: string; nowMs: number }) => {
          calls.push(i);
          return [row];
        },
      },
    } as never);

    const lead = await gate.changes(EVENT, 0, 100, EVENT, SELF, 'gate_lead');
    expect(lead.staleDevices).toEqual([row]);
    expect(calls).toEqual([{ eventId: EVENT, gateZone: '동문', selfDeviceId: SELF, nowMs: NOW }]);

    const staff = await gate.changes(EVENT, 0, 100, EVENT, SELF, 'gate_staff');
    expect('staleDevices' in staff).toBe(false);
    expect(calls).toHaveLength(1);

    const deviceOnly = await gate.changes(EVENT, 0, 100, EVENT, SELF);
    expect('staleDevices' in deviceOnly).toBe(false);
  });

  test('O-T20 신선도 계산이 실패해도 변경분 응답은 실패하지 않고 알림만 빈다', async () => {
    const store = new MemoryScannerGateStore();
    const gate = new Gate({
      store,
      clock: fakeClock({ now: NOW }),
      shifts: {
        placementOf: async () => ({ eventId: EVENT, deviceId: SELF, gateZone: '동문', mode: 'IN', setBy: 'admin', setAtMs: NOW, version: 1 }),
      },
      freshness: {
        staleDevices: async () => {
          throw new Error('DB 오류');
        },
      },
    } as never);
    const page = await gate.changes(EVENT, 0, 100, EVENT, SELF, 'gate_lead');
    expect(page.changes).toEqual([]);
    expect(page.lastSeq).toBe(0);
    expect('staleDevices' in page).toBe(false);
  });
});
