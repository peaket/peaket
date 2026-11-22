// J-T31 지급 묶음 승인 ID 대조(BAT-625 LCH-100, W12-mesh RV-01, POL-038, ASVS 2.3.3·2.3.4·8.2.1·16.3.3).
// 돈이 움직이는 경로라 시험을 먼저 쓴다. 승인 기록과 어긋난 ID·정족수 미달·ops 5xx·재사용에서
// payout_batch 상태가 바뀌지 않는지, 같은 승인 ID 재요청이 처음 결과를 돌려주는지, 감사·실패 로그가 남는지 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import { SettlementProblem, payoutBatchView, type PayoutBatchAuditRecord, type PaymentFact } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource, SettlementApprovalLog, VerifiedPayoutApproval } from '../src/modules/settlement/domain/ports.js';
import {
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  UnavailableTossPayoutGateway,
} from '../src/modules/settlement/index.js';
import { HttpPayoutApprovalVerifier } from '../src/modules/settlement/adapters/http-payout-approval-verifier.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();

// F-07-5 리뷰 RV-01(정본 §4.1 '전액 취소된 결제'): 판매 대금은 승인 시각이 있는 결제만 센다. 결제 원장 사실에 승인 시각을 싣는다(펼침이라 칸이 생기기 전·후 모두 타입이 맞는다)
const APPROVED = { approvedAt: new Date('2026-11-01T00:00:00.000Z') as Date | null };
const fact = (amount = 10_000_000): PaymentFact => ({ paymentId: randomUUID(), amount, cancelledAmount: 0, status: 'APPROVED', failureCategory: null, ...APPROVED });

class FakeSaleSuspensions implements SaleSuspensionSource {
  suspended = new Set<string>();
  fail = false;
  async listSuspended(eventIds: readonly string[]) {
    if (this.fail) throw new SettlementProblem('dependency-unavailable', 503, '판매 중지 상태를 확인할 수 없습니다');
    return new Set(eventIds.filter((id) => this.suspended.has(id)));
  }
}

class FakeApprovals implements PayoutApprovalVerifier {
  readonly rows = new Map<string, VerifiedPayoutApproval>();
  calls = 0;
  fail = false;
  rawError = false;
  async verify(approvalId: string): Promise<VerifiedPayoutApproval | undefined> {
    this.calls += 1;
    if (this.rawError) throw new Error('verifier-crashed');
    if (this.fail) throw new SettlementProblem('dependency-unavailable', 503, '승인 기록을 확인할 수 없습니다');
    return this.rows.get(approvalId);
  }
}

class RecordingLog implements SettlementApprovalLog {
  readonly approvedLogs: { batchId: string; approvalId: string; requesterId: string; approverId: string; amount: number }[] = [];
  readonly rejectedLogs: { batchId: string; approvalId: string; reason: string }[] = [];
  approved(o: { batchId: string; approvalId: string; requesterId: string; approverId: string; amount: number }): void {
    this.approvedLogs.push(o);
  }
  rejected(o: { batchId: string; approvalId: string; reason: string }): void {
    this.rejectedLogs.push(o);
  }
}

const store = new MemorySettlementStore();
const payments = new MemorySettlementPaymentSource();
const approvals = new FakeApprovals();
const suspensions = new FakeSaleSuspensions();
const log = new RecordingLog();

const settlements = new Settlements({
  store,
  payments,
  approvals,
  saleSuspensions: suspensions,
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: new MemoryReauthVerifier(),
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
  commissionRateBp: 1000,
  log,
});

beforeEach(async () => {
  store.statements.clear();
  store.sources.clear();
  store.batches.clear();
  store.payouts.clear();
  store.payoutBatchAudits.length = 0;
  payments.rows.clear();
  approvals.rows.clear();
  approvals.calls = 0;
  approvals.fail = false;
  approvals.rawError = false;
  suspensions.suspended.clear();
  suspensions.fail = false;
  log.approvedLogs.length = 0;
  log.rejectedLogs.length = 0;
  await settlements.recordKyc(PROMOTER, 'VERIFIED');
  payments.set(EVENT, 'TOSS', [fact()], 'STANDARD');
  payments.set(EVENT, 'TOSS', [fact()], 'ESCROW');
});

const makeBatch = async (pgStore: 'STANDARD' | 'ESCROW' = 'STANDARD') => {
  const s = await settlements.calculateEvent({ promoterId: PROMOTER, eventId: EVENT, pg: 'TOSS', pgStore });
  await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
  return settlements.createPayoutBatch({ pg: 'TOSS', pgStore, payoutDate: s.payoutDate!, actor: randomUUID() });
};

const approvalFor = (batch: ReturnType<typeof payoutBatchView>, over: Partial<VerifiedPayoutApproval> = {}): VerifiedPayoutApproval => {
  const approval: VerifiedPayoutApproval = {
    approvalId: randomUUID(),
    kind: 'PAYOUT_BATCH',
    targetRef: batch.batchId,
    batchId: batch.batchId,
    pg: batch.pg,
    pgStore: batch.pgStore,
    payoutDate: batch.payoutDate,
    currency: 'KRW',
    amount: batch.totalAmount,
    statementCount: batch.statementCount,
    status: 'EXECUTING',
    requiredApprovals: 2,
    requestedBy: randomUUID(),
    approvals: [randomUUID()],
    approvedAt: NOW.toISOString(),
    ...over,
  };
  approvals.rows.set(approval.approvalId, approval);
  return approval;
};

const stillPending = async (batchId: string) => {
  const b = await store.findPayoutBatch(batchId);
  expect(b).toMatchObject({ status: 'PENDING_APPROVAL', approvalId: null });
};

describe('J-T31 지급 묶음 승인 ID 대조', () => {
  test('J-T31 ① ops 승인 기록(종류·대상·금액·통화·건수·결제사·2인 승인)과 맞는 승인 ID만 통과한다', async () => {
    const batch = await makeBatch();
    const approval = approvalFor(batch);
    const out = await settlements.approveBatch(batch.batchId, approval.approvalId);
    expect(out).toMatchObject({ batchId: batch.batchId, status: 'APPROVED', approvalId: approval.approvalId });
    expect(await store.findPayoutBatch(batch.batchId)).toMatchObject({ status: 'APPROVED', approvalId: approval.approvalId });
    expect(log.approvedLogs).toEqual([
      expect.objectContaining({ batchId: batch.batchId, approvalId: approval.approvalId, requesterId: approval.requestedBy, approverId: approval.approvals[0], amount: batch.totalAmount }),
    ]);
    expect(log.rejectedLogs).toEqual([]);
  });

  test('J-T31 ② 없는 승인·다른 배치·금액·통화·건수·결제사·지급일이 다르면 4xx이고 상태를 바꾸지 않는다', async () => {
    const batch = await makeBatch();
    const cases: { name: string; approval?: VerifiedPayoutApproval | undefined; id?: string }[] = [
      { name: '없는 승인 ID', id: randomUUID() },
      { name: '다른 배치', approval: approvalFor(batch, { batchId: randomUUID(), targetRef: randomUUID() }) },
      { name: '종류', approval: approvalFor(batch, { kind: 'CONTRACT_TERMS_CHANGE' as never }) },
      { name: '금액', approval: approvalFor(batch, { amount: batch.totalAmount + 1 }) },
      { name: '통화', approval: approvalFor(batch, { currency: 'USD' as never }) },
      { name: '건수', approval: approvalFor(batch, { statementCount: batch.statementCount + 1 }) },
      { name: '결제사', approval: approvalFor(batch, { pg: 'PORTONE' as never }) },
      { name: '상점', approval: approvalFor(batch, { pgStore: 'ESCROW' as never }) },
      { name: '지급일', approval: approvalFor(batch, { payoutDate: '2026-11-21' }) },
    ];
    for (const c of cases) {
      const id = c.id ?? c.approval!.approvalId;
      await expect(settlements.approveBatch(batch.batchId, id)).rejects.toMatchObject({ status: expect.any(Number) });
      await stillPending(batch.batchId);
    }
    expect(log.rejectedLogs).toHaveLength(cases.length);
    expect(store.payoutBatchAudits.filter((a) => a.event === 'REJECTED')).toHaveLength(cases.length);
  });

  test('J-T31 ③ 정족수 미달(승인자 없음·요청자=승인자·requiredApprovals≠2·승인 시각 없음)은 4xx다', async () => {
    const batch = await makeBatch();
    const requester = randomUUID();
    const cases: VerifiedPayoutApproval[] = [
      approvalFor(batch, { approvals: [] }),
      approvalFor(batch, { requestedBy: requester, approvals: [requester] }),
      approvalFor(batch, { requiredApprovals: 1 }),
      approvalFor(batch, { approvedAt: null }),
    ];
    for (const approval of cases) {
      await expect(settlements.approveBatch(batch.batchId, approval.approvalId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-approval-') });
      await stillPending(batch.batchId);
    }
  });

  test('J-T31 ④ ops-svc가 5xx·시간 초과면 503이고 아무것도 바꾸지 않는다', async () => {
    const batch = await makeBatch();
    approvals.fail = true;
    await expect(settlements.approveBatch(batch.batchId, randomUUID())).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
    await stillPending(batch.batchId);
    expect(store.payoutBatchAudits.filter((a) => a.event === 'REJECTED')).toHaveLength(1);
    expect(log.rejectedLogs).toHaveLength(1);
  });

  test('J-T31 ④(알 수 없는 오류) 확인기가 SettlementProblem이 아닌 오류를 던져도 503으로 닫고 상태를 바꾸지 않는다', async () => {
    const batch = await makeBatch();
    approvals.rawError = true;
    await expect(settlements.approveBatch(batch.batchId, randomUUID())).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
    await stillPending(batch.batchId);
    expect(store.payoutBatchAudits.filter((a) => a.event === 'REJECTED')).toHaveLength(1);
  });

  test('J-T31 ⑤ 같은 승인 ID 재요청은 처음 결과 그대로이고, 다른 배치 재사용은 409다', async () => {
    const first = await makeBatch('STANDARD');
    const second = await makeBatch('ESCROW');
    const approval = approvalFor(first);
    await settlements.approveBatch(first.batchId, approval.approvalId);
    const callsAfterFirst = approvals.calls;
    const again = await settlements.approveBatch(first.batchId, approval.approvalId);
    expect(again).toMatchObject({ status: 'APPROVED', approvalId: approval.approvalId });
    expect(approvals.calls).toBe(callsAfterFirst);
    expect(store.payoutBatchAudits.filter((a) => a.event === 'APPROVED')).toHaveLength(1);

    await expect(settlements.approveBatch(second.batchId, approval.approvalId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-approval-') });
    await stillPending(second.batchId);

    // 이미 다른 승인으로 처리된 배치에는 새 승인 ID를 받지 않는다
    const another = approvalFor(first);
    await expect(settlements.approveBatch(first.batchId, another.approvalId)).rejects.toMatchObject({ status: 409 });
  });

  test('J-T31 ⑥ 성공·거절마다 누가·언제·어떤 승인 ID·금액을 감사와 로그에 남긴다', async () => {
    const batch = await makeBatch();
    const rejected = approvalFor(batch, { amount: batch.totalAmount + 1 });
    await expect(settlements.approveBatch(batch.batchId, rejected.approvalId)).rejects.toMatchObject({ status: 409 });
    const passed = approvalFor(batch);
    await settlements.approveBatch(batch.batchId, passed.approvalId);

    const approvedAudit = store.payoutBatchAudits.find((a) => a.event === 'APPROVED') as PayoutBatchAuditRecord;
    expect(approvedAudit).toMatchObject({
      batchId: batch.batchId,
      approvalId: passed.approvalId,
      requesterId: passed.requestedBy,
      approverId: passed.approvals[0],
      amount: batch.totalAmount,
      currency: 'KRW',
      createdAt: NOW,
    });
    const rejectedAudit = store.payoutBatchAudits.find((a) => a.event === 'REJECTED') as PayoutBatchAuditRecord;
    expect(rejectedAudit).toMatchObject({ batchId: batch.batchId, approvalId: rejected.approvalId, currency: 'KRW', createdAt: NOW });
    expect(rejectedAudit.reason).toMatch(/payout-approval-/);
    expect(JSON.stringify(store.payoutBatchAudits)).not.toMatch(/token|계좌번호/i);
  });

  test('J-T31 ④(어댑터) ops 5xx·모양 위반·시간 초과는 503, 404는 undefined, 정상 응답은 그대로 읽는다', async () => {
    const body = (over: Record<string, unknown> = {}) => ({
      approvalId: 'AP-1',
      kind: 'PAYOUT_BATCH',
      targetRef: 'B-1',
      batchId: 'B-1',
      pg: 'TOSS',
      pgStore: 'STANDARD',
      payoutDate: '2026-11-20',
      currency: 'KRW',
      amount: 1000,
      statementCount: 1,
      status: 'EXECUTING',
      requiredApprovals: 2,
      requestedBy: 'U-1',
      approvals: ['U-2'],
      approvedAt: NOW.toISOString(),
      ...over,
    });
    const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const verifierFor = (fetchImpl: typeof fetch, timeoutCapMs = 50) => new HttpPayoutApprovalVerifier('http://ops-svc:8080', 'internal-token', fetchImpl, timeoutCapMs);

    expect(await verifierFor(async () => response(200, body())).verify('AP-1')).toMatchObject({ approvalId: 'AP-1', kind: 'PAYOUT_BATCH', amount: 1000, currency: 'KRW' });
    expect(await verifierFor(async () => response(404, { type: 'not-found' })).verify('AP-1')).toBeUndefined();
    await expect(verifierFor(async () => response(500, { type: 'server-error' })).verify('AP-1')).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
    await expect(verifierFor(async () => response(200, { approvalId: 'AP-1' })).verify('AP-1')).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
    await expect(
      verifierFor(async () => {
        throw new DOMException('aborted', 'AbortError');
      }).verify('AP-1'),
    ).rejects.toMatchObject({ status: 503, type: expect.stringContaining('dependency-unavailable') });
  });
});
