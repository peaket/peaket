// 현장 스태프 초대·내 배정 시험(BUILD_ORDER GAT-210, identity §6.1, FR-046·POL-031).
import { fakeClock } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { StaffInvitationError, StaffInvitations, STAFF_CONSENT_VERSION } from '../src/modules/session/application/staff-invitations.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const HOUR = 3_600_000;
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT_2 = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000004';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000005';
const TOKEN = 'invite-token-1';
const TOKEN_2 = 'invite-token-2';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let store: MemoryStaffAssignmentStore;
let invitations: StaffInvitations;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  store = new MemoryStaffAssignmentStore();
  store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: true });
  store.accounts.set(OTHER, { email: 'other@example.com', verified: true });
  store.assignments.set('a-1', {
    id: 'a-1',
    accountId: null,
    status: 'INVITED',
    eventId: EVENT,
    role: 'gate_staff',
    inviteEmail: 'staff@example.com',
    inviteTokenHash: hash(TOKEN),
    inviteExpiresAtMs: NOW + HOUR,
    invitedBy: ADMIN,
    validFromMs: NOW - HOUR,
    validUntilMs: NOW + 2 * HOUR,
  });
  invitations = new StaffInvitations(store, clock);
});

const accept = (over: Partial<Parameters<StaffInvitations['accept']>[0]> = {}) => ({
  inviteToken: TOKEN,
  accountId: ACCOUNT,
  consentCollection: true,
  consentProvision: true,
  consentVersion: STAFF_CONSENT_VERSION,
  ...over,
});

describe('StaffInvitations [GAT-210]', () => {
  test('초대 조회는 역할·유효 시간·가린 이메일·동의 판을 주고, 만료된 초대는 410이다', async () => {
    await expect(invitations.lookup(TOKEN)).resolves.toMatchObject({
      role: 'gate_staff',
      invitedEmailMasked: 's***@example.com',
      consents: { consentVersion: STAFF_CONSENT_VERSION },
    });
    clock.advance(HOUR + 1);
    await expect(invitations.lookup(TOKEN)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  test('I-T21 수락은 검증 이메일 일치·두 동의·같은 동의 판을 요구하고, 성공하면 ASSIGNED가 된다', async () => {
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: false });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_MISMATCH' });
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: true });
    store.accounts.set(OTHER, { email: 'other@example.com', verified: true });
    await expect(invitations.accept(accept({ accountId: OTHER }))).rejects.toMatchObject({ code: 'EMAIL_MISMATCH' });
    await expect(invitations.accept(accept({ consentCollection: false }))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(invitations.accept(accept({ consentProvision: false }))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(invitations.accept(accept({ consentVersion: 'old' }))).rejects.toMatchObject({ code: 'CONSENT_OUTDATED' });
    const r = await invitations.accept(accept());
    expect(r).toMatchObject({ assignmentId: 'a-1', eventId: EVENT, role: 'gate_staff', status: 'ASSIGNED' });
    expect(store.assignments.get('a-1')).toMatchObject({ accountId: ACCOUNT, status: 'ASSIGNED', consentVersion: STAFF_CONSENT_VERSION });
    expect(store.assignments.get('a-1')?.inviteEmail).toBeUndefined();
    expect(store.assignments.get('a-1')?.inviteTokenHash).toBeUndefined();
    await expect(store.hasAssigned(ACCOUNT)).resolves.toBe(true);
  });

  test('같은 회차에 이미 배정된 계정은 409이고, 같은 토큰 재수락은 410이다', async () => {
    await invitations.accept(accept());
    store.assignments.set('a-2', {
      id: 'a-2',
      accountId: null,
      status: 'INVITED',
      eventId: EVENT,
      role: 'gate_lead',
      inviteEmail: 'staff@example.com',
      inviteTokenHash: hash(TOKEN_2),
      inviteExpiresAtMs: NOW + HOUR,
      invitedBy: ADMIN,
      validFromMs: NOW - HOUR,
      validUntilMs: NOW + 2 * HOUR,
    });
    await expect(invitations.accept(accept({ inviteToken: TOKEN_2 }))).rejects.toMatchObject({ code: 'ASSIGNMENT_EXISTS' });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  test('거절은 EXPIRED로 끝내고 같은 토큰을 다시 보내도 결과가 같다', async () => {
    await invitations.reject(TOKEN);
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'EXPIRED' });
    expect(store.assignments.get('a-1')?.inviteTokenHash).toBeUndefined();
    await expect(invitations.reject(TOKEN)).resolves.toBeUndefined();
    await expect(invitations.lookup(TOKEN)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  test('내 배정 목록은 ASSIGNED·ENDED·REVOKED만 유효 시작 늦은 순으로 주고 커서로 나눈다', async () => {
    await invitations.accept(accept());
    store.assignments.set('a-2', {
      id: 'a-2',
      accountId: ACCOUNT,
      status: 'ENDED',
      eventId: EVENT_2,
      role: 'gate_lead',
      inviteExpiresAtMs: NOW,
      invitedBy: ADMIN,
      validFromMs: NOW + HOUR,
      validUntilMs: NOW + 2 * HOUR,
    });
    store.assignments.set('a-3', {
      id: 'a-3',
      accountId: ACCOUNT,
      status: 'INVITED',
      eventId: EVENT_2,
      role: 'gate_staff',
      inviteExpiresAtMs: NOW + HOUR,
      invitedBy: ADMIN,
      validFromMs: NOW + 2 * HOUR,
      validUntilMs: NOW + 3 * HOUR,
    });
    const first = await invitations.listSelf({ accountId: ACCOUNT, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ assignmentId: 'a-2', status: 'ENDED', activeScannerDeviceName: null });
    const second = await invitations.listSelf({ accountId: ACCOUNT, cursor: first.nextCursor, limit: 10 });
    expect(second.items.map((x) => x.assignmentId)).toEqual(['a-1']);
    await expect(invitations.listSelf({ accountId: ACCOUNT, limit: 101 })).rejects.toBeInstanceOf(StaffInvitationError);
  });
});
