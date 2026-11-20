// RV-05·06·07: 관리 계정 REST의 리뷰 고침 회귀 시험(BOT-152, ADR-0322).
// RV-05 삭제한 계정을 다시 삭제하면 같은 200 계정 뷰이고 identity·감사를 더 쓰지 않는다(삭제된 commander도 먼저 이 갈래다).
// RV-06 identity 일시 장애로 FAILED가 된 승인은 같은 승인을 다시 승인해 다시 시도할 수 있다.
// RV-07 operator는 파트너 역할 밖을 초대하면 identity를 부르기 전에 403 admin-role-not-allowed이고 감사도 쓰지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T13:00:00.000Z');
const OPERATOR = '0194b045-0000-7000-8000-000000004001';
const COMMANDER = '0194b045-0000-7000-8000-000000004002';
const PROMOTER = '0194b045-0000-7000-8000-00000000f001';
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  admin.seed({ adminAccountId: OPERATOR, role: 'operator', status: 'ACTIVE' });
  admin.seed({ adminAccountId: COMMANDER, role: 'commander', status: 'ACTIVE' });
  admin.actor(OPERATOR, 'operator');
  admin.actor(COMMANDER, 'commander');
  identity.answers.set(`${OPERATOR}/${OPERATOR}-sess`, { valid: true, role: 'operator' });
  identity.answers.set(`${COMMANDER}/${COMMANDER}-sess`, { valid: true, role: 'commander' });
  svc = await createService({
    name: 'ops-svc-admin-regressions',
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

const who = (id: string) => ({ 'x-user-id': id, 'x-session-id': `${id}-sess`, 'x-user-aud': 'ops', 'x-user-scope': '' });
const token = (id: string, act: 'PERMISSION_CHANGE' | 'APPROVAL' = 'PERMISSION_CHANGE') => kit.token({ accountId: id, sessionId: `${id}-sess`, act });
const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, id: string, body?: unknown, act: 'PERMISSION_CHANGE' | 'APPROVAL' = 'PERMISSION_CHANGE') =>
  svc.http.inject({
    method,
    url,
    headers: {
      ...who(id),
      'idempotency-key': randomUUID(),
      ...(method === 'GET' ? {} : { 'x-reauth-token': token(id, act) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const typeOf = (r: { payload: string }) => String(json(r).type ?? '');

describe('RV-05·06·07 관리 계정 REST 고침', () => {
  test('RV-05 삭제한 계정을 다시 삭제하면 200 같은 계정 뷰이고 identity 삭제·감사 SUCCEEDED가 한 번이다', async () => {
    const target = '0194b045-0000-7000-8000-000000004011';
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    const first = await send('POST', `/v1/ops/admin-accounts/${target}/removal`, COMMANDER, { reason: '퇴사' });
    expect(first.statusCode, first.payload).toBe(200);
    expect(json(first)).toMatchObject({ status: 'REMOVED' });
    const before = { remove: admin.callsOf('remove'), audit: audit.entries.filter((e) => e.recordId === target && e.record.payload.status === 'SUCCEEDED').length };
    const again = await send('POST', `/v1/ops/admin-accounts/${target}/removal`, COMMANDER, { reason: '퇴사' });
    expect(again.statusCode, again.payload).toBe(200);
    expect(json(again)).toMatchObject({ adminAccountId: target, status: 'REMOVED' });
    expect(admin.callsOf('remove')).toBe(before.remove);
    expect(audit.entries.filter((e) => e.recordId === target && e.record.payload.status === 'SUCCEEDED')).toHaveLength(before.audit);
    // 삭제된 commander도 commander-removal-needs-role-change(409)가 아니라 200이다
    const gone = '0194b045-0000-7000-8000-000000004012';
    admin.seed({ adminAccountId: gone, role: 'commander', status: 'REMOVED' });
    const removedCommander = await send('POST', `/v1/ops/admin-accounts/${gone}/removal`, COMMANDER, { reason: '이미 지움' });
    expect(removedCommander.statusCode, removedCommander.payload).toBe(200);
  });

  test('RV-06 identity 일시 장애로 FAILED가 된 승인은 같은 승인을 다시 승인해 다시 시도할 수 있다', async () => {
    const target = '0194b045-0000-7000-8000-000000004021';
    const requester = '0194b045-0000-7000-8000-000000004022';
    const approver = '0194b045-0000-7000-8000-000000004023';
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    admin.seed({ adminAccountId: requester, role: 'commander', status: 'ACTIVE' });
    admin.seed({ adminAccountId: approver, role: 'commander', status: 'ACTIVE' });
    admin.actor(requester, 'commander');
    admin.actor(approver, 'commander');
    identity.answers.set(`${requester}/${requester}-sess`, { valid: true, role: 'commander' });
    identity.answers.set(`${approver}/${approver}-sess`, { valid: true, role: 'commander' });
    const created = await svc.http.inject({ method: 'PUT', url: `/v1/ops/admin-accounts/${target}/role`, headers: { ...who(requester), 'idempotency-key': randomUUID(), 'x-reauth-token': token(requester), 'if-match': '"1"', 'content-type': 'application/json' }, payload: JSON.stringify({ role: 'commander', reason: 'RV-06 시험' }) });
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = json(created).approvalId as string;
    admin.fail = { method: 'changeRole', problem: new AdminAccountProblem('admin-account-unavailable', 503, 'identity가 닿지 않는다', 1) };
    const first = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, approver, undefined, 'APPROVAL');
    expect(first.statusCode, first.payload).toBe(503);
    const retried = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, approver, undefined, 'APPROVAL');
    expect(retried.statusCode, retried.payload).toBe(200);
    expect(json(retried)).toMatchObject({ status: 'DONE', approvals: [approver] });
    expect(admin.accounts.get(target)!.role).toBe('commander');
  });

  test('RV-07 operator가 관제·CS 역할을 초대하면 identity를 부르기 전에 403 admin-role-not-allowed이고 감사도 쓰지 않는다', async () => {
    const before = { invite: admin.callsOf('invite'), audit: audit.entries.filter((e) => e.recordType === 'ADMIN_ACCOUNT_INVITED').length };
    for (const role of ['viewer', 'operator', 'cs_agent', 'cs_lead'] as const) {
      const r = await send('POST', '/v1/ops/admin-accounts', OPERATOR, { email: `rv07-${role}@peaket.example`, displayName: '초대 대상', role });
      expect(r.statusCode, `${role}: ${r.payload}`).toBe(403);
      expect(typeOf(r), role).toMatch(/admin-role-not-allowed$/);
    }
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(audit.entries.filter((e) => e.recordType === 'ADMIN_ACCOUNT_INVITED')).toHaveLength(before.audit);
    // 파트너 역할은 operator도 초대할 수 있다
    const partner = await send('POST', '/v1/ops/admin-accounts', OPERATOR, { email: 'rv07-partner@stella.example', displayName: '파트너 관리자', role: 'partner_admin', promoterId: PROMOTER });
    expect(partner.statusCode, partner.payload).toBe(201);
    expect(admin.callsOf('invite')).toBe(before.invite + 1);
  });
});
