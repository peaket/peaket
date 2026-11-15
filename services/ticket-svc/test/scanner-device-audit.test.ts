// R-622 독립 회귀 시험: C1-13 등록 전체 실패 SEV3와 M5-07 jkt 모양 계약.
// M5V 보고서(§4)는 jkt 시험이 어댑터의 별도 정규식만 보고 도메인 assertJkt를 지나친다고 지적했다.
// 여기서는 ① 도메인 함수 ② 등록 경로 ③ 기기 저장소가 같은 검증을 쓰는지를 모두 고정한다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { EnrollmentCodeRejected, ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { assertJkt, ScannerDeviceInputError } from '../src/modules/scanner/domain/scanner-device.js';
import type { ScannerOpsAlert } from '../src/modules/scanner/domain/ports.js';

vi.mock('../src/modules/scanner/domain/scanner-device.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/scanner/domain/scanner-device.js')>();
  return { ...actual, assertJkt: vi.fn(actual.assertJkt) };
});

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const JKT = 'A'.repeat(43);

describe('R-622 C1-13 등록 전체 실패 SEV3는 ops_alert 경로로 간다', () => {
  test('10분 100회 경계를 넘으면 ops-svc ops_alert(SEV3)로 보내고 logger.warn 대체 경로는 쓰지 않는다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const alerts: ScannerOpsAlert[] = [];
    const fallback: { message: string; fields: Record<string, unknown> }[] = [];
    const devices = new ScannerDevices({
      store,
      codes,
      clock,
      limiter: { allowed: async () => true, failed: async () => ({ globalAlert: true, globalFailures: 101 }) },
      opsAlert: { open: async (alert) => void alerts.push(alert) },
      alert: (message, fields) => void fallback.push({ message, fields }),
    });
    await expect(devices.enroll({ code: 'WRONG-CODE', jkt: JKT })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
    expect(alerts).toEqual([
      expect.objectContaining({
        eventKey: 'scanner-enrollment',
        kind: 'ENROLLMENT_GLOBAL_FAILURES',
        severity: 'SEV3',
        source: 'ticket-svc',
        detail: { failures: 101 },
        atMs: NOW,
      }),
    ]);
    expect(fallback).toEqual([]);
  });

  test('ops_alert 전송이 실패해도 등록 거절은 그대로이고 logger.warn 대체 경로에 실패를 남긴다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const open = vi.fn(async () => {
      throw new Error('ops-svc 503');
    });
    const fallback: { message: string; fields: Record<string, unknown> }[] = [];
    const devices = new ScannerDevices({
      store,
      codes,
      clock,
      limiter: { allowed: async () => true, failed: async () => ({ globalAlert: true, globalFailures: 101 }) },
      opsAlert: { open },
      alert: (message, fields) => void fallback.push({ message, fields }),
    });
    await expect(devices.enroll({ code: 'WRONG-CODE', jkt: JKT })).rejects.toMatchObject({ reason: 'INVALID' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(fallback).toEqual([expect.objectContaining({ fields: expect.objectContaining({ failures: 101, err: 'ops-svc 503' }) })]);
  });

  test('경계 아래에서는 ops_alert도 logger.warn도 부르지 않는다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const open = vi.fn(async () => undefined);
    const fallback = vi.fn();
    const devices = new ScannerDevices({
      store,
      codes,
      clock,
      limiter: { allowed: async () => true, failed: async () => ({ globalAlert: false, globalFailures: 99 }) },
      opsAlert: { open },
      alert: fallback,
    });
    await expect(devices.enroll({ code: 'WRONG-CODE', jkt: JKT })).rejects.toMatchObject({ reason: 'INVALID' });
    expect(open).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('R-622 M5-07 jkt는 43자 base64url만 받는다', () => {
  test('도메인 assertJkt는 short·42자·44자·+·=·비문자열을 JKT 오류로 거절한다', () => {
    expect(assertJkt(JKT)).toBe(JKT);
    for (const bad of ['short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}=`, '!'.repeat(43), '', undefined, 43, null]) {
      try {
        assertJkt(bad);
        throw new Error(`통과하면 안 되는 jkt: ${String(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ScannerDeviceInputError);
        expect((e as InstanceType<typeof ScannerDeviceInputError>).code).toBe('JKT');
      }
    }
  });

  test('등록은 잘못된 jkt를 코드 소모 전에 거절하고, 같은 코드로 올바른 jkt를 다시 쓸 수 있다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const devices = new ScannerDevices({ store, codes, clock, newId: () => DEVICE });
    const r = await devices.register({ name: '동문-09', promoterId: PROMOTER, enrolledBy: ADMIN });
    await expect(devices.enroll({ code: r.enrollmentCode, jkt: 'A'.repeat(42) })).rejects.toMatchObject({ code: 'JKT' });
    await expect(devices.enroll({ code: r.enrollmentCode, jkt: JKT })).resolves.toEqual({ deviceId: DEVICE });
    expect(await store.byThumbprint(JKT)).toMatchObject({ deviceId: DEVICE });
  });

  test('기기 저장소 byThumbprint도 도메인 assertJkt를 거쳐 조회한다', async () => {
    const store = new MemoryScannerDeviceStore();
    await expect(store.byThumbprint('short')).rejects.toMatchObject({ code: 'JKT' });
    vi.mocked(assertJkt).mockClear();
    await expect(store.byThumbprint(JKT)).resolves.toBeNull();
    // 어댑터가 인라인 정규식을 따로 두면 이 단언이 깨진다(M5V §4).
    expect(vi.mocked(assertJkt)).toHaveBeenCalledWith(JKT);
  });
});
