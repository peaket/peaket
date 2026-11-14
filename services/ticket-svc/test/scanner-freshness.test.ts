// O-T20 스캐너 변경분 신선도 경보: 입장 시간대에 2분을 넘기면 SEV2를 열고, 다시 받으면 푼다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { inEntryWindow, SCANNER_FRESHNESS_ALERT_MS, ScannerFreshness, type ScannerFreshnessAlert, type ScannerFreshnessResolution } from '../src/modules/scanner/application/scanner-freshness.js';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';

async function world(lastChangesAtMs: number | undefined, entry = { opens: NOW - 3600_000, closes: NOW + 3600_000 }) {
  const clock = fakeClock({ now: NOW });
  const devices = new MemoryScannerDeviceStore();
  const gate = new MemoryScannerGateStore();
  const shifts = new MemoryScannerShiftStore(gate);
  await devices.register({ deviceId: DEVICE, name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW - 10 * 3600_000 });
  if (lastChangesAtMs !== undefined) await devices.touchChanges(DEVICE, lastChangesAtMs);
  await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: 'A', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
  const alerts: ScannerFreshnessAlert[] = [];
  const resolutions: ScannerFreshnessResolution[] = [];
  const monitor = new ScannerFreshness({
    devices,
    shifts,
    policy: { get: async () => ({ promoterId: PROMOTER, reentryAllowed: false, entryOpensAtMs: entry.opens, entryClosesAtMs: entry.closes }) },
    sink: { open: async (a) => void alerts.push(a), resolve: async (r) => void resolutions.push(r) },
    clock,
  });
  return { clock, devices, shifts, alerts, resolutions, monitor };
}

describe('O-T20 스캐너 신선도 [BAT-450]', () => {
  test('O-T20_입장_창은_시작_전·안·끝_뒤를_가른다', () => {
    const p = { promoterId: PROMOTER, reentryAllowed: false, entryOpensAtMs: NOW, entryClosesAtMs: NOW + 1000 };
    expect(inEntryWindow(p, NOW - 1)).toBe(false);
    expect(inEntryWindow(p, NOW)).toBe(true);
    expect(inEntryWindow(p, NOW + 1000)).toBe(true);
    expect(inEntryWindow(p, NOW + 1001)).toBe(false);
    expect(inEntryWindow({ promoterId: PROMOTER, reentryAllowed: false }, NOW)).toBe(false);
    expect(inEntryWindow(undefined, NOW)).toBe(false);
  });

  test('O-T20_2분_경계까지는_조용하고_넘으면_SEV2를_한_번만_열며_다시_받으면_푼다', async () => {
    const w = await world(NOW - SCANNER_FRESHNESS_ALERT_MS);
    expect(await w.monitor.run()).toMatchObject({ checkedEvents: 1, checkedDevices: 1, opened: 0, resolved: 0 });
    expect(w.alerts).toHaveLength(0);

    w.clock.advance(1);
    expect(await w.monitor.run()).toMatchObject({ opened: 1 });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({
      eventKey: EVENT,
      kind: `scanner-freshness:${DEVICE}`,
      severity: 'SEV2',
      source: 'ticket-svc',
      reason: '스캐너가 2분 넘게 변경분을 받지 못했다',
      detail: { deviceId: DEVICE, ageMs: SCANNER_FRESHNESS_ALERT_MS + 1, thresholdMs: SCANNER_FRESHNESS_ALERT_MS },
    });
    expect(w.monitor.openAlerts()).toBe(1);

    w.clock.advance(30_000);
    expect(await w.monitor.run()).toMatchObject({ opened: 0 });
    expect(w.alerts).toHaveLength(1);

    await w.devices.touchChanges(DEVICE, w.clock.now());
    expect(await w.monitor.run()).toMatchObject({ resolved: 1 });
    expect(w.resolutions).toEqual([{ eventKey: EVENT, kind: `scanner-freshness:${DEVICE}`, reason: '스캐너가 다시 변경분을 받았다', atMs: NOW + 30_001 }]);
    expect(w.monitor.openAlerts()).toBe(0);
  });

  test('O-T20_입장_시간대가_아니거나_한_번도_받은_적_없거나_폐기된_기기는_경보하지_않는다', async () => {
    const closed = await world(NOW - 3 * 60_000, { opens: NOW - 2 * 3600_000, closes: NOW - 3600_000 });
    expect(await closed.monitor.run()).toMatchObject({ opened: 0, failed: 0 });
    expect(closed.alerts).toHaveLength(0);

    const never = await world(undefined);
    expect(await never.monitor.run()).toMatchObject({ opened: 0, failed: 0 });
    expect(never.alerts).toHaveLength(0);

    const revoked = await world(NOW - 3 * 60_000);
    await revoked.devices.revoke({ deviceId: DEVICE, reason: '분실', atMs: NOW });
    expect(await revoked.monitor.run()).toMatchObject({ opened: 0, failed: 0 });
    expect(revoked.alerts).toHaveLength(0);
  });
});
