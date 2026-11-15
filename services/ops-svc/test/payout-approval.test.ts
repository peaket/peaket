// 지급 묶음 2인 승인·실행 시험(BUILD_ORDER BAT-610 잔여, J-T3·J-T9, FR-062, POL-038).
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { approvalDueAt } from '../src/modules/payouts/domain/payout-approval.js';
import { MemoryPayoutApprovalStore, PayoutApprovals, type PayoutBatchView, type PayoutPaymentClient } from '../src/modules/payouts/index.js';
import type { ApprovalReauthVerifier } from '../src/modules/payouts/domain/ports.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const identity = new FakeIdentity();
const audit = new MemoryAuditChain();
const store = new MemoryPayoutApprovalStore(audit);

class FakePayments implements PayoutPaymentClient {
  batches: PayoutBatchView[] = [];
  readonly calls: string[] = [];
  readonly executedTotals: number[] = [];
  totalAmount = 24_920_000;
  failExecute = false;
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    this.calls.push('create');
    if (this.batches.some((b) => b.pg === input.pg && b.pgStore === input.pgStore && b.payoutDate === input.payoutDate && b.status !== 'COMPLETED' && b.status !== 'PARTIAL_FAILED')) {
      throw new ProblemError({ type: 'payout-batch-exists', status: 409, title: '이미 지급 묶음이 있습니다' });
    }
    const batch: PayoutBatchView = { batchId: randomUUID(), pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, totalAmount: this.totalAmount, statementCount: 3, status: 'PENDING_APPROVAL' };
    this.batches.push(batch);
    return batch;
  }
  async listBatches() {
    return this.batches;
  }
  async listCircuits() {
    return { items: [{ pg: 'TOSS' as const, state: 'closed' as const }] };
  }
  async approveBatch(batchId: string) {
    this.calls.push('approve');
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'APPROVED' };
  }
  async executeBatch(batchId: string) {
    this.calls.push('execute');
    if (this.failExecute) throw new ProblemError({ type: 'payout-gateway-unavailable', status: 503, title: '지급대행을 시작할 수 없습니다' });
    const batch = this.batches.find((b) => b.batchId === batchId)!;
    this.executedTotals.push(batch.totalAmount);
    return { ...batch, status: 'SUBMITTED' };
  }
  async recordPortoneExecution(batchId: string) {
    this.calls.push('portone');
    const b = this.batches.find((x) => x.batchId === batchId)!;
    if (b.status !== 'APPROVED' && b.status !== 'SUBMITTED') throw new ProblemError({ type: 'payout-batch-not-approved', status: 409, title: '승인된 지급 묶음이 아닙니다' });
    return { ...b, status: 'SUBMITTED', portoneBulkPayoutId: 'bulk-1' };
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
  }
}

class TestReauth implements ApprovalReauthVerifier {
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}
const tokenAccount = new Map<string, string>();
const payments = new FakePayments();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, payouts: { store, payments, reauth: new TestReauth() }, auditChain: audit }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  store.rows.clear();
  payments.batches = [];
  payments.calls.length = 0;
  payments.executedTotals.length = 0;
  payments.totalAmount = 24_920_000;
  payments.failExecute = false;
  audit.entries.length = 0;
  tokenAccount.clear();
});

const headers = (role: 'viewer' | 'operator' | 'commander' = 'operator', token?: string) => {
  const h = identity.ops(role);
  tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
  return { ...h, 'content-type': 'application/json', ...(token ? { 'x-reauth-token': token } : {}) };
};
const noBody = (role: 'viewer' | 'operator' | 'commander' = 'operator', token?: string): Record<string, string> => {
  const h: Record<string, string> = { ...headers(role, token) };
  delete h['content-type'];
  return h;
};
const create = (h = headers()) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: h, payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-20' }) });

describe('M4-01 지급일 전 영업일 15시', () => {
  test('월요일은 금요일, 화~금은 전날, 토·일은 직전 금요일 15시(KST)다', () => {
    expect(approvalDueAt('2026-11-16').toISOString()).toBe('2026-11-13T06:00:00.000Z');
    expect(approvalDueAt('2026-11-17').toISOString()).toBe('2026-11-16T06:00:00.000Z');
    expect(approvalDueAt('2026-11-21').toISOString()).toBe('2026-11-20T06:00:00.000Z');
    expect(approvalDueAt('2026-11-22').toISOString()).toBe('2026-11-20T06:00:00.000Z');
  });
});

describe('J-T3 지급 묶음 2인 승인', () => {
  test('J-T3 operator가 요청하고 요청자가 아닌 commander가 재인증 뒤 승인·실행한다', async () => {
    const created = await create();
    expect(created.statusCode).toBe(202);
    const batch = JSON.parse(created.payload);
    expect(batch).toMatchObject({ pg: 'TOSS', pgStore: 'STANDARD', totalAmount: 24_920_000, statementCount: 3, approvalId: expect.any(String) });
    const approval = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${batch.approvalId}`, headers: noBody('commander') })).payload);
    expect(approval).toMatchObject({ kind: 'PAYOUT_BATCH', targetRef: batch.batchId, amount: 24_920_000, requiredApprovals: 2, status: 'PENDING_APPROVAL', canApprove: true });
    // operator는 승인할 수 없다.
    expect((await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${batch.approvalId}/approvals`, headers: noBody('operator', 'approval-token') })).statusCode).toBe(403);
    // commander도 재인증 토큰이 없으면 403이다.
    expect((await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${batch.approvalId}/approvals`, headers: noBody('commander') })).statusCode).toBe(403);
    const ok = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${batch.approvalId}/approvals`, headers: noBody('commander', 'approval-token') });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ status: 'DONE' });
    expect(payments.calls).toEqual(['create', 'approve', 'execute']);
  });

  test('M4-04 다른 계정의 재인증 토큰은 승인을 거절한다', async () => {
    const created = JSON.parse((await create()).payload);
    const commander = noBody('commander', 'approval-token');
    tokenAccount.set(commander['x-session-id']!, '01900000-0000-7000-8000-000000000099');
    const r = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: commander });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload)).toMatchObject({ type: expect.stringContaining('reauth-required') });
  });

  test('OPS-03 동시 승인은 하나만 성공하고 DONE을 FAILED로 뒤집지 않는다', async () => {
    const created = JSON.parse((await create()).payload);
    const h1 = noBody('commander', 'approval-token');
    const h2 = noBody('commander', 'approval-token');
    tokenAccount.set(h1['x-session-id']!, h1['x-user-id']!);
    tokenAccount.set(h2['x-session-id']!, h2['x-user-id']!);
    const results = await Promise.all([
      svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: h1 }),
      svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: h2 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(store.rows.get(created.approvalId)).toMatchObject({ status: 'DONE' });
  });

  test('OPS-01 지급 승인 요청·승인·실행이 감사 체인에 남는다', async () => {
    const created = JSON.parse((await create()).payload);
    const ok = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: noBody('commander', 'approval-token') });
    expect(ok.statusCode).toBe(200);
    expect(audit.entries.map((e) => e.recordType)).toEqual(['PAYOUT_APPROVAL_REQUESTED', 'PAYOUT_BATCH_EXECUTING', 'PAYOUT_BATCH_DONE']);
  });

  test('J-T3 요청자와 같은 사람은 승인할 수 없고, 반려는 사유가 필요하다', async () => {
    const created = JSON.parse((await create()).payload);
    const requester = [...store.rows.values()][0]!;
    const own = { 'x-user-id': requester.requesterId, 'x-session-id': randomUUID(), 'x-user-aud': 'ops', 'x-user-scope': '' };
    identity.answers.set(`${own['x-user-id']}/${own['x-session-id']}`, { valid: true, role: 'commander' });
    tokenAccount.set(own['x-session-id']!, own['x-user-id']!);
    const self = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: { ...own, 'x-reauth-token': 'approval-token' } });
    expect(self.statusCode).toBe(403);
    expect(JSON.parse(self.payload)).toMatchObject({ type: expect.stringContaining('approval-self-not-allowed') });
    const noReason = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/rejections`, headers: headers('commander'), payload: JSON.stringify({ reason: '' }) });
    expect(noReason.statusCode).toBe(400);
    const rejected = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/rejections`, headers: headers('commander'), payload: JSON.stringify({ reason: '금액 확인 필요' }) });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ status: 'REJECTED', closeReason: '금액 확인 필요' });
    expect(payments.calls).toEqual(['create']);
  });

  test('J-T3 애플리케이션 승인·반려는 commander와 사유를 스스로 확인한다', async () => {
    const created = JSON.parse((await create()).payload);
    const app = new PayoutApprovals({ store, payments, reauth: new TestReauth(), clock: fakeClock({ now: NOW }) });
    await expect(app.approve(created.approvalId, { accountId: randomUUID(), sessionId: 's1', role: 'operator' }, 'approval-token')).rejects.toMatchObject({ status: 403, type: expect.stringContaining('approval-role-required') });
    await expect(app.reject(created.approvalId, { accountId: randomUUID(), sessionId: 's2', role: 'commander' }, '   ')).rejects.toMatchObject({ status: 422 });
  });

  test('J-T3 실행이 503이면 FAILED로 남고 다시 승인할 수 있다', async () => {
    const created = JSON.parse((await create()).payload);
    payments.failExecute = true;
    const failed = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: noBody('commander', 'approval-token') });
    expect(failed.statusCode).toBe(503);
    expect(store.rows.get(created.approvalId)).toMatchObject({ status: 'FAILED' });
    payments.failExecute = false;
    const retried = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: noBody('commander', 'approval-token') });
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ status: 'DONE' });
  });

  test('J-T9 포트원 실행 기록은 승인된 묶음에만 남는다', async () => {
    const created = JSON.parse((await create()).payload);
    const blocked = await svc.http.inject({ method: 'POST', url: `/v1/ops/payout-batches/${created.batchId}/portone-execution`, headers: headers('operator'), payload: JSON.stringify({ bulkPayoutId: 'bulk-1' }) });
    expect(blocked.statusCode).toBe(409);
    expect(payments.calls).toEqual(['create', 'portone']);
  });

  test('TEST-05 25억 승인 금액·감사 로그·결제사 요청 합계가 같다', async () => {
    payments.totalAmount = 2_500_000_000;
    const created = JSON.parse((await create()).payload);
    expect(created).toMatchObject({ totalAmount: 2_500_000_000, statementCount: 3 });
    const approval = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${created.approvalId}`, headers: noBody('commander') })).payload);
    expect(approval).toMatchObject({ amount: 2_500_000_000 });
    const ok = await svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created.approvalId}/approvals`, headers: noBody('commander', 'approval-token') });
    expect(ok.statusCode).toBe(200);
    expect(payments.executedTotals).toEqual([2_500_000_000]);
    const records = audit.entries.filter((e) => e.recordId === created.approvalId);
    expect(records.map((e) => e.recordType)).toEqual(['PAYOUT_APPROVAL_REQUESTED', 'PAYOUT_BATCH_EXECUTING', 'PAYOUT_BATCH_DONE']);
  });

  test('TEST-05 같은 pg·pgStore·payoutDate 두 번째 배치는 409 payout-batch-exists다', async () => {
    expect((await create()).statusCode).toBe(202);
    const second = await create();
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.payload)).toMatchObject({ type: expect.stringContaining('payout-batch-exists') });
  });
});
