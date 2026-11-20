// 관리 계정 REST의 권한 판정(AZ-T14 ①②③④, C-T69, I-T61 ④, ASVS 8.2.1·8.2.2·8.2.3, BUILD_ORDER BOT-152, ADR-0322).
// - viewer·CS 세 역할은 목록·상세·초대·역할·재초대·삭제·지정·세션·권한 내역이 모두 403이고 대상·감사가 바뀌지 않는다.
// - operator는 파트너 계정만 다루고 관제·CS 계정은 403 admin-role-not-allowed다(파트너 계정 같은 호출은 통과).
// - 자기 지정 403 self-target-forbidden, 지정 없는 operator 지정 422 designation-target-not-commander.
// - identity가 DESIGNATION_CONFLICT(409)·DESIGNATION_TARGET_NOT_ELIGIBLE(422)을 주면 Problem으로 바꾸고 감사 FAILED 1, 성공 내역 0.
// - 세션 강제 종료는 operator·commander만 204이고 viewer는 403이며 identity 호출이 0이다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T07:00:00.000Z');
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;
const newId = () => `0194b045-0000-7000-8000-${String(900000 + ++seq).padStart(12, '0')}`;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: audit, adminAccounts: { identity: admin, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) =>
  svc.http.inject({ method, url, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const token = (who: Record<string, string>) => kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'PERMISSION_CHANGE' });
const withToken = (who: Record<string, string>, extra: Record<string, string> = {}) => ({ ...who, 'x-reauth-token': token(who), ...extra });
const typeOf = (r: { payload: string }) => String(json(r).type ?? '');

describe('관리 계정 REST 권한(AZ-T14)', () => {
  test('AZ-T14 ① [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.3] viewer·cs_agent·cs_lead는 목록·상세·초대·역할·재초대·삭제·지정·세션·권한 내역이 모두 403이고 대상·감사가 바뀌지 않는다', async () => {
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'viewer', status: 'ACTIVE' });
    const targetBefore = JSON.stringify(await admin.get(target));
    for (const role of ['viewer', 'cs_agent', 'cs_lead'] as const) {
      const who = identity.ops(role);
      // 내 세션 정보 시험을 위해 그 호출자 계정을 identity 대역에 둔다(ops-svc가 계정을 읽는다)
      admin.seed({ adminAccountId: who['x-user-id']!, role, status: 'ACTIVE' });
      const before = audit.entries.length;
      const calls = admin.calls.length;
      const attempts: Array<[string, Promise<{ statusCode: number }>]> = [
        ['목록', send('GET', '/v1/ops/admin-accounts?group=OPS', who)],
        ['상세', send('GET', `/v1/ops/admin-accounts/${target}`, who)],
        ['초대', send('POST', '/v1/ops/admin-accounts', who, { email: 'x@stella.example', displayName: '새 담당자', role: 'partner_admin', promoterId: 'p' })],
        ['역할', send('PUT', `/v1/ops/admin-accounts/${target}/role`, { ...who, 'if-match': '"1"' }, { role: 'operator', reason: '승진' })],
        ['재초대', send('POST', `/v1/ops/admin-accounts/${target}/invitation`, who, { reasonCode: 'RESEND', reason: '재발송' })],
        ['삭제', send('POST', `/v1/ops/admin-accounts/${target}/removal`, who, { reason: '퇴사' })],
        ['지정', send('POST', `/v1/ops/admin-accounts/${target}/designations`, who, { kind: 'ACCESS_REVIEWER', basis: '지정서' })],
        ['지정 거두기', send('DELETE', `/v1/ops/admin-accounts/${target}/designations/ACCESS_REVIEWER`, who)],
        ['세션 전체 종료', send('DELETE', `/v1/ops/admin-accounts/${target}/sessions`, who)],
        ['세션 하나 종료', send('DELETE', `/v1/ops/admin-accounts/${target}/sessions/sess-1`, who)],
        ['권한 내역', send('GET', `/v1/ops/admin-accounts/${target}/permission-changes`, who)],
      ];
      for (const [label, p] of attempts) expect((await p).statusCode, `${role} ${label}`).toBe(403);
      expect(admin.calls.length, `${role}: identity를 불렀다`).toBe(calls);
      expect(audit.entries.length, `${role}: 감사 기록을 썼다`).toBe(before);
      // 내 세션 정보는 viewer·CS도 볼 수 있다(콘솔 메뉴용, 예외)
      expect((await send('GET', '/v1/ops/auth/sessions/me', who)).statusCode, `${role} 내 세션`).toBe(200);
    }
    expect(JSON.stringify(await admin.get(target))).toBe(targetBefore);
    // 응답 필드: 이메일 원문·세션 IP를 싣지 않고 가린 이메일만 준다(필드 수준 접근, 8.2.3)
    const detail = await send('GET', `/v1/ops/admin-accounts/${target}`, identity.ops('operator'));
    expect(detail.statusCode).toBe(200);
    expect(json(detail)).toHaveProperty('emailMasked');
    expect(json(detail)).not.toHaveProperty('email');
    for (const s of json(detail).sessions as Array<Record<string, unknown>>) {
      expect(s).not.toHaveProperty('ip');
      expect(s).not.toHaveProperty('remoteIp');
    }
  });

  test('AZ-T14 ② [ASVS v5.0.0-8.2.2] operator는 관제·CS 계정의 초대·역할·재초대·삭제·지정이 403 admin-role-not-allowed이고 파트너 계정의 같은 호출은 통과한다', async () => {
    const op = identity.ops('operator');
    admin.actor(op['x-user-id']!, 'operator');
    const opsTarget = newId();
    admin.seed({ adminAccountId: opsTarget, role: 'viewer', status: 'ACTIVE' });
    // 초대(관제 역할)는 identity가 역할을 보고 거절한다(ops-svc는 본문 역할만 보고 판단할 수 없다)
    const invited = await send('POST', '/v1/ops/admin-accounts', withToken(op), { email: 'ops@peaket.example', displayName: '운영자', role: 'viewer' });
    expect(invited.statusCode).toBe(403);
    expect(typeOf(invited)).toMatch(/admin-role-not-allowed$/);
    // 역할·재초대·삭제는 ops-svc가 먼저 거른다(identity 쓰기 0)
    const before = { changeRole: admin.callsOf('changeRole'), reinvite: admin.callsOf('reinvite'), remove: admin.callsOf('remove') };
    const role = await send('PUT', `/v1/ops/admin-accounts/${opsTarget}/role`, withToken(op, { 'if-match': '"1"' }), { role: 'operator', reason: '승진' });
    expect(role.statusCode).toBe(403);
    expect(typeOf(role)).toMatch(/admin-role-not-allowed$/);
    const reinvite = await send('POST', `/v1/ops/admin-accounts/${opsTarget}/invitation`, withToken(op), { reasonCode: 'RESEND', reason: '재발송' });
    expect(reinvite.statusCode).toBe(403);
    expect(typeOf(reinvite)).toMatch(/admin-role-not-allowed$/);
    const removal = await send('POST', `/v1/ops/admin-accounts/${opsTarget}/removal`, withToken(op), { reason: '퇴사' });
    expect(removal.statusCode).toBe(403);
    expect(typeOf(removal)).toMatch(/admin-role-not-allowed$/);
    // 지정은 commander만(가드)
    expect((await send('POST', `/v1/ops/admin-accounts/${opsTarget}/designations`, withToken(op), { kind: 'ACCESS_REVIEWER', basis: '지정서' })).statusCode).toBe(403);
    expect(admin.callsOf('changeRole')).toBe(before.changeRole);
    expect(admin.callsOf('reinvite')).toBe(before.reinvite);
    expect(admin.callsOf('remove')).toBe(before.remove);

    // 파트너 계정: 같은 operator가 초대·역할·재초대·삭제를 할 수 있다
    const promoterId = '0194b045-0000-7000-8000-00000000f001';
    const created = await send('POST', '/v1/ops/admin-accounts', withToken(op), { email: 'lead@stella.example', displayName: '파트너 관리자', role: 'partner_admin', promoterId });
    expect(created.statusCode, created.payload).toBe(201);
    const partnerId = json(created).adminAccountId as string;
    const changed = await send('PUT', `/v1/ops/admin-accounts/${partnerId}/role`, withToken(op, { 'if-match': '"1"' }), { role: 'partner_member', reason: '직무 변경' });
    expect(changed.statusCode, changed.payload).toBe(200);
    expect(json(changed)).toMatchObject({ role: 'partner_member', group: 'PARTNER' });
    const re = await send('POST', `/v1/ops/admin-accounts/${partnerId}/invitation`, withToken(op), { reasonCode: 'RESEND', reason: '재발송' });
    expect(re.statusCode, re.payload).toBe(200);
    const removed = await send('POST', `/v1/ops/admin-accounts/${partnerId}/removal`, withToken(op), { reason: '퇴사' });
    expect(removed.statusCode, removed.payload).toBe(200);
    expect(json(removed)).toMatchObject({ status: 'REMOVED' });
  });

  test('AZ-T14 ③ [ASVS v5.0.0-8.2.2] commander가 자기에게 지정하면 403 self-target-forbidden이고, 지정 없는 operator에게 지정하면 422 designation-target-not-commander다', async () => {
    const commander = identity.ops('commander');
    admin.actor(commander['x-user-id']!, 'commander');
    admin.seed({ adminAccountId: commander['x-user-id']!, role: 'commander', status: 'ACTIVE' });
    const self = await send('POST', `/v1/ops/admin-accounts/${commander['x-user-id']!}/designations`, withToken(commander), { kind: 'ACCESS_REVIEWER', basis: '지정서' });
    expect(self.statusCode).toBe(403);
    expect(typeOf(self)).toMatch(/self-target-forbidden$/);
    const operator = newId();
    admin.seed({ adminAccountId: operator, role: 'operator', status: 'ACTIVE' });
    const notCommander = await send('POST', `/v1/ops/admin-accounts/${operator}/designations`, withToken(commander), { kind: 'ACCESS_REVIEWER', basis: '지정서' });
    expect(notCommander.statusCode).toBe(422);
    expect(typeOf(notCommander)).toMatch(/designation-target-not-commander$/);
  });

  test('C-T69 [ASVS v5.0.0-8.2.1] identity가 DESIGNATION_CONFLICT(409)·DESIGNATION_TARGET_NOT_ELIGIBLE(422)을 주면 그 Problem으로 바꾸고 감사 FAILED 1, 성공 내역 0이다', async () => {
    const commander = identity.ops('commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'commander', status: 'ACTIVE' });
    const before = audit.entries.filter((e) => e.recordId === target).length;
    admin.fail = { method: 'designate', problem: new AdminAccountProblem('designation-conflict', 409, '함께 둘 수 없는 지정이 있습니다') };
    const conflict = await send('POST', `/v1/ops/admin-accounts/${target}/designations`, withToken(commander), { kind: 'FRAUD_INVESTIGATOR', basis: '조사관 지정서' });
    expect(conflict.statusCode).toBe(409);
    expect(typeOf(conflict)).toMatch(/designation-conflict$/);
    admin.fail = { method: 'designate', problem: new AdminAccountProblem('designation-target-not-eligible', 422, '그 역할은 이 지정을 받을 수 없습니다') };
    const notEligible = await send('POST', `/v1/ops/admin-accounts/${target}/designations`, withToken(commander), { kind: 'PSEUDONYM_HANDLER', basis: '가명 취급 지정서' });
    expect(notEligible.statusCode).toBe(422);
    expect(typeOf(notEligible)).toMatch(/designation-target-not-eligible$/);
    const entries = audit.entries.filter((e) => e.recordId === target);
    expect(entries).toHaveLength(before + 4);
    expect(entries.slice(before).map((e) => e.record.payload.status)).toEqual(['REQUESTED', 'FAILED', 'REQUESTED', 'FAILED']);
    const changes = await send('GET', `/v1/ops/admin-accounts/${target}/permission-changes`, commander);
    expect(changes.statusCode).toBe(200);
    expect(json(changes).items).toEqual([]);
  });

  test('I-T61 ④ [ASVS v5.0.0-7.4.5] viewer가 세션 강제 종료를 부르면 403이고 identity 호출 0이며, operator·commander는 204다', async () => {
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'viewer', status: 'ACTIVE' });
    const viewer = identity.ops('viewer');
    const calls = admin.callsOf('terminateSessions');
    expect((await send('DELETE', `/v1/ops/admin-accounts/${target}/sessions`, viewer)).statusCode).toBe(403);
    expect((await send('DELETE', `/v1/ops/admin-accounts/${target}/sessions/sess-1`, viewer)).statusCode).toBe(403);
    expect(admin.callsOf('terminateSessions')).toBe(calls);
    const operator = identity.ops('operator');
    expect((await send('DELETE', `/v1/ops/admin-accounts/${target}/sessions`, operator)).statusCode).toBe(204);
    const commander = identity.ops('commander');
    expect((await send('DELETE', `/v1/ops/admin-accounts/${target}/sessions/sess-1`, commander)).statusCode).toBe(204);
    expect(admin.callsOf('terminateSessions')).toBe(calls + 2);
  });

  test('B14 [ASVS v5.0.0-8.2.1] commander 역할 변경은 202 승인 업무이고 요청자 본인 승인은 403, 다른 commander가 act=APPROVAL·패스키로 승인하면 identity ChangeAdminRole(approval_id)과 감사 SUCCEEDED가 남는다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    admin.actor(requester['x-user-id']!, 'commander');
    admin.actor(approver['x-user-id']!, 'commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    const created = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, withToken(requester, { 'if-match': '"1"' }), { role: 'commander', reason: '관제 책임자 승진' });
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = json(created).approvalId as string;
    expect(approvalId).toBeTruthy();
    expect(json(created)).toMatchObject({ kind: 'COMMANDER_ROLE_CHANGE', targetRef: target, status: 'PENDING_APPROVAL' });
    // 요청자 본인은 승인할 수 없다
    const before = admin.callsOf('changeRole');
    const self = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, { ...requester, 'x-reauth-token': kit.token({ accountId: requester['x-user-id']!, sessionId: requester['x-session-id']!, act: 'APPROVAL' }) });
    expect(self.statusCode).toBe(403);
    expect(typeOf(self)).toMatch(/approval-self-not-allowed$/);
    expect(admin.callsOf('changeRole')).toBe(before);
    // operator·cs_lead는 승인 역할이 아니다(가드가 먼저 403)
    expect((await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, { ...identity.ops('cs_lead'), 'x-reauth-token': 'x' })).statusCode).toBe(403);
    // 다른 commander가 패스키 재인증으로 승인한다
    const beforeApprove = admin.callsOf('changeRole');
    const approved = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, { ...approver, 'x-reauth-token': kit.token({ accountId: approver['x-user-id']!, sessionId: approver['x-session-id']!, act: 'APPROVAL' }) });
    expect(approved.statusCode, approved.payload).toBe(200);
    expect(json(approved)).toMatchObject({ status: 'DONE', approvals: [approver['x-user-id']] });
    expect(admin.callsOf('changeRole')).toBe(beforeApprove + 1);
    expect(admin.accounts.get(target)!.role).toBe('commander');
    const succeeded = audit.entries.filter((e) => e.recordId === target && e.record.payload.status === 'SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.record.payload).toMatchObject({ action: 'ROLE_CHANGED', approvalId, fromRole: 'operator', toRole: 'commander', actorAdminAccountId: approver['x-user-id'] });
    const changes = await send('GET', `/v1/ops/admin-accounts/${target}/permission-changes`, requester);
    expect(json(changes).items).toEqual([expect.objectContaining({ action: 'ROLE_CHANGED', approvalId, toRole: 'commander' })]);
  });

  test('B14 승인 기한(5영업일 [가정])이 지난 역할 변경 승인은 409이고 identity를 부르지 않는다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    admin.actor(requester['x-user-id']!, 'commander');
    admin.actor(approver['x-user-id']!, 'commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    const created = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, withToken(requester, { 'if-match': '"1"' }), { role: 'commander', reason: '기한 시험' });
    expect(created.statusCode, created.payload).toBe(202);
    clock.advance(8 * 24 * 60 * 60_000);
    const before = admin.callsOf('changeRole');
    const late = await send('POST', `/v1/ops/approval-requests/${json(created).approvalId as string}/approvals`, { ...approver, 'x-reauth-token': kit.token({ accountId: approver['x-user-id']!, sessionId: approver['x-session-id']!, act: 'APPROVAL' }) });
    expect(late.statusCode).toBe(409);
    expect(typeOf(late)).toMatch(/admin-account-state-conflict$/);
    expect(admin.callsOf('changeRole')).toBe(before);
  });

  test('AZ-T14 ① 목록·상세·권한 내역은 operator·commander가 볼 수 있고 commander 계정 삭제는 409 commander-removal-needs-role-change다', async () => {
    const commander = identity.ops('commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'commander', status: 'ACTIVE' });
    expect((await send('GET', '/v1/ops/admin-accounts?group=OPS', commander)).statusCode).toBe(200);
    const detail = await send('GET', `/v1/ops/admin-accounts/${target}`, commander);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    expect((await send('GET', `/v1/ops/admin-accounts/${target}/permission-changes`, commander)).statusCode).toBe(200);
    const removal = await send('POST', `/v1/ops/admin-accounts/${target}/removal`, withToken(commander), { reason: '퇴사' });
    expect(removal.statusCode).toBe(409);
    expect(typeOf(removal)).toMatch(/commander-removal-needs-role-change$/);
  });
});
