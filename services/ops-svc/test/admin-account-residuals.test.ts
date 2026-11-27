// BAT-045 리뷰가 남긴 관리 계정 결함의 재현 시험(F-09-6, BOT-152).
// RV-12(없는 파트너사 초대), RV-17(역할 변경 멱등키), RV-11c(승인 감사 요청자)를 본다.
// 계약·경로는 openapi 그대로이고 새 경로·type을 만들지 않는다. Docker·kind는 쓰지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-27T02:00:00.000Z');
const PROMOTER = '0194b045-0000-7000-8000-00000000f101';
const clock = fakeClock({ now: NOW });
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const kit = reauthKit(() => clock.now());
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;
const newId = () => `0194b045-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

/** 구현이 더할 파트너사 조회 포트의 시험 대역. exists=null이면 장애, true/false면 그 답 */
const promoters: { answer: boolean | 'throw'; calls: string[] } = { answer: true, calls: [] };
const promoterDirectory = {
  async exists(id: string) {
    promoters.calls.push(id);
    if (promoters.answer === 'throw') throw new Error('core promoter down');
    return promoters.answer;
  },
};

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-admin-residuals',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      adminAccounts: { identity: admin, reauth: kit.verifier, promoters: promoterDirectory } as never,
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const token = (who: Record<string, string>, act: 'PERMISSION_CHANGE' | 'APPROVAL' = 'PERMISSION_CHANGE') =>
  kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act });
const send = (method: 'POST' | 'PUT' | 'GET', url: string, who: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  svc.http.inject({
    method,
    url,
    headers: { ...who, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const typeOf = (r: { payload: string }) => String(json(r).type ?? '');
const auditOf = (type: string, status: string) => audit.entries.filter((e) => e.recordType === type && e.record.payload.status === status);

describe('BAT-045 남은 관리 계정 결함(F-09-6)', () => {
  test('BOT-152 ⑪ 없는 파트너사 promoterId 초대는 identity를 부르기 전에 422 unknown-promoter이고 감사 기록이 0건이다', async () => {
    const operator = identity.ops('operator');
    admin.actor(operator['x-user-id']!, 'operator');
    const before = { invite: admin.callsOf('invite'), audit: audit.entries.length };
    promoters.answer = false;
    promoters.calls.length = 0;
    const r = await send('POST', '/v1/ops/admin-accounts', operator, { email: 'unknown-promoter@stella.example', displayName: '담당자', role: 'partner_admin', promoterId: PROMOTER }, {
      'idempotency-key': randomUUID(),
      'x-reauth-token': token(operator),
    });
    expect(r.statusCode, r.payload).toBe(422);
    expect(typeOf(r)).toMatch(/unknown-promoter$/);
    expect(promoters.calls).toEqual([PROMOTER]);
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(audit.entries).toHaveLength(before.audit);
  });

  test('BOT-152 ⑭ 파트너사 조회가 503이면 초대는 503 promoter-directory-unavailable이고 identity·감사 0이다', async () => {
    const operator = identity.ops('operator');
    admin.actor(operator['x-user-id']!, 'operator');
    const before = { invite: admin.callsOf('invite'), audit: audit.entries.length };
    promoters.answer = 'throw';
    promoters.calls.length = 0;
    const r = await send('POST', '/v1/ops/admin-accounts', operator, { email: 'promoter-down@stella.example', displayName: '담당자', role: 'partner_admin', promoterId: PROMOTER }, {
      'idempotency-key': randomUUID(),
      'x-reauth-token': token(operator),
    });
    expect(r.statusCode, r.payload).toBe(503);
    expect(typeOf(r)).toMatch(/promoter-directory-unavailable$/);
    expect(r.headers['retry-after']).toBeTruthy();
    expect(promoters.calls).toEqual([PROMOTER]);
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(audit.entries).toHaveLength(before.audit);
  });

  test('BOT-152 ⑪b 파트너사가 있으면 초대는 201이고 identity·감사 SUCCEEDED가 1회다', async () => {
    const operator = identity.ops('operator');
    admin.actor(operator['x-user-id']!, 'operator');
    promoters.answer = true;
    promoters.calls.length = 0;
    const before = { invite: admin.callsOf('invite'), audit: auditOf('ADMIN_ACCOUNT_INVITED', 'SUCCEEDED').length };
    const r = await send('POST', '/v1/ops/admin-accounts', operator, { email: 'known-promoter@stella.example', displayName: '담당자', role: 'partner_admin', promoterId: PROMOTER }, {
      'idempotency-key': randomUUID(),
      'x-reauth-token': token(operator),
    });
    expect(r.statusCode, r.payload).toBe(201);
    expect(promoters.calls).toEqual([PROMOTER]);
    expect(admin.callsOf('invite')).toBe(before.invite + 1);
    expect(auditOf('ADMIN_ACCOUNT_INVITED', 'SUCCEEDED')).toHaveLength(before.audit + 1);
  });

  test('BOT-152 ⑫ 같은 Idempotency-Key의 역할 변경 재전송은 identity 호출·감사 SUCCEEDED가 1회이고 다른 본문은 422다', async () => {
    const commander = identity.ops('commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'viewer', status: 'ACTIVE', version: 1 });
    const key = randomUUID();
    const before = {
      change: admin.callsOf('changeRole'),
      succeeded: auditOf('ADMIN_ACCOUNT_ROLE_CHANGED', 'SUCCEEDED').length,
      requested: auditOf('ADMIN_ACCOUNT_ROLE_CHANGED', 'REQUESTED').length,
    };
    const body = { role: 'operator', reason: '운영 담당 승진' };
    const first = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, commander, body, { 'if-match': '"1"', 'idempotency-key': key, 'x-reauth-token': token(commander) });
    expect(first.statusCode, first.payload).toBe(200);
    expect(json(first)).toMatchObject({ adminAccountId: target, role: 'operator', version: 2 });
    const replay = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, commander, body, { 'if-match': '"2"', 'idempotency-key': key, 'x-reauth-token': token(commander) });
    expect(replay.statusCode, replay.payload).toBe(200);
    expect(json(replay)).toEqual(json(first));
    expect(admin.callsOf('changeRole')).toBe(before.change + 1);
    expect(auditOf('ADMIN_ACCOUNT_ROLE_CHANGED', 'SUCCEEDED')).toHaveLength(before.succeeded + 1);
    expect(auditOf('ADMIN_ACCOUNT_ROLE_CHANGED', 'REQUESTED')).toHaveLength(before.requested + 1);

    const diff = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, commander, { role: 'cs_agent', reason: '다른 요청' }, { 'if-match': '"2"', 'idempotency-key': key, 'x-reauth-token': token(commander) });
    expect(diff.statusCode, diff.payload).toBe(422);
    expect(typeOf(diff)).toMatch(/idempotency-key-reused$/);
    expect(admin.callsOf('changeRole')).toBe(before.change + 1);

    // commander 분기: 승인 업무도 같은 키 재전송에서 하나여야 한다(RV096-04)
    const cTarget = newId();
    admin.seed({ adminAccountId: cTarget, role: 'operator', status: 'ACTIVE', version: 1 });
    const cKey = randomUUID();
    const cBody = { role: 'commander', reason: '관제 책임자 승진' };
    const cBefore = { change: admin.callsOf('changeRole'), requested: audit.entries.filter((e) => e.recordId === cTarget && e.recordType === 'ADMIN_ACCOUNT_ROLE_CHANGED' && e.record.payload.status === 'REQUESTED').length };
    const c1 = await send('PUT', `/v1/ops/admin-accounts/${cTarget}/role`, commander, cBody, { 'if-match': '"1"', 'idempotency-key': cKey, 'x-reauth-token': token(commander) });
    expect(c1.statusCode, c1.payload).toBe(202);
    const cApprovalId = String(json(c1).approvalId);
    expect(cApprovalId).toBeTruthy();
    const c2 = await send('PUT', `/v1/ops/admin-accounts/${cTarget}/role`, commander, cBody, { 'if-match': '"1"', 'idempotency-key': cKey, 'x-reauth-token': token(commander) });
    expect(c2.statusCode, c2.payload).toBe(202);
    expect(json(c2).approvalId).toBe(cApprovalId);
    expect(admin.callsOf('changeRole')).toBe(cBefore.change);
    expect(audit.entries.filter((e) => e.recordId === cTarget && e.recordType === 'ADMIN_ACCOUNT_ROLE_CHANGED' && e.record.payload.status === 'REQUESTED')).toHaveLength(cBefore.requested + 1);
    const cDiff = await send('PUT', `/v1/ops/admin-accounts/${cTarget}/role`, commander, { role: 'commander', reason: '다른 요청' }, { 'if-match': '"1"', 'idempotency-key': cKey, 'x-reauth-token': token(commander) });
    expect(cDiff.statusCode, cDiff.payload).toBe(422);
    expect(typeOf(cDiff)).toMatch(/idempotency-key-reused$/);
    expect(admin.callsOf('changeRole')).toBe(cBefore.change);

    // 승인 뒤 같은 키·본문 재전송도 승인 업무를 새로 만들지 않는다
    const cApprover = identity.ops('commander');
    admin.actor(cApprover['x-user-id']!, 'commander');
    const cApproved = await send('POST', `/v1/ops/approval-requests/${cApprovalId}/approvals`, cApprover, {}, { 'x-reauth-token': token(cApprover, 'APPROVAL') });
    expect(cApproved.statusCode, cApproved.payload).toBe(200);
    expect(admin.callsOf('changeRole')).toBe(cBefore.change + 1);
    const cAfter = await send('PUT', `/v1/ops/admin-accounts/${cTarget}/role`, commander, cBody, { 'if-match': '"2"', 'idempotency-key': cKey, 'x-reauth-token': token(commander) });
    expect(cAfter.statusCode, cAfter.payload).toBe(202);
    expect(json(cAfter).approvalId).toBe(cApprovalId);
    expect(admin.callsOf('changeRole')).toBe(cBefore.change + 1);
  });

  test('BOT-152 ⑬ commander 역할 변경 승인 감사에는 요청자와 승인자가 모두 남는다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    admin.actor(requester['x-user-id']!, 'commander');
    admin.actor(approver['x-user-id']!, 'commander');
    const target = newId();
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE', version: 1 });
    const created = await send('PUT', `/v1/ops/admin-accounts/${target}/role`, requester, { role: 'commander', reason: '관제 책임자 승진' }, {
      'if-match': '"1"',
      'idempotency-key': randomUUID(),
      'x-reauth-token': token(requester),
    });
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = String(json(created).approvalId);
    expect(approvalId).toBeTruthy();
    const approved = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, approver, {}, { 'x-reauth-token': token(approver, 'APPROVAL') });
    expect(approved.statusCode, approved.payload).toBe(200);
    const succeeded = audit.entries.filter((e) => e.recordId === target && e.recordType === 'ADMIN_ACCOUNT_ROLE_CHANGED' && e.record.payload.status === 'SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.record.payload).toMatchObject({
      action: 'ROLE_CHANGED',
      approvalId,
      requestedBy: requester['x-user-id'],
      actorAdminAccountId: approver['x-user-id'],
    });
    // 권한 변경 내역에도 요청자가 보인다(있으면). 없으면 감사 기록만 본다
    const changes = await send('GET', `/v1/ops/admin-accounts/${target}/permission-changes`, requester);
    expect(changes.statusCode, changes.payload).toBe(200);
    const item = (json(changes).items as Record<string, unknown>[])[0];
    expect(item).toMatchObject({ action: 'ROLE_CHANGED', approvalId, actorAdminAccountId: approver['x-user-id'] });
  });
});
