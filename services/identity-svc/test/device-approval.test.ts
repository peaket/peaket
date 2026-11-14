// 기기 승인 로그인 시험(BUILD_ORDER GAT-220, identity §6.1, offline-gate §6.1, RFC 8628, I-T22).
// 기기 코드 발급·승인 화면·승인/거부·토큰 폴링을 메모리 저장소와 가짜 기기 원장으로 본다.
import { fakeClock, type DpopReplayStore } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryDeviceAuthorizations, MemoryDeviceApprovalLimits } from '../src/modules/session/adapters/memory-device-authorizations.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { DeviceApprovals } from '../src/modules/session/application/device-approvals.js';
import { PollScannerToken } from '../src/modules/session/application/poll-scanner-token.js';
import { DeviceAuthorizationError, StartDeviceAuthorization } from '../src/modules/session/application/start-device-authorization.js';
import type { ScannerDeviceLookupAnswer, ScannerDeviceRegistry, TokenSigner } from '../src/modules/session/domain/ports.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const HOUR = 3_600_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000005';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000006';
const P1 = '0190f3a1-7c2e-7a00-8000-000000000007';
const P2 = '0190f3a1-7c2e-7a00-8000-000000000008';
const JKT = 'A'.repeat(43);

class FakeRegistry implements ScannerDeviceRegistry {
  answer: ScannerDeviceLookupAnswer = { found: true, deviceId: DEVICE, status: 'ACTIVE', name: '동문-03', promoterId: P1 };
  calls = 0;
  async byThumbprint(): Promise<ScannerDeviceLookupAnswer> {
    this.calls += 1;
    return this.answer;
  }
}

class FakeSigner implements TokenSigner {
  readonly issuer = 'https://identity.peaket.example';
  async access(): Promise<{ token: string; expiresAt: number }> {
    throw new Error('not used');
  }
  async reauth(): Promise<{ token: string; expiresAt: number }> {
    throw new Error('not used');
  }
  async staff(c: { expiresAtMs: number }): Promise<{ token: string; expiresAt: number }> {
    return { token: `staff-token-${c.expiresAtMs}`, expiresAt: c.expiresAtMs };
  }
}

class FakeReplay implements DpopReplayStore {
  async claim(): Promise<boolean> {
    return true;
  }
}

function world() {
  const clock = fakeClock({ now: NOW });
  const assignments = new MemoryStaffAssignmentStore();
  assignments.assignments.set('a-1', {
    id: 'a-1',
    accountId: ACCOUNT,
    status: 'ASSIGNED',
    eventId: EVENT,
    role: 'gate_staff',
    promoterId: P1,
    invitedBy: ADMIN,
    validFromMs: NOW - HOUR,
    validUntilMs: NOW + 2 * HOUR,
  });
  const store = new MemoryDeviceAuthorizations(() => clock.now());
  const limits = new MemoryDeviceApprovalLimits();
  const registry = new FakeRegistry();
  const start = new StartDeviceAuthorization(registry, store, limits, clock);
  let n = 0;
  const approvals = new DeviceApprovals(store, assignments, limits, clock, () => `ss-${++n}`);
  const signer = new FakeSigner();
  const poll = new PollScannerToken(store, registry, signer, clock);
  return { clock, assignments, store, limits, registry, start, approvals, poll, signer };
}

async function started(w: ReturnType<typeof world>) {
  const r = await w.start.run({ jkt: JKT });
  return { ...r, hash: (await w.store.findByUserCode(r.userCode))!.deviceCodeHash };
}

beforeEach(() => {
  process.env.PEAKET_SCANNER_APPROVAL_URL = 'https://scanner.peaket.example/staff/approve';
});

describe('기기 승인 코드 발급 [GAT-220, I-T22]', () => {
  test('ACTIVE 기기만 코드를 받고, 기기당 시간당 10회로 제한한다', async () => {
    const w = world();
    const r = await w.start.run({ jkt: JKT });
    expect(r.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(r.deviceCode).toHaveLength(43);
    expect(r.verificationUriComplete).toBe(`https://scanner.peaket.example/staff/approve#code=${encodeURIComponent(r.userCode)}`);
    expect(r.expiresIn).toBe(300);
    expect(r.interval).toBe(5);
    expect(await w.store.findByUserCode(r.userCode)).toMatchObject({ deviceId: DEVICE, deviceName: '동문-03', promoterId: P1, jkt: JKT, status: 'PENDING' });

    for (let i = 0; i < 9; i++) await w.start.run({ jkt: JKT });
    await expect(w.start.run({ jkt: JKT })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    w.registry.answer = { found: true, deviceId: DEVICE, status: 'REVOKED', name: '동문-03', promoterId: P1 };
    await expect(w.start.run({ jkt: JKT })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  test('미등록 기기와 만료된 코드는 거절한다', async () => {
    const w = world();
    w.registry.answer = { found: false };
    await expect(w.start.run({ jkt: JKT })).rejects.toBeInstanceOf(DeviceAuthorizationError);
    w.registry.answer = { found: true, deviceId: DEVICE, status: 'ACTIVE', name: '동문-03', promoterId: P1 };
    const s = await started(w);
    w.clock.advance(5 * 60_000 + 1);
    expect(await w.store.findByUserCode(s.userCode)).toBeNull();
  });
});

describe('기기 승인 화면·승인 [GAT-220, I-T22]', () => {
  test('그 기기 파트너 회차의 유효 배정만 보인다', async () => {
    const w = world();
    const s = await started(w);
    const view = await w.approvals.lookup({ userCode: s.userCode.toLowerCase().replace('-', ' '), accountId: ACCOUNT });
    expect(view).toMatchObject({ deviceName: '동문-03', userCode: s.userCode, canProxy: false });
    expect(view.assignments).toEqual([expect.objectContaining({ assignmentId: 'a-1', eventId: EVENT, role: 'gate_staff' })]);

    await expect(w.approvals.lookup({ userCode: s.userCode, accountId: OTHER })).rejects.toMatchObject({ code: 'STAFF_ASSIGNMENT_MISSING' });

    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, promoterId: P2 });
    await expect(w.approvals.lookup({ userCode: s.userCode, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'OTHER_PARTNER_DEVICE' });

    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, promoterId: P1, validUntilMs: NOW - 1 });
    await expect(w.approvals.lookup({ userCode: s.userCode, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'OUTSIDE_STAFF_HOURS' });
  });

  test('승인하면 세션을 만들고 이전 세션을 끝낸 뒤 토큰을 준다', async () => {
    const w = world();
    const s = await started(w);
    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' });

    expect(w.assignments.sessions.get('ss-1')).toMatchObject({
      scannerSessionId: 'ss-1',
      assignmentId: 'a-1',
      deviceId: DEVICE,
      role: 'gate_staff',
      proxy: false,
      terminatedAt: null,
    });
    const token = await w.poll.run({ deviceCode: s.deviceCode, jkt: JKT });
    expect(token).toEqual({ access_token: `staff-token-${NOW + 2 * HOUR}`, token_type: 'DPoP', expires_in: 7200 });

    const second = await started(w);
    await w.approvals.decide({ userCode: second.userCode, accountId: ACCOUNT, sessionId: 'fan-session-2', decision: 'APPROVE' });
    expect(w.assignments.sessions.get('ss-1')!.terminatedAt).toBe(NOW);
  });

  test('대리 승인은 책임자만 되고 세션 역할은 gate_staff로 낮춘다', async () => {
    const w = world();
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, role: 'gate_lead' });
    const s = await started(w);
    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE', proxy: true });
    expect(w.assignments.sessions.get('ss-1')).toMatchObject({ role: 'gate_staff', proxy: true });

    const w2 = world();
    const s2 = await started(w2);
    await expect(w2.approvals.decide({ userCode: s2.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE', proxy: true })).rejects.toMatchObject({
      code: 'PROXY_NOT_ALLOWED',
    });
  });

  test('거부·만료·너무 잦은 폴링은 OAuth 오류로 답한다', async () => {
    const w = world();
    const pending = await started(w);
    await expect(w.poll.run({ deviceCode: pending.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'authorization_pending' });
    await expect(w.poll.run({ deviceCode: pending.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'slow_down' });

    const denied = await started(w);
    await w.approvals.decide({ userCode: denied.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'DENY' });
    await expect(w.poll.run({ deviceCode: denied.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'access_denied' });

    const expired = await started(w);
    w.clock.advance(5 * 60_000 + 1);
    await expect(w.poll.run({ deviceCode: expired.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'expired_token' });
  });

  test('다른 키 지문과 승인 뒤 폐기는 토큰을 주지 않는다', async () => {
    const w = world();
    const s = await started(w);
    await expect(w.poll.run({ deviceCode: s.deviceCode, jkt: 'B'.repeat(43) })).rejects.toMatchObject({ code: 'expired_token' });

    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' });
    w.registry.answer = { found: true, deviceId: DEVICE, status: 'REVOKED', name: '동문-03', promoterId: P1 };
    await expect(w.poll.run({ deviceCode: s.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'device_revoked' });
  });

  test('승인 시도는 계정당 10분 5회로 제한한다', async () => {
    const w = world();
    const s = await started(w);
    for (let i = 0; i < 5; i++) {
      await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'DENY' }).catch(() => undefined);
    }
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'DENY' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  test('배정이 둘 이상이면 assignmentId를 요구하고 두 번째 승인은 ALREADY_HANDLED다', async () => {
    const w = world();
    w.assignments.assignments.set('a-2', {
      id: 'a-2',
      accountId: ACCOUNT,
      status: 'ASSIGNED',
      eventId: '0190f3a1-7c2e-7a00-8000-000000000002',
      role: 'gate_lead',
      promoterId: P1,
      invitedBy: ADMIN,
      validFromMs: NOW - HOUR,
      validUntilMs: NOW + 2 * HOUR,
    });
    const s = await started(w);
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' })).rejects.toMatchObject({
      code: 'ASSIGNMENT_REQUIRED',
    });
    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE', assignmentId: 'a-2' });
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE', assignmentId: 'a-2' })).rejects.toMatchObject({
      code: 'ALREADY_HANDLED',
    });
  });

  test('기기 코드는 만료 시각과 같아도 만료이고, 배정은 유효 끝과 같아도 유효하다', async () => {
    const w = world();
    const s = await started(w);
    const rec = w.store.byHash.get(s.hash)!;
    rec.expiresAtMs = NOW;
    expect(await w.store.findByUserCode(s.userCode)).toBeNull();

    const s2 = await started(w);
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, validUntilMs: NOW });
    await expect(w.approvals.lookup({ userCode: s2.userCode, accountId: ACCOUNT })).resolves.toBeDefined();
  });
});
