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
let phoneStatus: 'VERIFIED' | 'UNVERIFIED' | 'UNAVAILABLE';
let phoneThrows: boolean;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  store = new MemoryStaffAssignmentStore();
  phoneStatus = 'VERIFIED';
  phoneThrows = false;
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
  invitations = new StaffInvitations(store, clock, {
    statusOf: async () => {
      if (phoneThrows) throw new Error('본인확인 저장소를 쓸 수 없다');
      return phoneStatus;
    },
  });
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
    // 제공자가 검증 표시를 주지 않은 이메일은 '검증 이메일 없음'이다(ADR-0362 결정 4, I-T91 ⑤)
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: false });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_UNVERIFIED' });
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
    await expect(store.hasAssigned(ACCOUNT, NOW)).resolves.toBe(true);
  });

  test('휴대폰 본인확인 전이거나 확인 저장소를 쓸 수 없으면 수락하지 않는다(C2-02)', async () => {
    phoneStatus = 'UNVERIFIED';
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'PHONE_UNVERIFIED' });
    phoneStatus = 'UNAVAILABLE';
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' });
    phoneThrows = true;
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' });
    const noPort = new StaffInvitations(store, clock);
    await expect(noPort.accept(accept())).rejects.toMatchObject({ code: 'PHONE_UNAVAILABLE' });
    phoneThrows = false;
    phoneStatus = 'VERIFIED';
    await expect(invitations.accept(accept())).resolves.toMatchObject({ assignmentId: 'a-1', status: 'ASSIGNED' });
  });

  test('휴대폰 본인확인은 초대받은 계정의 기록으로만 판정하고, 실패하면 초대를 소비하지 않는다(C2-02)', async () => {
    const seen: string[] = [];
    const bound = new StaffInvitations(store, clock, {
      statusOf: async (accountId) => {
        seen.push(accountId);
        return accountId === ACCOUNT ? 'VERIFIED' : 'UNVERIFIED';
      },
    });
    // 이메일이 같아도 다른 계정의 본인확인 기록으로 수락할 수 없다.
    store.accounts.set(OTHER, { email: 'staff@example.com', verified: true });
    await expect(bound.accept(accept({ accountId: OTHER }))).rejects.toMatchObject({ code: 'PHONE_UNVERIFIED' });
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'INVITED', accountId: null });
    await expect(bound.accept(accept())).resolves.toMatchObject({ assignmentId: 'a-1', status: 'ASSIGNED' });
    expect(seen).toEqual([OTHER, ACCOUNT]);
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

  test('I-T21 ⑫ 네이버만 연결한 계정(검증 이메일 없음)은 수락이 403이고, 검증된 같은 이메일 계정은 수락된다', async () => {
    // 네이버만 연결한 계정은 이메일 검증 표시가 없다(identity §2.1). 수락은 403 EMAIL_UNVERIFIED(staff-invitation-email-unverified)로 닫고
    // 배정을 남기지 않는다(ADR-0362 결정 4, I-T91 ⑤). 이메일 칸 자체가 없는 계정도 같다.
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: false });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    store.accounts.set(ACCOUNT, { verified: false });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'INVITED', accountId: null });
    expect(store.assignments.get('a-1')?.inviteEmail).toBe('staff@example.com');
    // 구글·카카오로 같은 이메일이 검증된 계정은 수락한다
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: true });
    await expect(invitations.accept(accept())).resolves.toMatchObject({ assignmentId: 'a-1', status: 'ASSIGNED' });
  });
});

describe('I-T91 ⑤ 초대 조회·수락의 서버 몫(BUILD_ORDER F-05-7, ADR-0362 결정 1·2·4)', () => {
  test('I-T91 ⑤ 검증 이메일 없는 계정은 EMAIL_UNVERIFIED, 다른 이메일은 EMAIL_MISMATCH이고 두 경우 모두 배정은 INVITED로 남는다', async () => {
    store.accounts.set(ACCOUNT, { email: 'staff@example.com', verified: false });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'INVITED', accountId: null, inviteEmail: 'staff@example.com', inviteTokenHash: hash(TOKEN) });
    store.accounts.set(ACCOUNT, { email: 'someone-else@example.com', verified: true });
    await expect(invitations.accept(accept())).rejects.toMatchObject({ code: 'EMAIL_MISMATCH' });
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'INVITED', accountId: null, inviteEmail: 'staff@example.com', inviteTokenHash: hash(TOKEN) });
    expect(store.assignments.get('a-1')?.consentVersion).toBeUndefined();
  });

  test('I-T91 ⑤ 조회 응답에 eventId가 있고 고지 원문은 04-ia §3 SCR-050 ③④의 항목 줄이며 판은 staff-2026-11-23이다', async () => {
    const v = await invitations.lookup(TOKEN);
    expect(v.eventId).toBe(EVENT);
    // 판과 문안은 정본 글을 그대로 적는다(코드 상수를 기대값으로 쓰지 않는다)
    expect(v.consents.consentVersion).toBe('staff-2026-11-23');
    expect(v.consents.collection.split('\n')).toEqual(['목적: 현장 검표 배정과 스캔 기록', '항목: 계정 ID·닉네임·역할·스캔 기록', '보유: 회차 종료 뒤 1년', '거부권과 불이익: 배정 불가']);
    expect(v.consents.provision.split('\n')).toEqual([
      '받는 자: 그 회차의 파트너',
      '목적: 현장 인력 관리',
      '항목: 닉네임·역할·수락 여부·스캔·예외 통과 건수',
      '보유: 회차가 끝나고 1년까지(배정 원장과 같다)',
      '거부권과 불이익: 배정 불가',
    ]);
  });

  test('I-T91 ⑤ 옛 판 staff-2026-11-13으로 보낸 수락은 CONSENT_OUTDATED이고 배정은 INVITED로 남으며, 새 판이면 수락된다', async () => {
    await expect(invitations.accept(accept({ consentVersion: 'staff-2026-11-13' }))).rejects.toMatchObject({ code: 'CONSENT_OUTDATED' });
    expect(store.assignments.get('a-1')).toMatchObject({ status: 'INVITED', accountId: null });
    await expect(invitations.accept(accept({ consentVersion: 'staff-2026-11-23' }))).resolves.toMatchObject({ assignmentId: 'a-1', status: 'ASSIGNED' });
    expect(store.assignments.get('a-1')).toMatchObject({ consentVersion: 'staff-2026-11-23' });
  });
});
