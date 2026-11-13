// 스캐너 세션 확인(gRPC ScannerSessionCheckService, identity §6.1, offline-gate §6.1, ADR-0051 결정 4, BUILD_ORDER GAT-170).
// ticket-svc 가드가 요청마다 묻는 판정과 hasStaffAssignment(BOT-047이 넘긴 것)를 단위 시험으로 본다.
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { scannerSessionCheckHandlers } from '../src/modules/session/inbound/scanner-session-check.grpc.js';
import type { ScannerSessionRecord } from '../src/modules/session/domain/staff.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const HOUR = 60 * 60_000;

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryStaffAssignmentStore();
  store.assignments.set('a-1', { id: 'a-1', accountId: 'acc-1', status: 'ASSIGNED' });
  const session: ScannerSessionRecord = {
    scannerSessionId: 'ss-1',
    deviceId: 'dev-1',
    role: 'gate_staff',
    proxy: false,
    expiresAt: NOW + HOUR,
    terminatedAt: null,
    assignmentStatus: 'ASSIGNED',
    validFrom: NOW - HOUR,
    validUntil: NOW + 2 * HOUR,
    eventId: 'ev-1',
  };
  store.sessions.set('ss-1', session);
  const check = new CheckScannerSession(store, clock);
  return { clock, store, check, session };
}

describe('CheckScannerSession(GAT-170)', () => {
  test('유효한 세션은 역할과 회차를 돌려준다', async () => {
    const { check } = world();
    await expect(check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).resolves.toEqual({ valid: true, role: 'gate_staff', eventId: 'ev-1' });
  });

  test('다른 기기·끝난 세션·만료된 세션은 유효하지 않다', async () => {
    const { check, store, clock } = world();
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-2' })).valid).toBe(false);
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, terminatedAt: NOW });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, terminatedAt: null, expiresAt: NOW });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    clock.advance(1);
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
  });

  test('배정이 ASSIGNED가 아니거나 역할 유효 시간 밖이면 유효하지 않다', async () => {
    const { check, store, clock } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, assignmentStatus: 'REVOKED' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, assignmentStatus: 'ASSIGNED' });
    clock.advance(3 * HOUR);
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
  });

  test('대리 승인 세션은 gate_staff 역할로 돌려준다', async () => {
    const { check, store } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, proxy: true, role: 'gate_staff' });
    await expect(check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).resolves.toEqual({ valid: true, role: 'gate_staff', eventId: 'ev-1' });
  });

  test('BOT047_hasStaffAssignment는 지금 ASSIGNED인 배정만 true다', async () => {
    const { store } = world();
    await expect(store.hasAssigned('acc-1')).resolves.toBe(true);
    await expect(store.hasAssigned('acc-2')).resolves.toBe(false);
    store.assignments.set('a-1', { ...store.assignments.get('a-1')!, status: 'REVOKED' });
    await expect(store.hasAssigned('acc-1')).resolves.toBe(false);
  });

  test('gRPC 처리기는 역할을 계약의 열거 이름으로 바꾼다', async () => {
    const { check } = world();
    const handlers = scannerSessionCheckHandlers({ check }, () => {});
    const call = { request: { scanner_session_id: 'ss-1', device_id: 'dev-1' } } as unknown as grpc.ServerUnaryCall<Record<string, unknown>, object>;
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (handlers.CheckScannerSession as (c: typeof call, cb: (err: unknown, value: Record<string, unknown>) => void) => void)(call, (err, value) => (err ? reject(err) : resolve(value)));
    });
    expect(answer).toEqual({ valid: true, role: 'STAFF_ROLE_GATE_STAFF', event_id: 'ev-1' });
  });
});
