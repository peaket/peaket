// J-T34 토스페이먼츠 지급대행(BAT-630 LCH-110, settlement §5.2·§8).
// 10억 원 미만 분할·요청당 20건·같은 지급 건의 같은 멱등키·실패 세 갈래·서명 웹훅과 단건 조회를
// 실제 계정 없이 포트 대역으로 본다. 실제 키·계약은 운영 전이다.
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { KycRecord, PayoutRecord } from '../src/modules/settlement/domain/settlement.js';
import {
  classifyTossFailure,
  groupTossPayoutRequests,
  parseTossSettlementWebhook,
  splitTossPayoutAmount,
  verifyTossPayoutSignature,
} from '../src/modules/settlement/domain/payout-adapters.js';
import { ReceiveSettlementWebhook, TossPayoutGateway, type TossPayoutTransport } from '../src/modules/settlement/adapters/toss-payout-gateway.js';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore } from '../src/modules/settlement/index.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';

const payout = (amount: number, seq = 1): PayoutRecord => ({
  payoutId: randomUUID(),
  batchId: 'batch-1',
  statementId: 'statement-1',
  seq,
  amount,
  refPayoutId: `statement-1-${seq}`,
  pgPayoutId: null,
  status: 'REQUESTED',
  errorCode: null,
  pgTransferId: null,
  transferCheck: null,
  transferCheckedAt: null,
  createdAt: new Date('2026-11-22T00:00:00.000Z'),
  updatedAt: new Date('2026-11-22T00:00:00.000Z'),
});

const kyc = (over: Partial<KycRecord> = {}): KycRecord => ({
  promoterId: 'promoter-1',
  status: 'PENDING',
  businessVerified: false,
  representativeVerified: false,
  legalName: null,
  representative: null,
  verifiedAt: null,
  source: 'TOSS',
  updatedAt: new Date('2026-11-22T00:00:00.000Z'),
  tossSellerId: 'seller-1',
  tossSellerStatus: 'PARTIALLY_APPROVED',
  ...over,
});

class FakeTransport implements TossPayoutTransport {
  readonly requests: { refs: string[]; payoutDate: string; idempotencyKey: string }[] = [];
  readonly requested: string[] = [];
  lookup: Record<string, { status: 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED'; errorCode?: string }> = {};
  async requestPayouts(input: { payouts: readonly PayoutRecord[]; payoutDate: string; idempotencyKey: string }) {
    this.requests.push({ refs: input.payouts.map((p) => p.refPayoutId), payoutDate: input.payoutDate, idempotencyKey: input.idempotencyKey });
    for (const p of input.payouts) this.requested.push(p.refPayoutId);
    return { pgPayoutIds: Object.fromEntries(input.payouts.map((p) => [p.payoutId, `toss-${p.refPayoutId}`])) };
  }
  async getPayout(pgPayoutId: string) {
    return { pgPayoutId, ...(this.lookup[pgPayoutId] ?? { status: 'IN_PROGRESS' as const }) };
  }
  async cancelPayout(pgPayoutId: string) {
    return { pgPayoutId, status: 'CANCELED' as const };
  }
}

describe('J-T34 토스 지급대행', () => {
  test('J-T34 ① 25억 원을 10억 미만 3건으로 나누고 요청당 20건까지 보낸다', async () => {
    expect(splitTossPayoutAmount(2_500_000_000)).toEqual([999_999_999, 999_999_999, 500_000_002]);
    const rows = splitTossPayoutAmount(2_500_000_000).map((amount, i) => payout(amount, i + 1));
    expect(rows).toHaveLength(3);
    const groups = groupTossPayoutRequests([...rows, ...Array.from({ length: 18 }, () => payout(1_000, 1))]);
    expect(groups.map((g) => g.length)).toEqual([20, 1]);
  });

  test('J-T34 ① 실행이 25억 원 정산서를 10억 미만 3건으로 만들어 결제사에 보낸다', async () => {
    const store = new MemorySettlementStore();
    const transport = new FakeTransport();
    const settlements = new Settlements({
      store,
      payments: new MemorySettlementPaymentSource(),
      approvals: { verify: async () => undefined } satisfies PayoutApprovalVerifier,
      saleSuspensions: { listSuspended: async () => new Set() } satisfies SaleSuspensionSource,
      gateways: [new TossPayoutGateway(transport)],
      reauth: new MemoryReauthVerifier(),
      clock: { now: () => new Date('2026-11-22T00:00:00.000Z').getTime(), monotonicMs: () => 0 },
    });
    const statement = {
      statementId: 'statement-1',
      promoterId: 'promoter-1',
      kind: 'EVENT' as const,
      eventId: 'event-1',
      pg: 'TOSS' as const,
      pgStore: 'STANDARD' as const,
      periodStart: null,
      periodEnd: null,
      grossAmount: 2_500_000_000,
      refundAmount: 0,
      commissionAmount: 0,
      commissionVat: 0,
      offsetAmount: 0,
      payoutAmount: 2_500_000_000,
      revision: 1,
      supersedesId: null,
      excludedPayments: [],
      status: 'SCHEDULED' as const,
      holdReason: null,
      disputeDueAt: null,
      payoutDate: '2026-12-01',
      payoutBankCode: '004',
      payoutAccountLast4: '1234',
      payoutBatchId: 'batch-1',
      createdAt: new Date('2026-11-22T00:00:00.000Z'),
      updatedAt: new Date('2026-11-22T00:00:00.000Z'),
    };
    await store.saveStatement(statement);
    await store.savePayoutBatch({ ...batch(), totalAmount: 2_500_000_000, statementCount: 1, status: 'APPROVED' });
    const result = await settlements.executeBatch('batch-1');
    expect(result.status).toBe('SUBMITTED');
    const payouts = await store.listPayouts('batch-1');
    expect(payouts.map((p) => p.amount)).toEqual([999_999_999, 999_999_999, 500_000_002]);
    expect(payouts.map((p) => p.refPayoutId)).toEqual(['statement-1-1', 'statement-1-2', 'statement-1-3']);
    expect(transport.requests.flatMap((r) => r.refs)).toEqual(['statement-1-1', 'statement-1-2', 'statement-1-3']);
  });

  test('J-T34 ② 같은 지급 건은 같은 멱등키를 쓰고, 새 순번은 새 키를 쓴다', async () => {
    const transport = new FakeTransport();
    const gateway = new TossPayoutGateway(transport);
    const rows = [payout(10_000), payout(10_000, 2)];
    await gateway.submit({ batch: batch(), payouts: rows });
    await gateway.submit({ batch: batch(), payouts: rows });
    expect(transport.requests[0]?.refs).toEqual(rows.map((p) => p.refPayoutId));
    expect(transport.requests[1]?.refs).toEqual(rows.map((p) => p.refPayoutId));
    expect(transport.requests[0]?.idempotencyKey).toBe(transport.requests[1]?.idempotencyKey);
    const retry = payout(10_000, 3);
    await gateway.submit({ batch: batch(), payouts: [retry] });
    expect(transport.requests[2]?.refs).toEqual(['statement-1-3']);
    expect(transport.requests[2]?.idempotencyKey).not.toBe(transport.requests[0]?.idempotencyKey);
  });

  test('J-T34 ③ 실패 이유를 계좌·일시·한도/KYC 세 갈래로 나눈다', () => {
    expect(classifyTossFailure('ACCOUNT_CLOSED')).toBe('ACCOUNT');
    expect(classifyTossFailure('BANK_NOT_FOUND')).toBe('ACCOUNT');
    expect(classifyTossFailure('BANK_MAINTENANCE')).toBe('TRANSIENT');
    expect(classifyTossFailure('TEMPORARY_ERROR')).toBe('TRANSIENT');
    expect(classifyTossFailure('KYC_REQUIRED')).toBe('LIMIT_KYC');
    expect(classifyTossFailure('LIMIT_EXCEEDED')).toBe('LIMIT_KYC');
    expect(classifyTossFailure('SOMETHING_NEW')).toBe('UNKNOWN');
  });

  test('J-T34 ④ 서명 웹훅은 본문을 믿지 않고 단건 조회로 확정하며 seller.changed가 KYC를 바꾼다', async () => {
    const now = new Date('2026-11-22T00:00:00.000Z');
    const transport = new FakeTransport();
    transport.lookup['toss-1'] = { status: 'FAILED', errorCode: 'ACCOUNT_CLOSED' };
    const saved: PayoutRecord[] = [];
    const kycs: KycRecord[] = [];
    const seen = new Set<string>();
    const receiver = new ReceiveSettlementWebhook({
      secrets: ['secret-1'],
      transport,
      now: () => now,
      store: {
        findPayoutByPgPayoutId: async (id) => (id === 'toss-1' ? payout(10_000) : undefined),
        savePayout: async (p) => void saved.push(p),
        findKycByTossSellerId: async (id) => (id === 'seller-1' ? kyc() : undefined),
        saveKyc: async (k) => void kycs.push(k),
        hasReceipt: async (id) => seen.has(id),
        recordReceipt: async (id) => void seen.add(id),
      },
    });
    const body = JSON.stringify({ eventType: 'payout.changed', data: { payoutId: 'toss-1', status: 'COMPLETED' } });
    const signature = sign(body, 'secret-1');
    const answer = await receiver.receive(
      { 'tosspayments-webhook-signature': `v1:${signature}`, 'tosspayments-webhook-transmission-time': now.toISOString(), 'tosspayments-webhook-transmission-id': 't-1' },
      Buffer.from(body),
    );
    expect(answer).toBe('ACCEPTED');
    expect(saved.at(-1)?.status).toBe('FAILED');
    expect(saved.at(-1)?.errorCode).toBe('ACCOUNT_CLOSED');

    const sellerBody = JSON.stringify({ eventType: 'seller.changed', data: { sellerId: 'seller-1', status: 'KYC_REQUIRED' } });
    const sellerAnswer = await receiver.receive(
      { 'tosspayments-webhook-signature': `v1:${sign(sellerBody, 'secret-1')}`, 'tosspayments-webhook-transmission-time': now.toISOString(), 'tosspayments-webhook-transmission-id': 't-2' },
      Buffer.from(sellerBody),
    );
    expect(sellerAnswer).toBe('ACCEPTED');
    expect(kycs.at(-1)?.tossSellerStatus).toBe('KYC_REQUIRED');

    const bad = await receiver.receive(
      { 'tosspayments-webhook-signature': 'v1:bad', 'tosspayments-webhook-transmission-time': now.toISOString(), 'tosspayments-webhook-transmission-id': 't-3' },
      Buffer.from(body),
    );
    expect(bad).toBe('REJECTED');
    expect(parseTossSettlementWebhook(body)?.kind).toBe('PAYOUT');
    expect(verifyTossPayoutSignature({ signature: `v1:${signature}`, secrets: ['secret-1'], body, transmissionTime: now.toISOString(), now })).toBe('OK');
  });
});

function batch() {
  return {
    batchId: 'batch-1',
    pg: 'TOSS' as const,
    pgStore: 'STANDARD' as const,
    payoutDate: '2026-12-01',
    totalAmount: 20_000,
    statementCount: 1,
    approvalId: 'approval-1',
    portoneBulkPayoutId: null,
    pgBalanceKrw: null,
    pgBalanceSource: null,
    pgBalanceObservedAt: null,
    pgBalanceObservedBy: null,
    pgBalanceLedgerKrw: null,
    status: 'APPROVED' as const,
    createdAt: new Date('2026-11-22T00:00:00.000Z'),
    updatedAt: new Date('2026-11-22T00:00:00.000Z'),
  };
}

function sign(body: string, secret: string): string {
  // 웹훅 서명과 같은 HMAC-SHA256 base64
  return createHmac('sha256', secret).update(body).digest('base64');
}
