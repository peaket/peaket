// 근무 준비·기기 배치·준비 보고·등록 코드 재발급·IP 실패 제한의 단위 시험
// (BUILD_ORDER GAT-170 잔여, offline-gate §6.1·§6.2, O-T42).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/memory-enrollment-attempt-limiter.js';
import { eventPolicyOf } from '../src/modules/scanner/adapters/http-core-event-policy.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { EnrollmentCodeRejected, ScannerDeviceInactive, ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import { ScannerPlacementForbidden, ScannerPlacements, ScannerPlacementPolicyUnavailable, ScannerShift, type ScannerSessionContext } from '../src/modules/scanner/application/scanner-shift.js';
import {
  ScannerPlacementConflict,
  ScannerPlacementDeviceInactive,
  ScannerPlacementMissing,
  ScannerPlacementPreconditionRequired,
  ScannerPlacementReentryNotAllowed,
} from '../src/modules/scanner/domain/scanner-shift.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000002';
const OTHER_DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000004';
const OTHER_PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000005';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000006';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000007';
const ASSIGNMENT = '0190f3a1-7c2e-7a00-8000-000000000008';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000009';
const JKT = 'A'.repeat(43);

const ctx: ScannerSessionContext = {
  accountId: ACCOUNT,
  sessionId: SESSION,
  deviceId: DEVICE,
  eventId: EVENT,
  role: 'gate_lead',
  proxy: false,
  assignmentId: ASSIGNMENT,
  validFromMs: NOW - HOUR,
  validUntilMs: NOW + 4 * HOUR,
};

async function world(policy: { promoterId: string; reentryAllowed: boolean; salesOpensAtMs?: number; salesEndsAtMs?: number; entryOpensAtMs?: number; entryClosesAtMs?: number; endsAtMs?: number } | null = { promoterId: PROMOTER, reentryAllowed: false }) {
  const clock = fakeClock({ now: NOW });
  const devices = new MemoryScannerDeviceStore();
  await devices.register({ deviceId: DEVICE, name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  await devices.bindCredential({ deviceId: DEVICE, jkt: JKT, atMs: NOW });
  await devices.register({ deviceId: OTHER_DEVICE, name: '서문-01', promoterId: OTHER_PROMOTER, enrolledBy: ADMIN, atMs: NOW });
  const gate = new MemoryScannerGateStore();
  const shifts = new MemoryScannerShiftStore(gate);
  const provider = policy ? { get: async () => policy } : undefined;
  const placements = new ScannerPlacements({ devices, shifts, clock, ...(provider ? { policy: provider } : {}) });
  const shift = new ScannerShift({ devices, shifts, gate, clock, maxOfflineMs: 24 * HOUR, ...(provider ? { policy: provider } : {}) });
  return { clock, devices, gate, shifts, placements, shift };
}

describe('기기 배치 [GAT-170]', () => {
  test('core 판매 설정 사본에서 회차 소유자와 판매·입장 창을 읽고, 소유자가 없으면 모른다', () => {
    expect(eventPolicyOf({ promoterId: PROMOTER, reentryAllowed: true, opensAtMs: 1, saleEndsAtMs: 2, entryOpensAtMs: null, entryClosedAtMs: 3, endsAtMs: 4 })).toEqual({
      promoterId: PROMOTER,
      reentryAllowed: true,
      salesOpensAtMs: 1,
      salesEndsAtMs: 2,
      entryClosesAtMs: 3,
      endsAtMs: 4,
    });
    expect(eventPolicyOf({ reentryAllowed: true })).toBeUndefined();
    expect(eventPolicyOf({ promoterId: PROMOTER })).toBeUndefined();
  });
  test('새 배치는 판 1이고 PLACEMENT 변경이 같은 일련번호로 남는다', async () => {
    const w = await world();
    const placed = await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } });
    expect(placed).toMatchObject({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', version: 1, setBy: ACCOUNT });
    expect(await w.shifts.placementOf(EVENT, DEVICE)).toMatchObject({ gateZone: '동문', mode: 'IN', version: 1 });
    expect(w.gate.changeLog.get(EVENT)).toEqual([{ seq: 1, kind: 'PLACEMENT', payload: { v: 1, deviceId: DEVICE, gateZone: '동문', mode: 'IN', version: 1 } }]);
    expect((await w.gate.versionVector(EVENT, NOW)).placementSeq).toBe(1);

    const next = await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ADMIN, ifMatch: '"1"', body: { gateZone: '서문', mode: 'IN' } });
    expect(next.version).toBe(2);
    expect(w.gate.changeLog.get(EVENT)?.map((c) => c.seq)).toEqual([1, 2]);
  });

  test('If-Match가 없으면 428, 판이 다르면 412다', async () => {
    const w = await world();
    await expect(w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: undefined, body: { gateZone: '동문', mode: 'IN' } })).rejects.toBeInstanceOf(ScannerPlacementPreconditionRequired);
    await expect(w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"7"', body: { gateZone: '동문', mode: 'IN' } })).rejects.toBeInstanceOf(ScannerPlacementConflict);
  });

  test('다른 파트너 기기·폐기 기기·다른 회차 세션은 거절한다', async () => {
    const w = await world();
    await expect(w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: OTHER_DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } })).rejects.toBeInstanceOf(ScannerPlacementForbidden);
    await w.devices.revoke({ deviceId: DEVICE, reason: '분실', atMs: NOW });
    await expect(w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } })).rejects.toBeInstanceOf(ScannerPlacementDeviceInactive);
    await expect(
      w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: OTHER_DEVICE, sessionEventId: '0190f3a1-7c2e-7a00-8000-000000000099', tenantId: OTHER_PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } }),
    ).rejects.toBeInstanceOf(ScannerPlacementForbidden);
  });

  test('퇴장 모드는 재입장 허용 회차만이고, 정책을 모르면 503으로 닫는다', async () => {
    const closed = await world({ promoterId: PROMOTER, reentryAllowed: false });
    await expect(closed.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'OUT' } })).rejects.toBeInstanceOf(ScannerPlacementReentryNotAllowed);
    const open = await world({ promoterId: PROMOTER, reentryAllowed: true });
    await expect(open.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'OUT' } })).resolves.toMatchObject({ mode: 'OUT' });
    const unknown = await world(null);
    await expect(unknown.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'OUT' } })).rejects.toBeInstanceOf(ScannerPlacementPolicyUnavailable);
  });
});

describe('근무 준비 [GAT-170]', () => {
  test('기기·배정·게이트·근무 창·목록 번호·버전 벡터를 한 응답에 담는다', async () => {
    const w = await world({ promoterId: PROMOTER, reentryAllowed: true, salesOpensAtMs: NOW - 3 * HOUR, salesEndsAtMs: NOW - HOUR, entryOpensAtMs: NOW + HOUR, entryClosesAtMs: NOW + 5 * HOUR, endsAtMs: NOW + 4 * HOUR });
    await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } });
    const view = await w.shift.shift(ctx);
    expect(view).toMatchObject({
      eventId: EVENT,
      reentryAllowed: true,
      placement: { gateZone: '동문', mode: 'IN' },
      packageSeq: 1,
      role: 'gate_lead',
      proxy: false,
      device: { deviceId: DEVICE, name: '동문-03', status: 'ACTIVE', credentialType: 'DEVICE_KEY', enrolled: true, mtls: false },
      assignment: { assignmentId: ASSIGNMENT, role: 'gate_lead', proxy: false },
      eventWindows: { salesOpensAt: new Date(NOW - 3 * HOUR).toISOString(), salesEndsAt: new Date(NOW - HOUR).toISOString(), entryOpensAt: new Date(NOW + HOUR).toISOString(), entryClosesAt: new Date(NOW + 5 * HOUR).toISOString(), endsAt: new Date(NOW + 4 * HOUR).toISOString() },
      package: { seq: 1, maxOfflineMs: 24 * HOUR, stale: false },
      auth: { deviceProof: 'DPOP', staffSession: true },
    });
    expect(view.versionVector).toMatchObject({ eventId: EVENT, seq: 1, placementSeq: 1, maxOfflineMs: 24 * HOUR });
  });

  test('배치가 없으면 409, 준비 보고가 오래되면 stale이다', async () => {
    const w = await world();
    await expect(w.shift.shift(ctx)).rejects.toBeInstanceOf(ScannerPlacementMissing);
    await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } });
    await w.shift.reportReadiness(ctx, { packageSeq: 1, clockOffsetMs: -420, pendingUploads: 3 });
    const fresh = await w.shift.shift(ctx);
    expect(fresh.package).toMatchObject({ reportedPackageSeq: 1, ageMs: 0, stale: false });
    expect(fresh.package.reportedAt).toBe(new Date(NOW).toISOString());

    w.clock.advance(24 * HOUR + 1);
    const stale = await w.shift.shift(ctx);
    expect(stale.package.stale).toBe(true);
    expect(stale.package.ageMs).toBe(24 * HOUR + 1);
  });

  test('폐기된 기기는 근무 준비를 주지 않는다', async () => {
    const w = await world();
    await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } });
    await w.devices.revoke({ deviceId: DEVICE, reason: '분실', atMs: NOW });
    await expect(w.shift.shift(ctx)).rejects.toBeInstanceOf(ScannerPlacementDeviceInactive);
  });

  test('기기가 서버보다 새 목록 번호를 보고하면 재동기화가 필요하다', async () => {
    const w = await world();
    await w.placements.put({ eventIdRaw: EVENT, deviceIdRaw: DEVICE, tenantId: PROMOTER, actorId: ACCOUNT, ifMatch: '"0"', body: { gateZone: '동문', mode: 'IN' } });
    await w.shift.reportReadiness(ctx, { packageSeq: 9, clockOffsetMs: 0, pendingUploads: 0 });
    expect((await w.shift.shift(ctx)).package.stale).toBe(true);
  });
});

describe('등록 코드 재발급과 IP 실패 제한 [GAT-170]', () => {
  test('재발급은 이전 코드를 무효로 만들고, 폐기 기기는 409다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const devices = new ScannerDevices({ store, codes, clock, newId: () => DEVICE });
    const created = await devices.register({ name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    const reissued = await devices.issueCode({ deviceId: DEVICE });
    expect(reissued.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    await expect(devices.enroll({ code: created.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
    await expect(devices.enroll({ code: reissued.enrollmentCode, jkt: JKT })).resolves.toEqual({ deviceId: DEVICE });
    await devices.revoke({ deviceId: DEVICE, reason: '분실' });
    await expect(devices.issueCode({ deviceId: DEVICE })).rejects.toBeInstanceOf(ScannerDeviceInactive);
  });

  test('O-T42 ①~④ 같은 IP 실패 10회 뒤 429이고 성공은 세지 않는다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const limiter = new MemoryEnrollmentAttemptLimiter(() => clock.now());
    const devices = new ScannerDevices({ store, codes, clock, limiter, newId: () => DEVICE });
    const created = await devices.register({ name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    for (let i = 0; i < 10; i++) await expect(devices.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.0.0.1' })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
    await expect(devices.enroll({ code: created.enrollmentCode, jkt: JKT, ip: '10.0.0.1' })).rejects.toMatchObject({ name: 'EnrollmentRateLimited' });
    await expect(devices.enroll({ code: created.enrollmentCode, jkt: JKT, ip: '10.0.0.2' })).resolves.toEqual({ deviceId: DEVICE });
    clock.advance(10 * 60_000);
    await expect(devices.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.0.0.1' })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
  });
});

describe('기기 폐기와 identity 세션 종료 [GAT-170]', () => {
  test('폐기는 DEVICE_REVOKED 세션 종료를 부르고, 실패해도 폐기는 남는다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const calls: unknown[] = [];
    const alerts: string[] = [];
    const devices = new ScannerDevices({
      store,
      codes,
      clock,
      sessions: { terminateByDevice: async (i) => (calls.push(i), 2) },
      alert: (m) => alerts.push(m),
      newId: () => DEVICE,
    });
    await devices.register({ name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    await expect(devices.revoke({ deviceId: DEVICE, reason: '분실' })).resolves.toMatchObject({ status: 'REVOKED' });
    expect(calls).toEqual([{ deviceId: DEVICE, reason: 'DEVICE_REVOKED', atMs: NOW }]);

    const failing = new ScannerDevices({
      store: new MemoryScannerDeviceStore(),
      codes: new MemoryEnrollmentCodeStore(clock),
      clock,
      sessions: { terminateByDevice: async () => Promise.reject(new Error('identity down')) },
      alert: (m) => alerts.push(m),
      newId: () => OTHER_DEVICE,
    });
    await failing.register({ name: '서문-01', promoterId: PROMOTER, enrolledBy: ADMIN });
    await expect(failing.revoke({ deviceId: OTHER_DEVICE, reason: '도난' })).resolves.toMatchObject({ status: 'REVOKED' });
    expect(alerts.some((m) => m.includes('identity 세션 종료에 실패'))).toBe(true);
  });
});
