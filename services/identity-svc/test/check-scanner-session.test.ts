// 스캐너 세션 확인(gRPC ScannerSessionCheckService, identity §6.1, offline-gate §6.1, ADR-0051 결정 4, BUILD_ORDER GAT-170).
// ticket-svc 가드가 요청마다 묻는 판정과 hasStaffAssignment(BOT-047이 넘긴 것)를 단위 시험으로 본다.
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { scannerSessionCheckHandlers } from '../src/modules/session/inbound/scanner-session-check.grpc.js';
import type { ScannerSessionRecord, StaffAssignmentStore } from '../src/modules/session/domain/staff.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const HOUR = 60 * 60_000;

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryStaffAssignmentStore();
  store.accounts.set('acc-1', { verified: true, status: 'ACTIVE' });
  store.assignments.set('a-1', { id: 'a-1', accountId: 'acc-1', status: 'ASSIGNED' });
  const session: ScannerSessionRecord = {
    scannerSessionId: 'ss-1',
    assignmentId: 'a-1',
    accountId: 'acc-1',
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
    await expect(check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).resolves.toMatchObject({ valid: true, role: 'gate_staff', eventId: 'ev-1', assignmentId: 'a-1', proxy: false });
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

  test('I-T24 ① 배정이 REVOKED로 해제되면 다음 서버 확인부터 무효이고 16분이 지나도 무효다', async () => {
    const { check, store, clock } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, assignmentStatus: 'REVOKED' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    clock.advance(16 * 60_000);
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

  test('탈퇴·병합된 계정의 세션은 배정 유효 시간이 남아도 무효다', async () => {
    const { check, store } = world();
    store.accounts.set('acc-1', { verified: true, status: 'DELETED' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    store.accounts.set('acc-1', { verified: true, status: 'MERGED' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    store.accounts.set('acc-1', { verified: true, status: 'ACTIVE' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(true);
  });

  test('탈퇴 유예 중인 계정의 세션도 무효다(스캐너 세션은 ACTIVE 계정만 유효하다, C2-01)', async () => {
    const { check, store } = world();
    store.accounts.set('acc-1', { verified: true, status: 'WITHDRAWAL_PENDING' });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
  });

  test('계정 행이 없는 고아 세션은 무효이고 touch하지 않는다(C2-01)', async () => {
    const { clock, session } = world();
    const check = new CheckScannerSession(
      {
        findScannerSession: async () => session,
        accountStatusOf: async () => null,
        touchScannerSession: async () => {
          throw new Error('무효 세션을 touch하면 안 된다');
        },
      } as unknown as StaffAssignmentStore,
      clock,
    );
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
  });

  test('validFrom이 미래인 세션은 무효이고, 정확히 같은 시각은 유효하다', async () => {
    const { check, store } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, validFrom: NOW + 1 });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, validFrom: NOW });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(true);
  });

  test('끝난 세션도 계정·역할 유효 창을 돌려주어 기기 단독 업로드가 기록 시각을 판정한다(C1-11)', async () => {
    const { check, store } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, terminatedAt: NOW });
    await expect(check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).resolves.toMatchObject({
      valid: false,
      accountId: 'acc-1',
      eventId: 'ev-1',
      validFromMs: NOW - HOUR,
      validUntilMs: NOW + 2 * HOUR,
    });
  });

  test('대리 승인 세션은 gate_staff 역할로 돌려준다', async () => {
    const { check, store } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, proxy: true, role: 'gate_staff' });
    await expect(check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).resolves.toMatchObject({ valid: true, role: 'gate_staff', eventId: 'ev-1', proxy: true });
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
    const handlers = scannerSessionCheckHandlers({ check, terminate: { run: async () => ({ terminated: 0 }) } }, () => {});
    const call = { request: { scanner_session_id: 'ss-1', device_id: 'dev-1' } } as unknown as grpc.ServerUnaryCall<Record<string, unknown>, object>;
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (handlers.CheckScannerSession as (c: typeof call, cb: (err: unknown, value: Record<string, unknown>) => void) => void)(call, (err, value) => (err ? reject(err) : resolve(value)));
    });
    expect(answer).toMatchObject({ valid: true, role: 'STAFF_ROLE_GATE_STAFF', event_id: 'ev-1', assignment_id: 'a-1', proxy: false });
  });
});

describe('R-622 C1-11·M5-03 스캐너 세션 계약', () => {
  test('끝난 세션도 계정·유효 창을 gRPC account_id로 돌려주어 기기 단독 업로드가 시각을 판정한다', async () => {
    const { check, store } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, terminatedAt: NOW });
    const handlers = scannerSessionCheckHandlers({ check, terminate: { run: async () => ({ terminated: 0 }) } }, () => {});
    const call = { request: { scanner_session_id: 'ss-1', device_id: 'dev-1' } } as unknown as grpc.ServerUnaryCall<Record<string, unknown>, object>;
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (handlers.CheckScannerSession as (c: typeof call, cb: (err: unknown, value: Record<string, unknown>) => void) => void)(call, (err, value) => (err ? reject(err) : resolve(value)));
    });
    expect(answer).toMatchObject({
      valid: false,
      role: 'STAFF_ROLE_GATE_STAFF',
      event_id: 'ev-1',
      account_id: 'acc-1',
      valid_from_ms: NOW - HOUR,
      valid_until_ms: NOW + 2 * HOUR,
    });
  });

  test('역할 유효 창 경계: 시작 전은 무효, 정확히 시작·끝은 유효하고 1ms 뒤는 무효다', async () => {
    const { check, store, clock } = world();
    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, validFrom: NOW + 1, validUntil: NOW + 2 * HOUR, expiresAt: NOW + 3 * HOUR });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);

    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, validFrom: NOW });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(true);

    store.sessions.set('ss-1', { ...store.sessions.get('ss-1')!, validUntil: NOW, expiresAt: NOW + 3 * HOUR });
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(true);
    clock.advance(1);
    expect((await check.run({ scannerSessionId: 'ss-1', deviceId: 'dev-1' })).valid).toBe(false);
  });
});
