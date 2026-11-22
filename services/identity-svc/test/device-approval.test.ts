// 기기 승인 로그인 시험(BUILD_ORDER GAT-220, identity §6.1, offline-gate §6.1, RFC 8628, I-T22).
// 기기 코드 발급·승인 화면·승인/거부·토큰 폴링을 메모리 저장소와 가짜 기기 원장으로 본다.
import { fakeClock, type DpopReplayStore } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryDeviceAuthorizations, MemoryDeviceApprovalLimits } from '../src/modules/session/adapters/memory-device-authorizations.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { DeviceApprovals } from '../src/modules/session/application/device-approvals.js';
import { PollScannerToken } from '../src/modules/session/application/poll-scanner-token.js';
import { DeviceAuthorizationError, StartDeviceAuthorization } from '../src/modules/session/application/start-device-authorization.js';
import type { DeviceAuthorizationRecord } from '../src/modules/session/domain/device-approval.js';
import type { DeviceAuthorizationStore, ScannerDeviceLookupAnswer, ScannerDeviceRegistry, TokenSigner } from '../src/modules/session/domain/ports.js';

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
  assignments.accounts.set(ACCOUNT, { verified: true, status: 'ACTIVE' });
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
  test('I-T37 ① ACTIVE 기기만 코드를 받고, 기기당 시간당 10회로 제한한다', async () => {
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

  test('근무 창 밖 승인은 OUTSIDE_STAFF_HOURS다', async () => {
    const w = world();
    const s = await started(w);
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, validUntilMs: NOW - 1 });
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' })).rejects.toMatchObject({ code: 'OUTSIDE_STAFF_HOURS' });
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

  test('I-T39 ③ 다른 키 지문과 승인 뒤 폐기는 토큰을 주지 않는다', async () => {
    const w = world();
    const s = await started(w);
    await expect(w.poll.run({ deviceCode: s.deviceCode, jkt: 'B'.repeat(43) })).rejects.toMatchObject({ code: 'expired_token' });

    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' });
    w.registry.answer = { found: true, deviceId: DEVICE, status: 'REVOKED', name: '동문-03', promoterId: P1 };
    await expect(w.poll.run({ deviceCode: s.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'device_revoked' });
  });

  test('I-T37 ② 승인 시도는 계정당 10분 5회로 제한한다', async () => {
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

  test('I-T23 ② 기기 코드는 만료 시각과 같아도 만료이고, 배정은 유효 끝과 같아도 유효하다', async () => {
    const w = world();
    const s = await started(w);
    const rec = w.store.byHash.get(s.hash)!;
    rec.expiresAtMs = NOW;
    expect(await w.store.findByUserCode(s.userCode)).toBeNull();

    const s2 = await started(w);
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, validUntilMs: NOW });
    await expect(w.approvals.lookup({ userCode: s2.userCode, accountId: ACCOUNT })).resolves.toBeDefined();
  });

  test('I-T23 ① R-622 M5-08 근무 시작 전 배정은 승인(lookup·decide)에서 OUTSIDE_STAFF_HOURS이고 세션을 만들지 않는다', async () => {
    const w = world();
    const s = await started(w);
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, validFromMs: NOW + 1 });
    await expect(w.approvals.lookup({ userCode: s.userCode, accountId: ACCOUNT })).rejects.toMatchObject({ code: 'OUTSIDE_STAFF_HOURS' });
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' })).rejects.toMatchObject({
      code: 'OUTSIDE_STAFF_HOURS',
    });
    expect(w.assignments.sessions.size).toBe(0);
    expect(w.store.byHash.get(s.hash)!.status).toBe('PENDING');

    // 경계: validFrom과 정확히 같은 시각이면 승인할 수 있다.
    w.assignments.assignments.set('a-1', { ...w.assignments.assignments.get('a-1')!, validFromMs: NOW });
    await expect(w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' })).resolves.toBeUndefined();
    expect(w.assignments.sessions.get('ss-1')).toMatchObject({ assignmentId: 'a-1', terminatedAt: null });
  });
});

/** save가 처음 한 번 거절되는 저장소. 사용자 코드 재시도가 저장 호출을 두 번 하는지 센다 */
class RecordingSaveStore {
  readonly saved: DeviceAuthorizationRecord[] = [];
  async save(r: DeviceAuthorizationRecord): Promise<unknown> {
    this.saved.push(r);
    return this.saved.length > 1;
  }
  async findByUserCode(): Promise<null> {
    return null;
  }
  async get(): Promise<null> {
    return null;
  }
  async approve(): Promise<boolean> {
    return false;
  }
  async deny(): Promise<boolean> {
    return false;
  }
  async notePoll(): Promise<{ result: 'EXPIRED' }> {
    return { result: 'EXPIRED' };
  }
}

describe('C2-06 사용자 확인 코드 색인 원자성', () => {
  test('C2-06 ① 같은 사용자 코드 색인은 두 번째 저장을 거절하고 첫 레코드·색인을 그대로 둔다', async () => {
    const w = world();
    const first = await w.start.run({ jkt: JKT });
    const hashFirst = (await w.store.findByUserCode(first.userCode))!.deviceCodeHash;
    const secondHash = 'b'.repeat(64);
    const saved = await w.store.save({
      deviceCodeHash: secondHash,
      userCode: first.userCode,
      deviceId: 'dev-2',
      deviceName: '서문-01',
      promoterId: P1,
      jkt: JKT,
      status: 'PENDING',
      createdAtMs: NOW,
      expiresAtMs: NOW + 300_000,
      intervalSec: 5,
    });
    expect(saved).toBe(false);
    expect((await w.store.findByUserCode(first.userCode))!.deviceCodeHash).toBe(hashFirst);
    expect(await w.store.get(secondHash)).toBeNull();
  });

  test('C2-06 ② 사용자 코드가 한 번 겹치면 새 코드로 다시 저장한다', async () => {
    const clock = fakeClock({ now: NOW });
    const registry = new FakeRegistry();
    const store = new RecordingSaveStore();
    const limits = new MemoryDeviceApprovalLimits();
    const start = new StartDeviceAuthorization(registry, store as unknown as DeviceAuthorizationStore, limits, clock);
    const r = await start.run({ jkt: JKT });
    expect(store.saved).toHaveLength(2);
    expect(store.saved[1]!.userCode).toBe(r.userCode);
  });
});

describe('C2-07 첫 토큰 발급 뒤 기기 코드 파기', () => {
  test('C2-07 ① 첫 토큰 발급이 기기 코드와 색인을 지우고 두 번째 폴링은 expired_token이다', async () => {
    const w = world();
    const s = await started(w);
    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' });
    await w.poll.run({ deviceCode: s.deviceCode, jkt: JKT });
    expect(w.store.byHash.has(s.hash)).toBe(false);
    expect(w.store.byUserCode.has(s.userCode)).toBe(false);
    await expect(w.poll.run({ deviceCode: s.deviceCode, jkt: JKT })).rejects.toMatchObject({ code: 'expired_token' });
  });

  test('C2-07 ② 승인 뒤 동시 폴링 두 개 중 하나만 토큰을 받는다', async () => {
    const w = world();
    const s = await started(w);
    await w.approvals.decide({ userCode: s.userCode, accountId: ACCOUNT, sessionId: 'fan-session', decision: 'APPROVE' });
    const results = await Promise.allSettled([
      w.poll.run({ deviceCode: s.deviceCode, jkt: JKT }),
      w.poll.run({ deviceCode: s.deviceCode, jkt: JKT }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { code?: string }).code).toBe('expired_token');
  });
});

describe('I-T38 스캐너 세션 수와 교대', () => {
  test('I-T38 ① 같은 계정으로 둘째 기기를 승인하면 첫 기기 세션이 끝난다', async () => {
    const w = world();
    const first = await started(w);
    await w.approvals.decide({ userCode: first.userCode, accountId: ACCOUNT, sessionId: 'fan-session-1', decision: 'APPROVE', assignmentId: 'a-1' });
    expect(w.assignments.sessions.get('ss-1')).toMatchObject({ deviceId: DEVICE, terminatedAt: null });

    w.registry.answer = { ...w.registry.answer, deviceId: '0190f3a1-7c2e-7a00-8000-000000000009' };
    const second = await started(w);
    await w.approvals.decide({ userCode: second.userCode, accountId: ACCOUNT, sessionId: 'fan-session-2', decision: 'APPROVE', assignmentId: 'a-1' });
    expect(w.assignments.sessions.get('ss-1')!.terminatedAt).toBe(NOW);
    expect(w.assignments.sessions.get('ss-2')).toMatchObject({ deviceId: '0190f3a1-7c2e-7a00-8000-000000000009', terminatedAt: null });
  });

  test('I-T38 ② 같은 기기에서 다른 스태프가 승인하면 이전 스태프 세션이 끝난다(교대)', async () => {
    const w = world();
    w.assignments.accounts.set(OTHER, { verified: true, status: 'ACTIVE' });
    w.assignments.assignments.set('a-2', {
      id: 'a-2',
      accountId: OTHER,
      status: 'ASSIGNED',
      eventId: EVENT,
      role: 'gate_staff',
      promoterId: P1,
      invitedBy: ADMIN,
      validFromMs: NOW - HOUR,
      validUntilMs: NOW + 2 * HOUR,
    });

    const first = await started(w);
    await w.approvals.decide({ userCode: first.userCode, accountId: ACCOUNT, sessionId: 'fan-session-1', decision: 'APPROVE', assignmentId: 'a-1' });
    expect(w.assignments.sessions.get('ss-1')).toMatchObject({ deviceId: DEVICE, terminatedAt: null });

    const second = await started(w);
    await w.approvals.decide({ userCode: second.userCode, accountId: OTHER, sessionId: 'fan-session-2', decision: 'APPROVE', assignmentId: 'a-2' });
    expect(w.assignments.sessions.get('ss-1')!.terminatedAt).toBe(NOW);
    expect(w.assignments.sessions.get('ss-2')).toMatchObject({ deviceId: DEVICE, terminatedAt: null });
    expect([...w.assignments.sessions.values()].filter((s) => s.terminatedAt === null)).toHaveLength(1);
  });
});
