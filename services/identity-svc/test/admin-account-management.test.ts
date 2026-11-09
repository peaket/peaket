// 관리 계정 관리 gRPC의 identity 쪽 규칙(docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150).
// 시험: I-T59·I-T60·I-T44의 identity 쪽(요청자 역할 다시 보기, 대상 규칙, 멱등, 초대 메일 링크, 재초대·삭제의 지우기, 세션 끝내기). 메모리 저장소로 본다.
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { AdminAccountInputError, AdminAccountNotFound, ManageAdminAccounts, maskAdminEmail } from '../src/modules/admin/application/manage-admin-accounts.js';
import { DispatchAdminNotices } from '../src/modules/admin/application/dispatch-admin-notices.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';

const M = 60_000;
const H = 60 * M;
const CMD = '0190f3a1-7c2e-7a00-8000-00000000f001';
const OPR = '0190f3a1-7c2e-7a00-8000-00000000f002';
const VIEW = '0190f3a1-7c2e-7a00-8000-00000000f003';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const OTHER_PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000bb';
let n = 0;
const rid = () => `req-${++n}`;

function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T12:00:00Z') });
  const store = new MemoryAdminAccountStore();
  store.create({ id: CMD, role: 'commander', email: 'cmd@peaket.example', status: 'ACTIVE', now: clock.now() });
  store.create({ id: OPR, role: 'operator', email: 'opr@peaket.example', status: 'ACTIVE', now: clock.now() });
  store.create({ id: VIEW, role: 'viewer', email: 'view@peaket.example', status: 'ACTIVE', now: clock.now() });
  const mailer = new MemoryAdminMailer();
  const manage = new ManageAdminAccounts(store, clock);
  const dispatch = new DispatchAdminNotices(store, mailer, { partner: 'https://partner.peaket.example', ops: 'https://console.peaket.example' }, DEFAULT_ADMIN_AUTH_CONFIG, clock);
  const invite = (actedBy: string, role: string, email: string, promoterId?: string) =>
    manage.invite({ requestId: rid(), actedBy, email, role: role as never, displayName: '담당자', ...(promoterId ? { promoterId } : {}) });
  return { clock, store, mailer, manage, dispatch, invite };
}

describe('초대(I-T59의 identity 쪽)', () => {
  test('I-T59①②_partner_admin이없는파트너사에partner_member는FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN이고_partner_admin초대는OK이며메일에24시간링크가가고DB에는SHA-256만있다', async () => {
    const t = harness();
    expect((await t.invite(OPR, 'partner_member', 'm1@stella.example', PROMOTER)).result).toBe('FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN');
    const ok = await t.invite(OPR, 'partner_admin', '  Lead@Stella.Example ', PROMOTER);
    expect(ok).toMatchObject({ result: 'OK', alreadyDone: false, account: { role: 'partner_admin', status: 'INVITED', group: 'PARTNER', promoterId: PROMOTER, emailMasked: 'le***@stella.example', displayName: '담당자', version: 1 } });
    // 초대 중인 partner_admin이 있으면 partner_member를 초대할 수 있다
    expect((await t.invite(OPR, 'partner_member', 'm1@stella.example', PROMOTER)).result).toBe('OK');
    expect(await t.dispatch.run()).toEqual({ done: 2, failed: 0 });
    const mail = t.mailer.sent.find((m) => m.to === 'lead@stella.example')!;
    expect(mail.kind).toBe('INVITATION');
    const token = /^https:\/\/partner\.peaket\.example\/invitation#token=([A-Za-z0-9_-]{43})$/.exec(mail.link!)![1]!;
    const row = t.store.peek(ok.account!.adminAccountId)!;
    expect(Buffer.from(row.inviteTokenHash!)).toEqual(createHash('sha256').update(token).digest());
    expect(row.inviteExpiresAt).toBe(t.clock.now() + 24 * H);
  });

  test('I-T59③④_operator의관제역할초대와commander초대는ROLE_NOT_ALLOWED이고_같은이메일은EMAIL_IN_USE이며_역할과파트너사가맞지않으면PROMOTER_MISMATCH다', async () => {
    const t = harness();
    expect((await t.invite(OPR, 'cs_agent', 'cs@peaket.example')).result).toBe('ROLE_NOT_ALLOWED');
    expect((await t.invite(CMD, 'commander', 'c2@peaket.example')).result).toBe('ROLE_NOT_ALLOWED');
    expect((await t.invite(VIEW, 'partner_admin', 'x@stella.example', PROMOTER)).result).toBe('ROLE_NOT_ALLOWED');
    expect((await t.invite(CMD, 'cs_agent', 'cs@peaket.example')).result).toBe('OK');
    expect((await t.invite(CMD, 'cs_lead', 'CS@peaket.example')).result).toBe('EMAIL_IN_USE');
    expect((await t.invite(CMD, 'viewer', 'v2@peaket.example', PROMOTER)).result).toBe('PROMOTER_MISMATCH');
    expect((await t.invite(OPR, 'partner_admin', 'x@stella.example')).result).toBe('PROMOTER_MISMATCH');
    // 관제 화면은 commander가 하던 일: 비활성 요청자는 다룰 수 없다
    t.store.remove(CMD);
    expect((await t.invite(CMD, 'cs_lead', 'cl@peaket.example')).result).toBe('ROLE_NOT_ALLOWED');
  });

  test('입력꼴이틀리면AdminAccountInputError(INVALID_ARGUMENT)다_이메일·표시이름', async () => {
    const t = harness();
    await expect(t.manage.invite({ requestId: rid(), actedBy: CMD, email: 'not-an-email', role: 'viewer', displayName: '이름' })).rejects.toBeInstanceOf(AdminAccountInputError);
    await expect(t.manage.invite({ requestId: rid(), actedBy: CMD, email: 'a@b.example', role: 'viewer', displayName: '‮\u0007' })).rejects.toBeInstanceOf(AdminAccountInputError);
    await expect(t.manage.invite({ requestId: rid(), actedBy: CMD, email: 'a@b.example', role: 'viewer', displayName: '가'.repeat(31) })).rejects.toBeInstanceOf(AdminAccountInputError);
    // 제어·양방향 문자를 지우고 NFC로 맞춘다
    const ok = await t.manage.invite({ requestId: rid(), actedBy: CMD, email: 'a@b.example', role: 'viewer', displayName: '‮한가 ' });
    expect(ok.account!.displayName).toBe('한가');
  });

  test('같은request_id는처리하지않고적은결과를already_done으로준다', async () => {
    const t = harness();
    const i = { requestId: 'same-1', actedBy: CMD, email: 'dup@peaket.example', role: 'viewer' as const, displayName: '중복' };
    const a = await t.manage.invite(i);
    const b = await t.manage.invite(i);
    expect(a).toMatchObject({ result: 'OK', alreadyDone: false });
    expect(b).toMatchObject({ result: 'OK', alreadyDone: true, account: { adminAccountId: a.account!.adminAccountId } });
    expect(t.store.allNotices().filter((x) => x.kind === 'INVITATION')).toHaveLength(1);
  });

  test('I-T59⑧_초대만료계정을RESEND로재초대하면새링크이고옛링크토큰은무효이며_만료된초대는보이는상태가INVITE_EXPIRED다', async () => {
    const t = harness();
    const a = (await t.invite(CMD, 'viewer', 'late@peaket.example')).account!;
    await t.dispatch.run();
    const first = t.store.peek(a.adminAccountId)!.inviteTokenHash;
    t.clock.advance(25 * H);
    expect((await t.manage.get(a.adminAccountId))!.account.status).toBe('INVITE_EXPIRED');
    expect(await t.store.expireInvites(t.clock.now())).toBe(1);
    expect(t.store.peek(a.adminAccountId)).toMatchObject({ status: 'INVITE_EXPIRED', inviteTokenHash: null });
    const r = await t.manage.reinvite({ requestId: rid(), actedBy: CMD, accountId: a.adminAccountId, reason: 'RESEND' });
    expect(r).toMatchObject({ result: 'OK', account: { status: 'INVITED', version: 2 } });
    await t.dispatch.run();
    expect(t.store.peek(a.adminAccountId)!.inviteTokenHash).not.toEqual(first);
    expect(t.mailer.sent.filter((m) => m.to === 'late@peaket.example')).toHaveLength(2);
    // 활성 계정에 RESEND는 STATE_CONFLICT
    expect((await t.manage.reinvite({ requestId: rid(), actedBy: CMD, accountId: OPR, reason: 'RESEND' })).result).toBe('STATE_CONFLICT');
  });
});

describe('재초대·삭제(I-T59⑥⑦, I-T60⑨⑩)', () => {
  test('I-T59⑥⑦_보호잠금계정은PROTECT_LOCK으로비밀번호·TOTP·복구코드·잠금을지우고INVITED로하며세션을끝내고_시간잠금만이면STATE_CONFLICT다', async () => {
    const t = harness();
    await t.store.setPassword({ id: OPR, phc: '$pbkdf2-sha256$i=1000,k=1$AA$AA', breachCheckedAt: t.clock.now(), now: t.clock.now() });
    await t.store.updateLoginState(OPR, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'TIMED', lockedUntil: t.clock.now() + 15 * M }, notices: [] }));
    expect((await t.manage.reinvite({ requestId: rid(), actedBy: CMD, accountId: OPR, reason: 'PROTECT_LOCK' })).result).toBe('STATE_CONFLICT');
    await t.store.updateLoginState(OPR, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT', lockReason: 'SECOND_FACTOR_FAILURES', failedAttempts: 3, secondFactorFailures: 5, passwordFailureTotal: 40 }, notices: [] }));
    await t.store.createSession({ id: '0190f3a1-7c2e-7a00-8000-00000000f0a1', accountId: OPR, aud: 'ops', refreshHash: Buffer.alloc(32, 1), refreshFamily: '0190f3a1-7c2e-7a00-8000-00000000f0a1', pairRef: 'p', createdAt: t.clock.now(), absoluteExpiresAt: t.clock.now() + 24 * H, idleExpiresAt: t.clock.now() + H }, 2);
    const r = await t.manage.reinvite({ requestId: rid(), actedBy: CMD, accountId: OPR, reason: 'PROTECT_LOCK' });
    expect(r).toMatchObject({ result: 'OK', account: { status: 'INVITED', lockKind: 'NONE', totpEnrolled: false } });
    expect(t.store.peek(OPR)).toMatchObject({ passwordPhc: null, totpSeedEnc: null, failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, lockKind: 'NONE', lockReason: null, passwordChangeRequired: false, breachCheckedAt: null });
    expect(t.store.terminatedEvents()).toContainEqual({ accountId: OPR, sessionId: '0190f3a1-7c2e-7a00-8000-00000000f0a1', reason: 'ADMIN_FORCE' });
    expect(t.store.notices(OPR)).toContain('INVITATION');
  });

  test('자기계정은SELF_TARGET이고_commander삭제는COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE이며_삭제는이메일·표시이름·인증수단을지우고세션을끝낸다', async () => {
    const t = harness();
    expect((await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: CMD })).result).toBe('SELF_TARGET');
    {
      const c2 = '0190f3a1-7c2e-7a00-8000-00000000f009';
      t.store.create({ id: c2, role: 'commander', email: 'c2@peaket.example', status: 'ACTIVE', now: t.clock.now() });
      expect((await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: c2 })).result).toBe('COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE');
    }
    await t.store.createSession({ id: '0190f3a1-7c2e-7a00-8000-00000000f0a2', accountId: VIEW, aud: 'ops', refreshHash: Buffer.alloc(32, 2), refreshFamily: '0190f3a1-7c2e-7a00-8000-00000000f0a2', pairRef: 'p', createdAt: t.clock.now(), absoluteExpiresAt: t.clock.now() + 24 * H, idleExpiresAt: t.clock.now() + H }, 2);
    await t.store.touchKnownSource(VIEW, 'p', t.clock.now());
    const r = await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: VIEW });
    expect(r).toMatchObject({ result: 'OK', account: { status: 'REMOVED', emailMasked: '', displayName: null, removedAt: t.clock.now() } });
    expect(t.store.peek(VIEW)).toMatchObject({ email: null, displayName: null, passwordPhc: null, totpSeedEnc: null, inviteTokenHash: null });
    expect(await t.store.isKnownSource(VIEW, 'p', 0)).toBe(false);
    expect(t.store.terminatedEvents()).toContainEqual({ accountId: VIEW, sessionId: '0190f3a1-7c2e-7a00-8000-00000000f0a2', reason: 'DELETE' });
    expect((await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: VIEW })).result).toBe('STATE_CONFLICT');
    // 지운 뒤 같은 이메일로 다시 초대할 수 있다
    expect((await t.invite(CMD, 'viewer', 'view@peaket.example')).result).toBe('OK');
  });
});

describe('역할 변경(I-T60, I-T44)', () => {
  test('I-T60①④·I-T44_파트너계정역할변경은세션을끝내고판을올리며_마지막활성partner_admin은낮추거나지우지못한다', async () => {
    const t = harness();
    const pa = '0190f3a1-7c2e-7a00-8000-00000000f010';
    const pm = '0190f3a1-7c2e-7a00-8000-00000000f011';
    t.store.create({ id: pa, role: 'partner_admin', email: 'pa@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    t.store.create({ id: pm, role: 'partner_member', email: 'pm@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: pa, role: 'partner_member', expectedVersion: 1 })).result).toBe('LAST_PARTNER_ADMIN');
    expect((await t.manage.remove({ requestId: rid(), actedBy: OPR, accountId: pa })).result).toBe('LAST_PARTNER_ADMIN');
    await t.store.createSession({ id: '0190f3a1-7c2e-7a00-8000-00000000f0a3', accountId: pm, aud: 'partner', refreshHash: Buffer.alloc(32, 3), refreshFamily: '0190f3a1-7c2e-7a00-8000-00000000f0a3', pairRef: 'p', createdAt: t.clock.now(), absoluteExpiresAt: t.clock.now() + 24 * H, idleExpiresAt: t.clock.now() + H }, 2);
    const up = await t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: pm, role: 'partner_admin', expectedVersion: 1 });
    expect(up).toMatchObject({ result: 'OK', account: { role: 'partner_admin', version: 2 } });
    expect(t.store.terminatedEvents()).toContainEqual({ accountId: pm, sessionId: '0190f3a1-7c2e-7a00-8000-00000000f0a3', reason: 'ROLE_CHANGED' });
    // 이제 관리자가 둘이라 하나는 낮출 수 있다
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: pa, role: 'partner_member', expectedVersion: 1 })).result).toBe('OK');
    // 다른 파트너사의 관리자는 셈에 들지 않는다
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000f012', role: 'partner_admin', email: 'o@other.example', status: 'ACTIVE', promoterId: OTHER_PROMOTER, now: t.clock.now() });
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: pm, role: 'partner_member', expectedVersion: 2 })).result).toBe('LAST_PARTNER_ADMIN');
  });

  test('I-T60②③⑤⑥⑧_operator의관제역할변경은ROLE_NOT_ALLOWED·자기역할은SELF_TARGET·옛판은VERSION_MISMATCH·commander는승인ID가있어야하고·역할묶음사이는ROLE_GROUP_MISMATCH다', async () => {
    const t = harness();
    const cs = '0190f3a1-7c2e-7a00-8000-00000000f020';
    t.store.create({ id: cs, role: 'cs_agent', email: 'cs@peaket.example', status: 'ACTIVE', now: t.clock.now() });
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: cs, role: 'cs_lead', expectedVersion: 1 })).result).toBe('ROLE_NOT_ALLOWED');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: CMD, role: 'operator', expectedVersion: 1 })).result).toBe('SELF_TARGET');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: cs, role: 'cs_lead', expectedVersion: 7 })).result).toBe('VERSION_MISMATCH');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: OPR, role: 'commander', expectedVersion: 1 })).result).toBe('APPROVAL_REQUIRED');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: OPR, role: 'commander', expectedVersion: 1, approvalId: 'appr-1' })).result).toBe('OK');
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: OPR, role: 'operator', expectedVersion: 2 })).result).toBe('APPROVAL_REQUIRED');
    const pm = '0190f3a1-7c2e-7a00-8000-00000000f021';
    t.store.create({ id: pm, role: 'partner_member', email: 'pm2@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    expect((await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: pm, role: 'operator', expectedVersion: 1 })).result).toBe('ROLE_GROUP_MISMATCH');
    // 같은 역할은 바꾸지 않고 OK(판 그대로)
    expect(await t.manage.changeRole({ requestId: rid(), actedBy: CMD, accountId: cs, role: 'cs_agent', expectedVersion: 1 })).toMatchObject({ result: 'OK', account: { version: 1 } });
  });
});

describe('보기', () => {
  test('목록은그룹·파트너사·보이는상태로거르고마지막접속이늦은순으로커서페이징하며_가린이메일만싣는다', async () => {
    const t = harness();
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000f030', role: 'partner_admin', email: 'a@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000f031', role: 'partner_member', email: 'bb@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000f032', role: 'partner_admin', email: 'ccc@other.example', status: 'ACTIVE', promoterId: OTHER_PROMOTER, now: t.clock.now() });
    await t.store.recordLoginSuccess('0190f3a1-7c2e-7a00-8000-00000000f031', t.clock.now());
    const page1 = await t.manage.list({ group: 'PARTNER', promoterId: PROMOTER, pageSize: 1 });
    // 앞부분이 2자 이하면 첫 자만 남긴다
    expect(page1.accounts.map((a) => a.emailMasked)).toEqual(['b***@stella.example']);
    const page2 = await t.manage.list({ group: 'PARTNER', promoterId: PROMOTER, pageSize: 1, pageToken: page1.nextPageToken! });
    expect(page2.accounts.map((a) => a.emailMasked)).toEqual(['a***@stella.example']);
    expect(page2.nextPageToken).toBeNull();
    expect((await t.manage.list({ group: 'OPS' })).accounts.map((a) => a.role).sort()).toEqual(['commander', 'operator', 'viewer']);
    expect(maskAdminEmail('op.kim@stella.example')).toBe('op***@stella.example');
  });
});

describe('재검토(2026-11-05)', () => {
  test('끝난시간잠금은보기에서잠김이아니다_지금걸린잠금만싣는다', async () => {
    const t = harness();
    await t.store.updateLoginState(OPR, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'TIMED', lockReason: 'FAILED_ATTEMPTS', lockedUntil: t.clock.now() + 15 * M }, notices: [] }));
    expect((await t.manage.get(OPR))!.account).toMatchObject({ lockKind: 'TIMED', lockReason: 'FAILED_ATTEMPTS', lockedUntil: t.clock.now() + 15 * M });
    t.clock.advance(16 * M);
    expect((await t.manage.get(OPR))!.account).toMatchObject({ lockKind: 'NONE', lockReason: null, lockedUntil: null });
  });

  test('같은request_id로다른종류나다른대상을부르면입력오류다', async () => {
    const t = harness();
    const cs = '0190f3a1-7c2e-7a00-8000-00000000f040';
    t.store.create({ id: cs, role: 'cs_agent', email: 'cs.rr@peaket.example', status: 'ACTIVE', now: t.clock.now() });
    expect((await t.manage.changeRole({ requestId: 'same-x', actedBy: CMD, accountId: cs, role: 'cs_lead', expectedVersion: 1 })).result).toBe('OK');
    await expect(t.manage.remove({ requestId: 'same-x', actedBy: CMD, accountId: VIEW })).rejects.toBeInstanceOf(AdminAccountInputError);
    await expect(t.manage.changeRole({ requestId: 'same-x', actedBy: CMD, accountId: VIEW, role: 'operator', expectedVersion: 1 })).rejects.toBeInstanceOf(AdminAccountInputError);
    expect(t.store.peek(VIEW)!.status).toBe('ACTIVE');
  });

  test('없는대상은NOT_FOUND(AdminAccountNotFound)이고멱등기록에남기지않는다', async () => {
    const t = harness();
    const ghost = '0190f3a1-7c2e-7a00-8000-00000000f0ff';
    for (const run of [
      () => t.manage.remove({ requestId: 'nf-1', actedBy: CMD, accountId: ghost }),
      () => t.manage.changeRole({ requestId: 'nf-2', actedBy: CMD, accountId: ghost, role: 'viewer', expectedVersion: 1 }),
      () => t.manage.reinvite({ requestId: 'nf-3', actedBy: CMD, accountId: ghost, reason: 'RESEND' }),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(AdminAccountNotFound);
    }
    // 기록하지 않았으므로 같은 request_id로 있는 계정에 부를 수 있다
    expect((await t.manage.remove({ requestId: 'nf-1', actedBy: CMD, accountId: VIEW })).result).toBe('OK');
  });

  test('메모리저장소도두partner_admin을동시에낮추면한사람은남는다(DB와같게차례로선다)', async () => {
    const t = harness();
    const a = '0190f3a1-7c2e-7a00-8000-00000000f050';
    const b = '0190f3a1-7c2e-7a00-8000-00000000f051';
    t.store.create({ id: a, role: 'partner_admin', email: 'p1.c@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    t.store.create({ id: b, role: 'partner_admin', email: 'p2.c@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: t.clock.now() });
    const both = await Promise.all([
      t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: a, role: 'partner_member', expectedVersion: 1 }),
      t.manage.changeRole({ requestId: rid(), actedBy: OPR, accountId: b, role: 'partner_member', expectedVersion: 1 }),
    ]);
    expect(both.map((r) => r.result).sort()).toEqual(['LAST_PARTNER_ADMIN', 'OK']);
  });

  test('지운계정은ID·역할·삭제시각만남는다_마지막접속·잠금·셈·유출대조·해제링크를지우고보기에서도마지막접속을싣지않는다', async () => {
    const t = harness();
    await t.store.recordLoginSuccess(VIEW, t.clock.now());
    await t.store.markBreachChecked(VIEW, t.clock.now(), false);
    await t.store.updateLoginState(VIEW, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'TIMED', lockReason: 'FAILED_ATTEMPTS', lockedUntil: t.clock.now() + 15 * M, failedAttempts: 5, recentLockAt: [t.clock.now()], lockedAt: t.clock.now() }, notices: [] }));
    await t.store.createUnlockLink({ id: '0190f3a1-7c2e-7a00-8000-00000000f0b1', accountId: VIEW, tokenHash: Buffer.alloc(32, 4), createdAt: t.clock.now(), expiresAt: t.clock.now() + 30 * M });
    const r = await t.manage.remove({ requestId: rid(), actedBy: CMD, accountId: VIEW });
    expect(r.account).toMatchObject({ lastLoginAt: null, lockKind: 'NONE' });
    expect(t.store.peek(VIEW)).toMatchObject({ lastLoginAt: null, breachCheckedAt: null, lockKind: 'NONE', lockReason: null, lockedUntil: null, lockedAt: null, recentLockAt: [], failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, passwordChangeRequired: false });
    expect(t.store.unlockLinks(VIEW)).toEqual([]);
  });
});

test('메모리저장소의관리트랜잭션이쓴뒤던지면그행을제자리에되돌리고Buffer칸은Buffer그대로다', async () => {
  const t = harness();
  t.store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000f060', role: 'viewer', email: 'rb@peaket.example', status: 'INVITED', now: t.clock.now() });
  await t.store.setInviteToken('0190f3a1-7c2e-7a00-8000-00000000f060', Buffer.alloc(32, 6), t.clock.now() + H, t.clock.now());
  await expect(
    t.store.manageTransaction(async (tx) => {
      await tx.setRole('0190f3a1-7c2e-7a00-8000-00000000f060', 'operator', t.clock.now());
      await tx.markRemoved('0190f3a1-7c2e-7a00-8000-00000000f060', t.clock.now());
      throw new Error('되돌린다');
    }),
  ).rejects.toThrow('되돌린다');
  const row = t.store.peek('0190f3a1-7c2e-7a00-8000-00000000f060')!;
  expect(row).toMatchObject({ role: 'viewer', status: 'INVITED', email: 'rb@peaket.example', version: 1 });
  expect((await t.store.getManaged('0190f3a1-7c2e-7a00-8000-00000000f060'))!.email).toBe('rb@peaket.example');
  // 행 객체를 갈아 끼우지 않고 제자리에 되돌린다(Buffer 칸이 Buffer로 남는다)
  expect(Buffer.isBuffer(t.store.rowForTest('0190f3a1-7c2e-7a00-8000-00000000f060')!.inviteTokenHash)).toBe(true);
});
