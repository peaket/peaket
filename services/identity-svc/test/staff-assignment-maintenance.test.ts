// 현장 스태프 배정 만료 정비·시간 필터·promoter 정본화 시험(BUILD_ORDER BAT-450C, GAT-210, C2-10·C2-11).
// 메모리 저장소와 fakeClock으로 경계(만료 정각·역할 유효 끝 정각)·멱등·개인정보 파기를 본다.
import { fakeClock, type Database } from '@peaket/platform';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { identityMaintenanceTasks } from '../src/maintenance-tasks.js';
import { MemoryStaffAssignmentStore, type MemoryStaffAssignmentRow } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { PartnerStaffInvitations } from '../src/modules/session/application/partner-staff-invitations.js';
import { StaffInvitations, STAFF_CONSENT_VERSION } from '../src/modules/session/application/staff-invitations.js';

const NOW = Date.parse('2026-11-22T05:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000c0001';
const EVENT_2 = '0190f3a1-7c2e-7a00-8000-0000000c0002';
const EVENT_3 = '0190f3a1-7c2e-7a00-8000-0000000c0003';
const EVENT_CREATE = '0190f3a1-7c2e-7a00-8000-0000000c0004';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000c0011';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000c0012';
const ADMIN = '0190f3a1-7c2e-7a00-8000-0000000c0013';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000c0014';
const TOKEN = 'maintenance-invite-token-1';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

let store: MemoryStaffAssignmentStore;
let clock: ReturnType<typeof fakeClock>;
let invitations: StaffInvitations;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  store = new MemoryStaffAssignmentStore(() => 'ACTIVE');
  store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: true, status: 'ACTIVE' });
  store.accounts.set(OTHER, { email: 'other@example.com', verified: true, status: 'ACTIVE' });
  invitations = new StaffInvitations(store, clock, { statusOf: async () => 'VERIFIED' });
});

const seed = (id: string, over: Partial<MemoryStaffAssignmentRow> = {}): void => {
  store.assignments.set(id, {
    id,
    accountId: null,
    status: 'INVITED',
    eventId: EVENT,
    role: 'gate_staff',
    promoterId: PROMOTER,
    inviteEmail: 'invited@example.com',
    inviteTokenHash: hash(TOKEN),
    inviteExpiresAtMs: NOW + HOUR,
    invitedBy: ADMIN,
    validFromMs: NOW - HOUR,
    validUntilMs: NOW + 2 * HOUR,
    ...over,
  });
};

const partnerWith = (token: string) => {
  const mail = { sent: [] as unknown[] };
  return {
    mail,
    partner: new PartnerStaffInvitations(
      store,
      clock,
      { find: async () => ({ promoterId: PROMOTER, startsAtMs: NOW + HOUR, endsAtMs: NOW + 2 * HOUR }) },
      { send: async (m) => { mail.sent.push(m); } },
      'https://peaket.example/staff/invitations',
      () => token,
    ),
  };
};

describe('배정 만료 정비·시간 필터 [BAT-450C]', () => {
  test('I-T87 ① 24시간이 지난 INVITED는 EXPIRED로 끝내고 이메일·토큰을 파기한다(경계·멱등) [ASVS v5.0.0-6.5.5] [ASVS v5.0.0-14.2.4]', async () => {
    seed('i-expired', { inviteExpiresAtMs: NOW, inviteEmail: 'a@example.com', inviteTokenHash: hash('tok-expired') });
    seed('i-edge', { inviteExpiresAtMs: NOW + 1, inviteEmail: 'b@example.com', inviteTokenHash: hash('tok-edge') });
    // 초대 만료 전이라도 역할 유효 끝이 지났으면 수락해도 쓸 수 없다
    seed('i-window-over', { inviteExpiresAtMs: NOW + 12 * HOUR, validUntilMs: NOW - 1, inviteEmail: 'c@example.com', inviteTokenHash: hash('tok-window') });

    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 2, assignments: 0 });
    expect(store.assignments.get('i-expired')).toMatchObject({ status: 'EXPIRED' });
    expect(store.assignments.get('i-expired')?.inviteEmail).toBeUndefined();
    expect(store.assignments.get('i-expired')?.inviteTokenHash).toBeUndefined();
    expect(store.assignments.get('i-edge')).toMatchObject({ status: 'INVITED', inviteEmail: 'b@example.com' });
    expect(store.assignments.get('i-window-over')).toMatchObject({ status: 'EXPIRED' });
    expect(store.assignments.get('i-window-over')?.inviteEmail).toBeUndefined();
    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 0 });
  });

  test('I-T87 ① 발급→24시간→정비→재사용 불가를 한 흐름으로 본다', async () => {
    const { partner, mail } = partnerWith('created-invite-token-00000000000000000000001');
    const made = await partner.create({ eventId: EVENT_CREATE, tenantId: PROMOTER, accountId: ADMIN, invitations: [{ email: 'new@example.com', role: 'gate_staff' }] });
    expect(made).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    const id = made[0]!.assignmentId;
    expect(store.assignments.get(id)).toMatchObject({ status: 'INVITED', inviteExpiresAtMs: NOW + DAY });

    clock.advance(DAY + 1);
    await expect(invitations.lookup('created-invite-token-00000000000000000000001')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(store.expireDueAssignments(clock.now())).resolves.toEqual({ invitations: 1, assignments: 0 });
    expect(store.assignments.get(id)).toMatchObject({ status: 'EXPIRED' });
    expect(store.assignments.get(id)?.inviteEmail).toBeUndefined();
    // 정비가 이메일을 파기한 뒤에는 같은 배정을 재발송할 수 없다(새 초대를 만든다)
    await expect(store.reissueInvitation({ assignmentId: id, tokenHash: hash('new-token'), expiresAtMs: clock.now() + DAY })).resolves.toEqual({ result: 'ALREADY_ACCEPTED' });
  });

  test('I-T87 ② 역할 유효 끝이 지난 ASSIGNED는 ENDED로 끝내고 이메일·토큰을 파기한다(정각은 그대로·멱등)', async () => {
    seed('a-edge', { status: 'ASSIGNED', accountId: ACCOUNT, validUntilMs: NOW, inviteEmail: undefined, inviteTokenHash: undefined });
    seed('a-past', { status: 'ASSIGNED', accountId: OTHER, validUntilMs: NOW - 1, inviteEmail: 'p@example.com', inviteTokenHash: hash('tok-past') });
    seed('a-future', { status: 'ASSIGNED', accountId: OTHER, eventId: EVENT_2, validUntilMs: NOW + HOUR, inviteEmail: undefined, inviteTokenHash: undefined });

    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 1 });
    expect(store.assignments.get('a-edge')).toMatchObject({ status: 'ASSIGNED' });
    expect(store.assignments.get('a-past')).toMatchObject({ status: 'ENDED' });
    expect(store.assignments.get('a-past')?.inviteEmail).toBeUndefined();
    expect(store.assignments.get('a-past')?.inviteTokenHash).toBeUndefined();
    expect(store.assignments.get('a-future')).toMatchObject({ status: 'ASSIGNED' });
    await expect(store.hasAssigned(ACCOUNT, NOW)).resolves.toBe(false);
    await expect(store.expireDueAssignments(NOW)).resolves.toEqual({ invitations: 0, assignments: 0 });
  });

  test('I-T87 ③ hasAssigned는 지금 창 안의 ASSIGNED만 센다(미래·지난·취소 false, 시작·끝 정각 true) [ASVS v5.0.0-6.5.1]', async () => {
    const EDGE = '0190f3a1-7c2e-7a00-8000-0000000c0015';
    seed('current', { status: 'ASSIGNED', accountId: ACCOUNT, validFromMs: NOW - 1, validUntilMs: NOW + 1 });
    seed('future', { status: 'ASSIGNED', accountId: OTHER, eventId: EVENT_2, validFromMs: NOW + 1, validUntilMs: NOW + HOUR });
    seed('past', { status: 'ASSIGNED', accountId: OTHER, eventId: EVENT_3, validFromMs: NOW - 2 * HOUR, validUntilMs: NOW - 1 });
    seed('revoked', { status: 'REVOKED', accountId: OTHER, eventId: EVENT, validFromMs: NOW - HOUR, validUntilMs: NOW + HOUR });

    await expect(store.hasAssigned(ACCOUNT, NOW)).resolves.toBe(true);
    // 미래 배정·지난 배정·취소 배정은 지금 세지 않는다
    await expect(store.hasAssigned(OTHER, NOW)).resolves.toBe(false);
    // 미래 배정은 시작 시각부터 센다
    await expect(store.hasAssigned(OTHER, NOW + 1)).resolves.toBe(true);
    // 시작·끝 정각은 창 안이다(valid_from <= now <= valid_until)
    seed('edge', { status: 'ASSIGNED', accountId: EDGE, validFromMs: NOW, validUntilMs: NOW });
    await expect(store.hasAssigned(EDGE, NOW)).resolves.toBe(true);
  });

  test('I-T87 ④ listSelf·명단은 정비 전에도 지난 ASSIGNED를 ENDED로 보이고, 역할 유효 끝이 지난 초대는 410이다', async () => {
    seed('a-past', { status: 'ASSIGNED', accountId: ACCOUNT, validUntilMs: NOW - 1, inviteEmail: undefined, inviteTokenHash: undefined });
    const self = await invitations.listSelf({ accountId: ACCOUNT, limit: 10 });
    expect(self.items).toHaveLength(1);
    expect(self.items[0]).toMatchObject({ assignmentId: 'a-past', status: 'ENDED' });
    expect(store.assignments.get('a-past')).toMatchObject({ status: 'ASSIGNED' });

    const page = await store.listByEvent({ eventId: EVENT, limit: 10, nowMs: NOW });
    expect(page.items.find((x) => x.assignmentId === 'a-past')).toMatchObject({ status: 'ENDED' });

    seed('i-window-over', { inviteExpiresAtMs: NOW + 12 * HOUR, validUntilMs: NOW - 1, inviteEmail: 'late@example.com', inviteTokenHash: hash('tok-late') });
    await expect(invitations.lookup('tok-late')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await expect(
      invitations.accept({ inviteToken: 'tok-late', accountId: ACCOUNT, consentCollection: true, consentProvision: true, consentVersion: STAFF_CONSENT_VERSION }),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(store.assignments.get('i-window-over')).toMatchObject({ status: 'INVITED', accountId: null });
  });

  test('I-T88 ① promoter_id가 없는 옛 INVITED·ASSIGNED를 정본화해 끝내고 promoter가 있는 행은 그대로 둔다', async () => {
    seed('legacy-invite', { promoterId: undefined, inviteEmail: 'legacy@example.com', inviteTokenHash: hash('tok-legacy') });
    seed('legacy-assigned', { status: 'ASSIGNED', accountId: ACCOUNT, eventId: EVENT_2, promoterId: undefined, inviteEmail: 'legacy2@example.com', inviteTokenHash: hash('tok-legacy2') });
    seed('legacy-revoked', { status: 'REVOKED', promoterId: undefined });
    seed('kept-invite', { inviteEmail: 'kept@example.com', inviteTokenHash: hash('tok-kept') });
    seed('kept-assigned', { status: 'ASSIGNED', accountId: OTHER, eventId: EVENT_3 });

    await expect(store.closeLegacyAssignments()).resolves.toEqual({ invitations: 1, assignments: 1 });
    expect(store.assignments.get('legacy-invite')).toMatchObject({ status: 'EXPIRED' });
    expect(store.assignments.get('legacy-invite')?.inviteEmail).toBeUndefined();
    expect(store.assignments.get('legacy-invite')?.inviteTokenHash).toBeUndefined();
    expect(store.assignments.get('legacy-assigned')).toMatchObject({ status: 'ENDED' });
    expect(store.assignments.get('legacy-assigned')?.inviteEmail).toBeUndefined();
    expect(store.assignments.get('legacy-revoked')).toMatchObject({ status: 'REVOKED' });
    expect(store.assignments.get('kept-invite')).toMatchObject({ status: 'INVITED' });
    expect(store.assignments.get('kept-assigned')).toMatchObject({ status: 'ASSIGNED' });
    await expect(store.closeLegacyAssignments()).resolves.toEqual({ invitations: 0, assignments: 0 });
  });

  test('정비 일 목록에 staff-assignment-expired·staff-promoter-missing이 있다', () => {
    const names = identityMaintenanceTasks({} as Database, clock).map((x) => x.name);
    expect(names).toContain('staff-assignment-expired');
    expect(names).toContain('staff-promoter-missing');
  });
});
