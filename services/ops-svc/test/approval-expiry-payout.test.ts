// F-06-3 지급 묶음 승인 만료·지급 대상 지문의 ops 경계 시험(시험 담당, 2026-11-26. 시험 리뷰 TR-01·02·03·10 반영).
// 정본: docs/features/settlement.md §5.1(15시 만료·payeeDigest)·§13 J-T3, docs/planning/03 §2.10·POL-038·POL-039,
// docs/data.md payout_batch·payout_approval, docs/api/openapi.yaml PayoutBatch.payeeDigest·ApprovalRequest.
// 지문 계산·만료 트랜잭션의 정본 시험은 payment-svc `settlement-payee-digest-expiry.test.ts`가 맡는다. 여기서는 ops가
// 그 값을 저장·전달하고 409를 화면 상태로 옮기는지만 본다.
import 'reflect-metadata';
import { createService, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryPayoutApprovalStore, type PayoutBatchView, type PayoutPaymentClient } from '../src/modules/payouts/index.js';
import { FakeIdentity } from './support.js';

const KST = (s: string): number => Date.parse(`${s}+09:00`);
const NOW = KST('2026-11-26T10:00:00');
const INTERNAL = 'ops-internal-f063';
let wall = NOW;
const clock = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
const identity = new FakeIdentity();
const audit = new MemoryAuditChain();
const store = new MemoryPayoutApprovalStore(audit);
const tokenAccount = new Map<string, string>();
const DIGEST = 'a'.repeat(64);
const notified: Record<string, unknown>[] = [];
const alerts: Record<string, unknown>[] = [];

class TestReauth {
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

class FakePayments implements PayoutPaymentClient {
  batches: (PayoutBatchView & { payeeDigest?: string })[] = [];
  readonly calls: string[] = [];
  prepared = false;
  rejectApproval = false;
  rejectExpire = false;
  expired: { batchId: string; input: Record<string, unknown> }[] = [];
  approvalDigests: (string | undefined)[] = [];
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    this.calls.push('create');
    const batch: PayoutBatchView & { payeeDigest?: string } = {
      batchId: randomUUID(),
      pg: input.pg,
      pgStore: input.pgStore,
      payoutDate: input.payoutDate,
      totalAmount: 2_500_000_000,
      statementCount: 3,
      status: this.prepared ? 'PREPARED' : 'PENDING_APPROVAL',
      payeeDigest: DIGEST,
    };
    this.batches.push(batch);
    return batch;
  }
  async listBatches() {
    return this.batches;
  }
  async getBatchDetail(batchId: string) {
    return { batch: this.batches.find((b) => b.batchId === batchId)!, statements: [], payouts: [], holds: [], kycNotices: [] };
  }
  async collectGuarantee() {
    return { collection: { amount: 0 }, receivable: { promoterId: 'promoter-1' } };
  }
  async listCircuits() {
    return { items: [{ pg: 'TOSS' as const, state: 'closed' as const }] };
  }
  async approveBatch(batchId: string, _approvalId: string, payeeDigest?: string) {
    this.calls.push('approve');
    this.approvalDigests.push(payeeDigest);
    if (this.rejectApproval) throw new ProblemError({ type: 'payout-batch-payee-mismatch', status: 409, title: '지급 대상이 바뀌었습니다' });
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'APPROVED' };
  }
  async executeBatch(batchId: string) {
    this.calls.push('execute');
    return { ...this.batches.find((b) => b.batchId === batchId)!, status: 'SUBMITTED' };
  }
  async releaseBatch(batchId: string) {
    this.calls.push('release');
    this.batches = this.batches.filter((b) => b.batchId !== batchId);
  }
  async expireBatch(batchId: string, input: { approvalId: string; postponedPayoutDate: string }) {
    this.calls.push('expire');
    if (this.rejectExpire) throw new ProblemError({ type: 'payout-batch-not-expellable', status: 409, title: '만료할 수 없는 묶음입니다' });
    this.expired.push({ batchId, input });
    const b = this.batches.find((x) => x.batchId === batchId);
    if (b) b.status = 'EXPIRED';
    return { batchId, status: 'EXPIRED' as const, postponedPayoutDate: input.postponedPayoutDate };
  }
  async recordPortoneExecution(batchId: string) {
    this.calls.push('portone');
    return { ...this.batches.find((x) => x.batchId === batchId)!, status: 'SUBMITTED', portoneBulkPayoutId: 'bulk-1' };
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
  }
}

const payments = new FakePayments();
const noop = { async basis() { return undefined; }, async changed() { return 'OK' as const; } };
const noopExec = { async refund() { throw new Error('not used'); }, async reclaim() { throw new Error('not used'); } };
const notifier = { async send(i: Record<string, unknown>) { notified.push(i); } };
const escalationAlerts = { async open(i: Record<string, unknown>) { alerts.push(i); } };

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      payouts: { store, payments, reauth: new TestReauth() },
      approvals: { reauth: new TestReauth(), lifecycle: { targets: noop, executors: noopExec, notifier, alerts: escalationAlerts } } as never,
      auditChain: audit,
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
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
  payments.expired.length = 0;
  payments.approvalDigests.length = 0;
  payments.prepared = false;
  payments.rejectApproval = false;
  payments.rejectExpire = false;
  audit.entries.length = 0;
  notified.length = 0;
  alerts.length = 0;
  tokenAccount.clear();
  wall = NOW;
});

const as = (role: 'operator' | 'commander' | 'viewer') => identity.ops(role);
const headers = (h: Record<string, string>, token?: string, ifMatch?: number): Record<string, string> => ({
  ...h,
  'content-type': 'application/json',
  ...(token ? { 'x-reauth-token': token } : {}),
  ...(ifMatch === undefined ? {} : { 'If-Match': `"${ifMatch}"` }),
});
const reauth = (h: Record<string, string>) => {
  tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
  return 'approval-token';
};
const createBatch = (h: Record<string, string>, payoutDate = '2026-12-01') =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/payout-batches', headers: headers(h), payload: JSON.stringify({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate }) });
const versionOf = async (h: Record<string, string>, id: string): Promise<number> => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: h });
  return r.statusCode === 200 ? Number(JSON.parse(r.payload).version ?? 1) : 1;
};
const approve = async (h: Record<string, string>, id: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: headers(h, reauth(h), await versionOf(h, id)), payload: '{}' });
const tick = (token: string | undefined = INTERNAL) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/approval-requests/tick', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-peaket-internal-token': token }) }, payload: '{}' });
const getApproval = (h: Record<string, string>, id: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: h });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const approvalIdOf = (batch: Record<string, unknown>) => batch['approvalId'] as string;
const DUE = '2026-11-30T06:00:00.000Z'; // 지급일 2026-12-01 전 영업일(월) 15:00 KST

describe('J-T3 지급 묶음 2인 승인', () => {
  test('J-T3 요청자 operator는 승인할 수 없고, 승인 전에는 결제사 승인·실행 호출이 0이다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    expect((await approve(op, approvalIdOf(batch))).statusCode).toBe(403);
    expect(payments.calls).toEqual(['create']);
    expect(json(await getApproval(op, approvalIdOf(batch)))).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 2, canApprove: false });
  });

  test('J-T3 25억 묶음도 금액을 그대로 저장하고 commander 승인·실행에 같은 금액을 넘긴다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    expect(batch['totalAmount']).toBe(2_500_000_000);
    expect(json(await getApproval(op, approvalIdOf(batch)))['amount']).toBe(2_500_000_000);
    const r = await approve(as('commander'), approvalIdOf(batch));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'DONE', amount: 2_500_000_000 });
    expect(payments.calls).toEqual(['create', 'approve', 'execute']);
  });
});

describe('지급 대상 지문(payeeDigest)의 ops 경계', () => {
  test('묶음 응답·승인 상세·내부 사실이 같은 64자 지문을 싣고 승인에 그대로 넘긴다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    expect(batch['payeeDigest']).toBe(DIGEST);
    const id = approvalIdOf(batch);
    expect(json(await getApproval(op, id))['payeeDigest']).toBe(DIGEST);
    const facts = await svc.http.inject({ method: 'GET', url: `/internal/v1/payout-approvals/${id}`, headers: { 'x-peaket-internal-token': INTERNAL } });
    expect(json(facts)).toMatchObject({ payeeDigest: DIGEST });
    expect((await approve(as('commander'), id)).statusCode).toBe(200);
    expect(payments.approvalDigests).toEqual([DIGEST]);
  });

  test('payment가 지문 불일치 409를 내면 ops도 409 payout-batch-payee-mismatch이고 실행하지 않는다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    payments.rejectApproval = true;
    const r = await approve(as('commander'), approvalIdOf(batch));
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('payout-batch-payee-mismatch') });
    expect(payments.calls).not.toContain('execute');
  });
});

describe('R-T29 ④ 15시 미승인 만료', () => {
  test('14:59:59.999에는 승인할 수 있다(정본 시각 2026-11-30 15:00 KST)', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    wall = Date.parse(DUE) - 1;
    expect((await approve(as('commander'), approvalIdOf(batch))).statusCode).toBe(200);
  });

  test('15:00 정각에는 만료되고 다음 은행 영업일로 미루며 파트너 알림·경보를 한 번 낸다 [ASVS v5.0.0-2.3.3]', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    wall = Date.parse(DUE);
    const r = await tick();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ expired: 1, failed: 0 });
    expect(payments.expired).toEqual([{ batchId: batch['batchId'], input: { approvalId: approvalIdOf(batch), postponedPayoutDate: '2026-12-02' } }]);
    expect(notified).toEqual([expect.objectContaining({ event: 'PAYOUT_POSTPONED', payoutDate: '2026-12-02' })]);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'settlement_batch_unapproved', pg: 'TOSS', payoutDate: '2026-12-01' })]);
    expect(json(await getApproval(op, approvalIdOf(batch)))).toMatchObject({ status: 'EXPIRED', closeReason: 'DEADLINE_PASSED' });
    expect(payments.calls).not.toContain('execute');
  });

  test('만료된 승인은 늦게 승인해도 409 approval-expired이고 결제사를 부르지 않는다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    wall = Date.parse(DUE) + 1_000;
    expect((await approve(as('commander'), approvalIdOf(batch))).statusCode).toBe(409);
    expect(payments.calls).toEqual(['create']);
  });

  test('09시에 만든 PREPARED 묶음도 15시 만료가 푼다', async () => {
    payments.prepared = true;
    const op = as('operator');
    const batch = json(await createBatch(op));
    wall = Date.parse(DUE);
    await tick();
    expect(payments.expired).toHaveLength(1);
    expect(payments.expired[0]).toMatchObject({ batchId: batch['batchId'], input: { postponedPayoutDate: '2026-12-02' } });
  });

  test('지급 건이 이미 있으면 payment가 409로 거절하고 승인은 EXPIRED가 되지 않으며 failed로 센다', async () => {
    const op = as('operator');
    const batch = json(await createBatch(op));
    payments.rejectExpire = true;
    wall = Date.parse(DUE);
    const r = await tick();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ expired: 0, failed: 1 });
    expect(json(await getApproval(op, approvalIdOf(batch)))).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  test('내부 tick은 토큰이 없거나 틀리면 403이고 만료를 부르지 않는다 [ASVS v5.0.0-8.3.1]', async () => {
    const op = as('operator');
    await createBatch(op);
    wall = Date.parse(DUE);
    for (const token of [undefined, 'wrong-token']) expect((await tick(token)).statusCode).toBe(403);
    expect(payments.expired).toHaveLength(0);
    expect((await tick()).statusCode).toBe(200);
    expect(payments.expired).toHaveLength(1);
  });
});
