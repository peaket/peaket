// RV-03: commander 역할 변경 승인의 identity 오류(412·409)가 500이 아니라 그 Problem으로 나가고,
// identity가 성공한 뒤 저장이 낡은 판에 지더라도 역할 변경 감사(SUCCEEDED)를 잃지 않는다(ASVS 8.2.1, 계획 B14).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryRoleChangeApprovalStore } from '../src/modules/admin-accounts/index.js';
import type { RoleChangeApprovalRecord, RoleChangeApprovalStore } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';

const NOW = Date.parse('2026-11-20T11:00:00.000Z');
const TARGET = '0194b045-0000-7000-8000-000000002001';
const clock = fakeClock({ now: NOW });

/** 첫 DONE 저장만 실패해 다른 승인이 먼저 처리한 것처럼 만든다(낙관적 갱신 패배) */
class LoseDoneOnceStore implements RoleChangeApprovalStore {
  readonly mem = new MemoryRoleChangeApprovalStore();
  loseNextDone = false;
  inserted: RoleChangeApprovalRecord | null = null;
  async insert(r: RoleChangeApprovalRecord): Promise<void> {
    this.inserted = { ...r };
    await this.mem.insert(r);
  }
  find(id: string): Promise<RoleChangeApprovalRecord | null> {
    return this.mem.find(id);
  }
  async save(r: RoleChangeApprovalRecord, expectedVersion: number): Promise<boolean> {
    if (this.loseNextDone && r.status === 'DONE') {
      this.loseNextDone = false;
      return false;
    }
    return this.mem.save(r, expectedVersion);
  }
  list(filter: { status?: readonly string[]; limit: number }): Promise<RoleChangeApprovalRecord[]> {
    return this.mem.list(filter);
  }
}

/** commander 역할 변경을 요청해 승인 업무(PENDING_APPROVAL)를 만든다. 승인·반려는 부르는 쪽이 한다 */
const requested = async () => {
  const { FakeAdminIdentity, reauthKit } = await import('./admin-support.js');
  const { FakeIdentity, quiet } = await import('./support.js');
  const identity = new FakeIdentity();
  const admin = new FakeAdminIdentity();
  const kit = reauthKit(() => clock.now());
  const store = new LoseDoneOnceStore();
  const audit = new MemoryAuditChain();
  admin.seed({ adminAccountId: TARGET, role: 'operator', status: 'ACTIVE' });
  const svc = await createService({
    name: 'ops-svc-approval-problems',
    module: AppModule.register({ memory: true, auditChain: audit, adminAccounts: { identity: admin, reauth: kit.verifier }, approvals: { roleChangeStore: store } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const send = (method: 'PUT' | 'POST', url: string, headers: Record<string, string>, body?: unknown) =>
    svc.http.inject({ method, url, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
  const requester = identity.ops('commander');
  const approver = identity.ops('commander');
  admin.actor(requester['x-user-id']!, 'commander');
  admin.actor(approver['x-user-id']!, 'commander');
  const permToken = (who: Record<string, string>) => kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'PERMISSION_CHANGE' });
  const created = await send('PUT', `/v1/ops/admin-accounts/${TARGET}/role`, { ...requester, 'x-reauth-token': permToken(requester), 'if-match': '"1"' }, { role: 'commander', reason: 'RV-03 시험' });
  expect(created.statusCode, created.payload).toBe(202);
  const approvalId = json(created).approvalId as string;
  return { svc, admin, audit, store, kit, send, approver, approvalId };
};

const run = async (o: { fail?: AdminAccountProblem | undefined; loseDone?: boolean }) => {
  const { svc, admin, audit, store, kit, send, approver, approvalId } = await requested();
  if (o.fail) admin.fail = { method: 'changeRole', problem: o.fail };
  store.loseNextDone = o.loseDone === true;
  const approveToken = kit.token({ accountId: approver['x-user-id']!, sessionId: approver['x-session-id']!, act: 'APPROVAL' });
  const approved = await send('POST', `/v1/ops/approval-requests/${approvalId}/approvals`, { ...approver, 'x-reauth-token': approveToken });
  return { svc, admin, audit, store, approvalId, approved, target: TARGET };
};

describe('RV-03 승인 identity 오류·저장 패배', () => {
  test('RV-03 identity VERSION_MISMATCH(412)·STATE_CONFLICT(409)는 500이 아니라 412·409 Problem이다', async () => {
    const a = await run({ fail: new AdminAccountProblem('precondition-failed', 412, '다른 사람이 먼저 바꿨습니다') });
    expect(a.approved.statusCode, a.approved.payload).toBe(412);
    expect(String((JSON.parse(a.approved.payload) as Record<string, unknown>).type)).toMatch(/precondition-failed$/);
    await a.svc.close();
    const b = await run({ fail: new AdminAccountProblem('admin-account-state-conflict', 409, '지금 상태에서는 할 수 없습니다') });
    expect(b.approved.statusCode, b.approved.payload).toBe(409);
    expect(String((JSON.parse(b.approved.payload) as Record<string, unknown>).type)).toMatch(/admin-account-state-conflict$/);
    await b.svc.close();
  });

  test('RV-03 identity가 성공한 뒤 저장이 낡은 판에 지면 409지만 역할 변경 감사 SUCCEEDED 1은 남고 FAILED는 없다', async () => {
    const a = await run({ loseDone: true });
    expect(a.approved.statusCode, a.approved.payload).toBe(409);
    // identity는 역할을 바꿨다
    expect(a.admin.accounts.get(a.target)!.role).toBe('commander');
    const succeeded = a.audit.entries.filter((e) => e.recordId === a.target && e.record.payload.status === 'SUCCEEDED');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.record.payload).toMatchObject({ action: 'ROLE_CHANGED', approvalId: a.approvalId, toRole: 'commander' });
    const failed = a.audit.entries.filter((e) => e.recordId === a.target && e.record.payload.status === 'FAILED');
    expect(failed).toHaveLength(0);
    await a.svc.close();
  });
});

// W12-prf192: 반려 사유가 앞뒤 공백을 빼면 빈 글자이면 본문 오류다(guidelines §2, openapi x-peaket-problem-types invalid-body 400).
// 목록 조건 오류(invalid-query)나 FRAUD_ACTION 승인 사유(approval-reason-required 422)가 아니다.
const P = 'https://peaket.example/problems/';

describe('W12P-01 역할 변경 승인 반려 사유 없음', () => {
  test('W12P-01 ① commander가 공백뿐인 사유로 반려하면 400 invalid-body이고 업무는 PENDING_APPROVAL 그대로다', async () => {
    const a = await requested();
    const r = await a.send('POST', `/v1/ops/approval-requests/${a.approvalId}/rejections`, a.approver, { reason: '   ' });
    expect(r.statusCode, r.payload).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({ type: `${P}invalid-body`, status: 400, title: '요청 본문이 올바르지 않습니다' });
    expect(await a.store.find(a.approvalId)).toMatchObject({ status: 'PENDING_APPROVAL', approverId: null });
    await a.svc.close();
  });

  test('W12P-01 ② 같은 업무에 빈 글자 사유도 ①과 같은 400이고 업무는 PENDING_APPROVAL 그대로다', async () => {
    const a = await requested();
    const r = await a.send('POST', `/v1/ops/approval-requests/${a.approvalId}/rejections`, a.approver, { reason: '' });
    expect(r.statusCode, r.payload).toBe(400);
    expect(await a.store.find(a.approvalId)).toMatchObject({ status: 'PENDING_APPROVAL', approverId: null });
    await a.svc.close();
  });
});
