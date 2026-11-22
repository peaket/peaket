// 실패한 승인 업무의 CS 건과 다시 실행(F-06-2 GAT-280, R-T20 ③). 시험 담당 lane3-f062-test.
// 실제 ops-svc 조립(메모리)의 세 승인 모듈(계약 조건 변경·관리 역할 변경·지급 묶음)이 실행에 실패하면 '승인 업무 실행 실패' 건이 하나 열리고,
// 승인자가 같은 승인 ID로 approve를 다시 부르면(재인증) 같은 대상·금액으로만 다시 실행되며 성공하면 그 건이 닫히는지 본다.
// 정본: docs/features/transfer-refund.md §11 R-T20 ③, ADR-0364 결정 6(대상 승인 ID, category 승인 종류, 기한은 원래 승인 업무의 기한, 없으면 없음,
// 성공하면 시스템이 해결로 닫는다), d5 §7.6 '승인 업무 실행 실패' 행, ADR-0073(승인 ID가 멱등키, 새 승인은 필요 없다).
// 바깥 경계(core 계약 적용·identity 관리 계정·payment-svc 지급대행)만 포트를 구현한 대역이다. 업무 로직(승인·CS 건)은 진짜다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryContractApprovalStore, type CoreContractClient } from '../src/modules/approvals/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import type { ApprovalReauthVerifier, PayoutBatchView, PayoutPaymentClient } from '../src/modules/payouts/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-16T01:00:00.000Z');
let svc: Awaited<ReturnType<typeof createService>> | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const noBody = (h: Record<string, string>) => {
  const c = { ...h };
  delete c['content-type'];
  return c;
};
async function cases(identity: FakeIdentity, status?: string) {
  const r = await svc!.http.inject({ method: 'GET', url: `/v1/ops/cases?kind=APPROVAL_EXECUTION_FAILED${status ? `&status=${status}` : ''}&limit=100`, headers: identity.ops('commander') });
  expect(r.statusCode, r.payload).toBe(200);
  return (json(r).items as Array<Record<string, unknown>>).map((c) => ({ targetRef: c.targetRef, category: c.category, status: c.status, resultDueAt: c.resultDueAt ?? null, progressDueAt: c.progressDueAt ?? null }));
}

class FlakyCore implements CoreContractClient {
  readonly applied: Array<Parameters<CoreContractClient['apply']>[0]> = [];
  failNext = 0;
  async apply(q: Parameters<CoreContractClient['apply']>[0]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('core 계약 적용 503');
    }
    this.applied.push(q);
  }
  async cancel(): Promise<void> {}
}

describe('R-T20 ③ 계약 조건 변경 승인', () => {
  const identity = new FakeIdentity();
  const tokenAccount = new Map<string, string>();
  const reauth: ApprovalReauthVerifier = {
    verify: async (token, o) => {
      if (token !== 'approval-token' || o.act !== 'APPROVAL') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
    },
  };
  const commander = () => {
    const h = identity.ops('commander');
    tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
    return { ...h, 'x-reauth-token': 'approval-token' };
  };

  async function bootContract() {
    const core = new FlakyCore();
    svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, approvals: { store: new MemoryContractApprovalStore(new MemoryAuditChain()), core, reauth } }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
    const approvalId = randomUUID();
    const requester = identity.ops('operator');
    const requested = { commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND' };
    const put = await svc.http.inject({
      method: 'PUT',
      url: `/internal/v1/approval-requests/${approvalId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'CONTRACT_TERMS_CHANGE',
        targetRef: 'promoter-7',
        requestedBy: { accountId: requester['x-user-id'], role: 'operator' },
        reasonText: '연간 계약 갱신',
        current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: '2026-11-01T00:00:00.000Z' },
        requested,
      }),
    });
    expect(put.statusCode, put.payload).toBe(200);
    const approve = (h: Record<string, string>) => svc!.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${approvalId}/approvals`, headers: noBody(h) });
    return { core, approvalId, requested, approve };
  }

  test('R-T20 ③ 실행 실패마다 열린 건은 하나(대상 승인 ID·category 승인 종류·기한 없음)이고, 같은 승인 ID로 다시 approve하면 같은 값으로 core에 한 번 적용되고 건이 닫힌다', async () => {
    const c = await bootContract();
    c.core.failNext = 2;
    const approver = commander();
    expect((await c.approve(approver)).statusCode).toBe(503);
    expect((await c.approve(approver)).statusCode).toBe(503);
    expect(await cases(identity)).toEqual([{ targetRef: c.approvalId, category: 'CONTRACT_TERMS_CHANGE', status: 'OPEN', resultDueAt: null, progressDueAt: null }]);
    expect(c.core.applied).toEqual([]);

    const retried = await c.approve(approver);
    expect([retried.statusCode, json(retried).status]).toEqual([200, 'DONE']);
    expect(c.core.applied).toHaveLength(1);
    expect(c.core.applied[0]).toMatchObject({ approvalId: c.approvalId, ...c.requested });
    expect(await cases(identity)).toEqual([]);
    expect(await cases(identity, 'RESOLVED')).toEqual([{ targetRef: c.approvalId, category: 'CONTRACT_TERMS_CHANGE', status: 'RESOLVED', resultDueAt: null, progressDueAt: null }]);
    // 끝난 승인은 다시 실행되지 않는다(두 번 적용 없음)
    expect((await c.approve(approver)).statusCode).toBeGreaterThanOrEqual(400);
    expect(c.core.applied).toHaveLength(1);
  });

  test('R-T20 ③ 재인증 없이 다시 approve하면 실행하지 않고 건은 열린 채다', async () => {
    const c = await bootContract();
    c.core.failNext = 1;
    expect((await c.approve(commander())).statusCode).toBe(503);
    const noToken = { ...identity.ops('commander') };
    expect((await c.approve(noToken)).statusCode).toBe(403);
    expect(c.core.applied).toEqual([]);
    expect((await cases(identity)).map((x) => x.status)).toEqual(['OPEN']);
  });
});

describe('R-T20 ③ 관리 역할 변경 승인(기한을 이어받는다)', () => {
  test('R-T20 ③ identity 실행이 실패하면 그 승인 업무의 기한으로 건이 열리고, 같은 승인 ID로 다시 approve가 성공하면 닫힌다', async () => {
    const clock = fakeClock({ now: NOW });
    const identity = new FakeIdentity();
    const admin = new FakeAdminIdentity();
    const kit = reauthKit(() => clock.now());
    const target = '0194f062-0000-7000-8000-0000000a0001';
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, adminAccounts: { identity: admin, reauth: kit.verifier } }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    admin.actor(requester['x-user-id']!, 'commander');
    admin.actor(approver['x-user-id']!, 'commander');
    const permToken = kit.token({ accountId: requester['x-user-id']!, sessionId: requester['x-session-id']!, act: 'PERMISSION_CHANGE' });
    const created = await svc.http.inject({
      method: 'PUT',
      url: `/v1/ops/admin-accounts/${target}/role`,
      headers: { ...requester, 'x-reauth-token': permToken, 'if-match': '"1"', 'content-type': 'application/json' },
      payload: JSON.stringify({ role: 'commander', reason: 'R-T20 ③ 시험' }),
    });
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = json(created).approvalId as string;
    const view = json(await svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${approvalId}`, headers: approver }));
    expect(typeof view.dueAt).toBe('string');
    const approve = () =>
      svc!.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${approvalId}/approvals`, headers: { ...approver, 'x-reauth-token': kit.token({ accountId: approver['x-user-id']!, sessionId: approver['x-session-id']!, act: 'APPROVAL' }) } });

    admin.fail = { method: 'changeRole', problem: new AdminAccountProblem('admin-unavailable', 503, '잠시 처리하지 못했습니다') };
    expect((await approve()).statusCode).toBe(503);
    expect(await cases(identity)).toEqual([{ targetRef: approvalId, category: 'COMMANDER_ROLE_CHANGE', status: 'OPEN', resultDueAt: view.dueAt, progressDueAt: null }]);

    const ok = await approve();
    expect([ok.statusCode, json(ok).status]).toEqual([200, 'DONE']);
    expect(admin.calls.filter((c) => c.startsWith('changeRole:'))).toEqual([`changeRole:${target}:commander:${approvalId}`, `changeRole:${target}:commander:${approvalId}`]);
    expect(await cases(identity)).toEqual([]);
    expect((await cases(identity, 'RESOLVED')).map((x) => x.targetRef)).toEqual([approvalId]);
  });
});

class FailingPayments implements PayoutPaymentClient {
  batches: PayoutBatchView[] = [];
  readonly executed: Array<{ batchId: string; totalAmount: number }> = [];
  failExecute = false;
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    const batch: PayoutBatchView = { batchId: randomUUID(), pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, totalAmount: 24_920_000, statementCount: 3, status: 'PENDING_APPROVAL' };
    this.batches.push(batch);
    return batch;
  }
  async listBatches() {
    return this.batches;
  }
  async getBatchDetail(batchId: string) {
    return { batch: this.batches.find((b) => b.batchId === batchId)!, statements: [], payouts: [], holds: [], kycNotices: [] };
  }
  async approveBatch(batchId: string) {
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'APPROVED' };
  }
  async executeBatch(batchId: string) {
    if (this.failExecute) throw new ProblemError({ type: 'payout-gateway-unavailable', status: 503, title: '지급대행을 시작할 수 없습니다' });
    const b = this.batches.find((x) => x.batchId === batchId)!;
    this.executed.push({ batchId, totalAmount: b.totalAmount });
    return { ...b, status: 'SUBMITTED' };
  }
  async releaseBatch() {}
  async recordPortoneExecution(batchId: string) {
    return this.batches.find((b) => b.batchId === batchId)!;
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
  }
  async collectGuarantee() {
    return {};
  }
  async listCircuits() {
    return { items: [] };
  }
}

describe('R-T20 ③ 지급 묶음 승인(기한을 이어받는다)', () => {
  test('R-T20 ③ 지급대행 실행이 실패하면 지급 승인 기한으로 건이 열리고, 같은 승인 ID로 다시 approve하면 같은 묶음·금액으로 한 번 실행되고 닫힌다', async () => {
    const identity = new FakeIdentity();
    const tokenAccount = new Map<string, string>();
    const reauth: ApprovalReauthVerifier = {
      verify: async (token, o) => {
        if (token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
        return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
      },
    };
    const payments = new FailingPayments();
    svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, payouts: { payments, reauth } }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
    const operator = identity.ops('operator');
    const created = await svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: { ...operator, 'content-type': 'application/json' }, payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-20' }) });
    expect(created.statusCode, created.payload).toBe(202);
    const { approvalId, batchId } = json(created) as { approvalId: string; batchId: string };
    const commander = identity.ops('commander');
    tokenAccount.set(commander['x-session-id']!, commander['x-user-id']!);
    const view = json(await svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${approvalId}`, headers: commander }));
    const approve = () => svc!.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${approvalId}/approvals`, headers: { ...commander, 'x-reauth-token': 'approval-token' } });

    payments.failExecute = true;
    expect((await approve()).statusCode).toBe(503);
    expect(await cases(identity)).toEqual([{ targetRef: approvalId, category: 'PAYOUT_BATCH', status: 'OPEN', resultDueAt: view.dueAt, progressDueAt: null }]);

    payments.failExecute = false;
    const ok = await approve();
    expect([ok.statusCode, json(ok).status]).toEqual([200, 'DONE']);
    expect(payments.executed).toEqual([{ batchId, totalAmount: 24_920_000 }]);
    expect(await cases(identity)).toEqual([]);
    expect((await cases(identity, 'RESOLVED')).map((x) => x.targetRef)).toEqual([approvalId]);
  });
});
