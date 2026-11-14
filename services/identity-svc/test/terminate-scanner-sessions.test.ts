// 기기 폐기 때 스캐너 세션 종료와 control.sessions-terminated(DEVICE_REVOKED) 시험
// (BUILD_ORDER GAT-170 잔여, O-T27, offline-gate §6.1).
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { TerminateScannerSessions } from '../src/modules/session/application/terminate-scanner-sessions.js';
import { scannerSessionCheckHandlers } from '../src/modules/session/inbound/scanner-session-check.grpc.js';
import type { ScannerSessionRecord } from '../src/modules/session/domain/staff.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000001';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';

function session(id: string, deviceId: string, assignmentId: string): ScannerSessionRecord {
  return {
    scannerSessionId: id,
    assignmentId,
    deviceId,
    role: 'gate_staff',
    proxy: false,
    expiresAt: NOW + HOUR,
    terminatedAt: null,
    assignmentStatus: 'ASSIGNED',
    validFrom: NOW - HOUR,
    validUntil: NOW + 2 * HOUR,
    eventId: '0190f3a1-7c2e-7a00-8000-000000000004',
  };
}

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryStaffAssignmentStore();
  store.assignments.set('a-1', { id: 'a-1', accountId: ACCOUNT, status: 'ASSIGNED' });
  store.sessions.set('s-1', session('s-1', DEVICE, 'a-1'));
  store.sessions.set('s-2', session('s-2', DEVICE, 'a-1'));
  store.sessions.set('s-3', session('s-3', OTHER, 'a-1'));
  const uc = new TerminateScannerSessions(store, clock);
  return { clock, store, uc };
}

describe('TerminateScannerSessions(GAT-170)', () => {
  test('그 기기의 살아 있는 세션만 끝내고 DEVICE_REVOKED 사건을 세션마다 남긴다', async () => {
    const w = world();
    await expect(w.uc.run({ deviceId: DEVICE, reason: 'DEVICE_REVOKED' })).resolves.toEqual({ terminated: 2 });
    expect(w.store.sessions.get('s-1')?.terminatedAt).toBe(NOW);
    expect(w.store.sessions.get('s-2')?.terminatedAt).toBe(NOW);
    expect(w.store.sessions.get('s-3')?.terminatedAt).toBeNull();
    expect(w.store.terminatedEvents).toEqual([
      { accountId: ACCOUNT, sessionId: 's-1', reason: 'DEVICE_REVOKED', terminatedAt: new Date(NOW).toISOString() },
      { accountId: ACCOUNT, sessionId: 's-2', reason: 'DEVICE_REVOKED', terminatedAt: new Date(NOW).toISOString() },
    ]);
    await expect(w.uc.run({ deviceId: DEVICE, reason: 'DEVICE_REVOKED' })).resolves.toEqual({ terminated: 0 });
  });

  test('기기 ID와 사유를 확인하고, gRPC 처리기는 끝낸 수를 돌려준다', async () => {
    const w = world();
    await expect(w.uc.run({ deviceId: 'not-a-uuid', reason: 'DEVICE_REVOKED' })).rejects.toMatchObject({ field: 'device_id' });
    await expect(w.uc.run({ deviceId: DEVICE, reason: 'LOGOUT' })).rejects.toMatchObject({ field: 'reason' });
    const handlers = scannerSessionCheckHandlers({ check: { run: async () => ({ valid: false }) }, terminate: { run: (i) => w.uc.run(i) } }, () => {});
    const call = { request: { device_id: DEVICE, reason: 'DEVICE_REVOKED', terminated_at_ms: NOW } } as unknown as grpc.ServerUnaryCall<Record<string, unknown>, object>;
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (handlers.TerminateScannerSessions as (c: typeof call, cb: (err: unknown, value: Record<string, unknown>) => void) => void)(call, (err, value) => (err ? reject(err) : resolve(value)));
    });
    expect(answer).toEqual({ terminated: 2 });
  });
});
