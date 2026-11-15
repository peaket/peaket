// 지급 승인 계약 회귀 시험(R-597·R-614): 영업일 기한, 저장소 version CAS, 전이별 감사, 재인증 계정 결속,
// 수기 포트원 실행 감사. 돈이 나가는 경로라 상태·감사·승인자 결속을 한 곳에서 고정한다.
import { randomUUID } from 'node:crypto';
import { fakeClock, ProblemError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain, type AuditRecord } from '../src/modules/audit/index.js';
import {
  MemoryPayoutApprovalStore,
  PayoutApprovals,
  approvalDueAt,
  payoutApprovalView,
  type ApprovalReauthVerifier,
  type PayoutApprovalRecord,
  type PayoutBatchView,
  type PayoutPaymentClient,
} from '../src/modules/payouts/index.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const REQUESTER = { accountId: '0193c000-0000-7000-8000-000000000001', sessionId: 's-r', role: 'operator' };
const COMMANDER = { accountId: '0193c000-0000-7000-8000-000000000002', sessionId: 's-c', role: 'commander' };
const TOKEN = 'approval-token';

class FakePayments implements PayoutPaymentClient {
  readonly batches: PayoutBatchView[] = [];
  readonly calls: string[] = [];
  totalAmount = 24_920_000;
  failExecute = false;
  async createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string }) {
    this.calls.push('create');
    const batch: PayoutBatchView = {
      batchId: randomUUID(),
      pg: input.pg,
      pgStore: input.pgStore,
      payoutDate: input.payoutDate,
      totalAmount: this.totalAmount,
      statementCount: 3,
      status: 'PENDING_APPROVAL',
    };
    this.batches.push(batch);
    return batch;
  }
  async releaseBatch() {
    this.calls.push('release');
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
    batch.status = 'SUBMITTED';
    return { ...batch };
  }
  async recordPortoneExecution(batchId: string, bulkPayoutId: string) {
    this.calls.push('portone');
    const batch = this.batches.find((b) => b.batchId === batchId)!;
    if (batch.status !== 'APPROVED' && batch.status !== 'SUBMITTED') {
      throw new ProblemError({ type: 'payout-batch-not-approved', status: 409, title: '승인된 지급 묶음이 아닙니다' });
    }
    batch.status = 'SUBMITTED';
    batch.portoneBulkPayoutId = bulkPayoutId;
    return { ...batch };
  }
  async listStatements() {
    return [];
  }
  async listReceivables() {
    return [];
  }
}

const reauthOf = (accountId: string = COMMANDER.accountId): ApprovalReauthVerifier => ({
  verify: async (token) => {
    if (token !== TOKEN) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId, factors: ['passkey'] };
  },
});

class SpyStore extends MemoryPayoutApprovalStore {
  readonly saves: Array<{ record: PayoutApprovalRecord; audit: AuditRecord | undefined }> = [];
  override async save(record: PayoutApprovalRecord, audit?: AuditRecord): Promise<boolean> {
    this.saves.push({ record, audit });
    return super.save(record, audit);
  }
}

const fixture = () => {
  const audit = new MemoryAuditChain();
  const store = new SpyStore(audit);
  const payments = new FakePayments();
  const app = new PayoutApprovals({ store, payments, reauth: reauthOf(), clock: fakeClock({ now: NOW }), audit });
  return { audit, store, payments, app };
};

const request = (app: PayoutApprovals) => app.request({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-20' }, REQUESTER);

const record = (over: Partial<PayoutApprovalRecord> = {}): PayoutApprovalRecord => ({
  approvalId: randomUUID(),
  batchId: randomUUID(),
  pg: 'TOSS',
  pgStore: 'STANDARD',
  payoutDate: '2026-11-20',
  amount: 1_000,
  statementCount: 1,
  status: 'PENDING_APPROVAL',
  requesterId: REQUESTER.accountId,
  requesterRole: 'operator',
  approverId: null,
  reasonText: '지급 묶음 확인 요청',
  failure: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  approvedAt: null,
  executedAt: null,
  version: 1,
  ...over,
});

describe('M4-01 지급 승인 기한(영업일)', () => {
  test('월요일 지급은 직전 금요일, 월 경계를 넘어도 영업일 15시(KST)로 계산한다', () => {
    // 2026-03-02(월)의 전 영업일은 2026-02-27(금)이다. 달력 하루 전(3/1 일)이면 안 된다.
    expect(approvalDueAt('2026-03-02').toISOString()).toBe('2026-02-27T06:00:00.000Z');
    expect(approvalDueAt('2026-11-23').toISOString()).toBe('2026-11-20T06:00:00.000Z');
    expect(approvalDueAt('2026-11-20').toISOString()).toBe('2026-11-19T06:00:00.000Z');
  });

  test('승인 뷰의 dueAt도 같은 영업일 15시를 보여 준다', () => {
    expect(payoutApprovalView(record({ payoutDate: '2026-03-02' }), REQUESTER).dueAt).toBe('2026-02-27T06:00:00.000Z');
  });
});

describe('M4-08·OPS-03 지급 승인 저장 낙관적 잠금', () => {
  test('저장소는 이전 version이 아니면 갱신을 거절하고 거절된 변경의 감사를 남기지 않는다', async () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryPayoutApprovalStore(audit);
    const base = record();
    await store.insert(base);
    audit.entries.length = 0;

    expect(await store.save({ ...base, status: 'EXECUTING', approverId: COMMANDER.accountId, version: 2 }, { recordType: 'PAYOUT_BATCH_EXECUTING', recordId: base.approvalId, payload: {}, nowMs: NOW })).toBe(true);
    // 같은 version(1)에서 출발한 다른 요청은 이겨도 저장되지 않는다.
    expect(await store.save({ ...base, status: 'FAILED', version: 2 }, { recordType: 'PAYOUT_BATCH_FAILED', recordId: base.approvalId, payload: {}, nowMs: NOW })).toBe(false);
    expect(store.rows.get(base.approvalId)).toMatchObject({ status: 'EXECUTING', approverId: COMMANDER.accountId, version: 2 });
    expect(audit.entries.map((e) => e.recordType)).toEqual(['PAYOUT_BATCH_EXECUTING']);
  });

  test('동시 승인은 하나만 성공하고 결제사 승인·실행은 한 번만 부른다', async () => {
    const f = fixture();
    const created = await request(f.app);
    const results = await Promise.allSettled([
      f.app.approve(created.approval.approvalId, COMMANDER, TOKEN),
      f.app.approve(created.approval.approvalId, { ...COMMANDER, sessionId: 's-c2' }, TOKEN),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, slug: 'payout-approval-conflict' } });
    expect(f.payments.calls).toEqual(['create', 'approve', 'execute']);
    expect(f.store.rows.get(created.approval.approvalId)).toMatchObject({ status: 'DONE' });
  });
});

describe('OPS-01 지급 승인 감사 체인', () => {
  test('요청·반려가 감사 체인에 사유와 상태로 남는다', async () => {
    const f = fixture();
    const created = await request(f.app);
    await f.app.reject(created.approval.approvalId, COMMANDER, '금액 확인 필요');
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['PAYOUT_APPROVAL_REQUESTED', 'PAYOUT_APPROVAL_REJECTED']);
    const [requested, rejected] = f.audit.entries;
    expect(requested!.record.payload).toMatchObject({
      batchId: created.batch.batchId,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      payoutDate: '2026-11-20',
      amount: 24_920_000,
      statementCount: 3,
      requesterId: REQUESTER.accountId,
      status: 'PENDING_APPROVAL',
    });
    expect(rejected!.record.payload).toMatchObject({ status: 'REJECTED', reason: '금액 확인 필요' });
  });

  test('승인·실행 실패·재시도·완료가 모두 감사 체인에 남는다', async () => {
    const f = fixture();
    const created = await request(f.app);
    f.payments.failExecute = true;
    await expect(f.app.approve(created.approval.approvalId, COMMANDER, TOKEN)).rejects.toMatchObject({ status: 503 });
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['PAYOUT_APPROVAL_REQUESTED', 'PAYOUT_BATCH_EXECUTING', 'PAYOUT_BATCH_FAILED']);

    f.payments.failExecute = false;
    const done = await f.app.approve(created.approval.approvalId, COMMANDER, TOKEN);
    expect(done.status).toBe('DONE');
    expect(f.audit.entries.map((e) => e.recordType)).toEqual([
      'PAYOUT_APPROVAL_REQUESTED',
      'PAYOUT_BATCH_EXECUTING',
      'PAYOUT_BATCH_FAILED',
      'PAYOUT_BATCH_EXECUTING',
      'PAYOUT_BATCH_DONE',
    ]);
    expect(f.audit.entries.at(-1)!.record.payload).toMatchObject({ status: 'DONE', batchId: created.batch.batchId, amount: 24_920_000 });
  });

  test('OPSV-01 EXECUTING·DONE 전이와 감사 기록이 같은 저장 호출로 간다', async () => {
    const f = fixture();
    const created = await request(f.app);
    await f.app.approve(created.approval.approvalId, COMMANDER, TOKEN);
    const executing = f.store.saves.find((s) => s.record.status === 'EXECUTING');
    expect(executing?.record.version).toBe(2);
    expect(executing?.audit).toMatchObject({ recordType: 'PAYOUT_BATCH_EXECUTING', recordId: created.approval.approvalId });
    const done = f.store.saves.find((s) => s.record.status === 'DONE');
    expect(done?.record.version).toBe(3);
    expect(done?.audit).toMatchObject({ recordType: 'PAYOUT_BATCH_DONE', recordId: created.approval.approvalId });
  });

  test('수기 포트원 실행도 실행 ID·금액·행위자와 함께 감사 체인에 남는다', async () => {
    const f = fixture();
    const created = await request(f.app);
    f.payments.batches[0]!.status = 'APPROVED';
    await f.app.recordPortoneExecution(created.batch.batchId, 'bulk-9', COMMANDER.accountId);
    const last = f.audit.entries.at(-1)!;
    expect(last).toMatchObject({ recordType: 'PAYOUT_PORTONE_EXECUTION', recordId: created.batch.batchId });
    expect(last.record.payload).toMatchObject({
      batchId: created.batch.batchId,
      bulkPayoutId: 'bulk-9',
      pg: 'PORTONE',
      status: 'SUBMITTED',
      amount: 24_920_000,
      statementCount: 3,
      actorRef: COMMANDER.accountId,
      basis: 'PORTONE_CONSOLE',
    });
  });
});
