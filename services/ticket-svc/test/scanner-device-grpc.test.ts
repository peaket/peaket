// ScannerDeviceService gRPC 서버(BAT-450 GAT-220 잔여): ops-svc 이관 경계의 request_id 멱등·오류 사상·SESSION_TERMINATED.
import { fakeClock } from '@peaket/platform';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceCommandStore, MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { scannerDeviceHandlers } from '../src/modules/scanner/inbound/scanner-device.grpc.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000004';
const REQUEST = '0190f3a1-7c2e-7a00-8000-000000000005';

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryScannerDeviceStore();
  const gate = new MemoryScannerGateStore();
  const shift = new MemoryScannerShiftStore(gate);
  const commands = new MemoryScannerDeviceCommandStore();
  const devices = new ScannerDevices({ store, codes: new MemoryEnrollmentCodeStore(clock), clock, commands, shifts: shift, newId: () => DEVICE });
  const errors: string[] = [];
  const handlers = scannerDeviceHandlers(devices, (method, err) => errors.push(`${method}:${String(err)}`));
  const call = <T>(method: string, request: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const h = handlers[method] as (c: unknown, cb: (e: unknown, v?: unknown) => void) => void;
      h({ request } as unknown, (e, v) => (e ? reject(e) : resolve(v as T)));
    });
  return { clock, store, gate, shift, commands, devices, handlers, call, errors };
}

describe('ScannerDeviceService gRPC [BAT-450]', () => {
  test('등록은 기기와 1회용 코드를 주고, 같은 request_id 재시도는 already_done=true로 코드를 다시 만들지 않는다', async () => {
    const w = world();
    const first = await w.call<{ device: Record<string, unknown>; enrollment_code: { code: string; expires_at: { seconds: number } }; already_done: boolean }>('RegisterScannerDevice', {
      request_id: REQUEST,
      name: '동문-03',
      promoter_id: PROMOTER,
      acted_by: ADMIN,
    });
    expect(first.device).toMatchObject({ device_id: DEVICE, name: '동문-03', promoter_id: PROMOTER, status: 'SCANNER_DEVICE_STATUS_ACTIVE', credential_type: 'SCANNER_CREDENTIAL_TYPE_DEVICE_KEY' });
    expect(first.enrollment_code.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(first.enrollment_code.expires_at.seconds).toBe(Math.floor((NOW + 600_000) / 1000));
    expect(first.already_done).toBe(false);

    const retry = await w.call<{ enrollment_code?: unknown; already_done: boolean }>('RegisterScannerDevice', {
      request_id: REQUEST,
      name: '다른 이름',
      promoter_id: PROMOTER,
      acted_by: ADMIN,
    });
    expect(retry.already_done).toBe(true);
    expect(retry.enrollment_code).toBeUndefined();
    expect(await w.store.list({ limit: 10 })).toMatchObject({ devices: [{ name: '동문-03' }] });
  });

  test('같은 request_id를 다른 명령에 다시 쓰면 INVALID_ARGUMENT다', async () => {
    const w = world();
    await w.call('RegisterScannerDevice', { request_id: REQUEST, name: '동문-03', promoter_id: PROMOTER, acted_by: ADMIN });
    await expect(w.call('RevokeScannerDevice', { request_id: REQUEST, device_id: DEVICE, reason: '분실', acted_by: ADMIN })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  test('목록·폐기·등록 코드 재발급이 proto 모양으로 답하고, 없는 기기는 NOT_FOUND다', async () => {
    const w = world();
    await w.call('RegisterScannerDevice', { request_id: REQUEST, name: '동문-03', promoter_id: PROMOTER, acted_by: ADMIN });
    const page = await w.call<{ devices: Record<string, unknown>[]; next_cursor?: string }>('ListScannerDevices', { limit: 10 });
    expect(page.devices).toHaveLength(1);
    expect(page.next_cursor).toBeUndefined();

    const reissued = await w.call<{ enrollment_code: { code: string }; already_done: boolean }>('ReissueEnrollmentCode', {
      request_id: '0190f3a1-7c2e-7a00-8000-000000000006',
      device_id: DEVICE,
      acted_by: ADMIN,
    });
    expect(reissued.already_done).toBe(false);
    expect(reissued.enrollment_code.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-/);

    const revoked = await w.call<{ device: Record<string, unknown> }>('RevokeScannerDevice', {
      request_id: '0190f3a1-7c2e-7a00-8000-000000000007',
      device_id: DEVICE,
      reason: '분실',
      acted_by: ADMIN,
    });
    expect(revoked.device.status).toBe('SCANNER_DEVICE_STATUS_REVOKED');

    await expect(w.call('RevokeScannerDevice', { request_id: '0190f3a1-7c2e-7a00-8000-000000000008', device_id: '0190f3a1-7c2e-7a00-8000-000000000099', reason: 'x', acted_by: ADMIN })).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
    await expect(w.call('ReissueEnrollmentCode', { request_id: '0190f3a1-7c2e-7a00-8000-000000000009', device_id: DEVICE, acted_by: ADMIN })).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  });

  test('기기 폐기는 배치된 회차마다 SESSION_TERMINATED 변경분을 남긴다', async () => {
    const w = world();
    await w.call('RegisterScannerDevice', { request_id: REQUEST, name: '동문-03', promoter_id: PROMOTER, acted_by: ADMIN });
    await w.shift.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: 'A', mode: 'IN', setBy: ADMIN, atMs: NOW, expectedVersion: 0 });
    await w.call('RevokeScannerDevice', { request_id: '0190f3a1-7c2e-7a00-8000-000000000007', device_id: DEVICE, reason: '분실', acted_by: ADMIN });
    const changes = await w.gate.changes({ eventId: EVENT, after: 0, limit: 100, nowMs: NOW });
    expect(changes.changes.map((c) => c.kind)).toContain('SESSION_TERMINATED');
    expect(changes.changes.find((c) => c.kind === 'SESSION_TERMINATED')!.payload).toEqual({ v: 1, deviceId: DEVICE, reason: 'DEVICE_REVOKED' });
  });
});
