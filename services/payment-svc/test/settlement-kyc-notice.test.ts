// J-T19 KYC 예고(BAT-630 LCH-110, settlement §6). PARTIALLY_APPROVED 셀러의 지급일 앞뒤 6일 토스 지급 합계가
// 1,000만 원 이상일 때만 예고하는지, seller.changed가 셀러 상태를 바꾸는지 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const PROMOTER = randomUUID();
const EVENT = randomUUID();

class FakeApprovals implements PayoutApprovalVerifier {
  async verify(): Promise<undefined> {
    return undefined;
  }
}
class FakeSuspensions implements SaleSuspensionSource {
  async listSuspended(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

const store = new MemorySettlementStore();
const settlements = new Settlements({
  store,
  payments: new MemorySettlementPaymentSource(),
  approvals: new FakeApprovals(),
  saleSuspensions: new FakeSuspensions(),
  gateways: [new UnavailableTossPayoutGateway()],
  reauth: new MemoryReauthVerifier(),
  clock: { now: () => NOW.getTime(), monotonicMs: () => 0 },
});

const statement = (over: Partial<StatementRecord> = {}): StatementRecord => ({
  statementId: randomUUID(),
  promoterId: PROMOTER,
  kind: 'EVENT',
  eventId: EVENT,
  pg: 'TOSS',
  pgStore: 'STANDARD',
  periodStart: null,
  periodEnd: null,
  grossAmount: 20_000_000,
  refundAmount: 0,
  commissionAmount: 2_000_000,
  commissionVat: 200_000,
  offsetAmount: 0,
  payoutAmount: 10_000_000,
  revision: 1,
  supersedesId: null,
  excludedPayments: [],
  status: 'CONFIRMED',
  holdReason: null,
  disputeDueAt: null,
  payoutDate: '2026-11-30',
  payoutBankCode: '004',
  payoutAccountLast4: '1234',
  payoutBatchId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  store.statements.clear();
  store.sources.clear();
  store.kycs.clear();
});

describe('J-T19 KYC 예고', () => {
  test('J-T19 ① PARTIALLY_APPROVED 셀러의 ±6일 토스 지급 합계가 1,000만 원이면 예고한다', async () => {
    await settlements.recordKyc(PROMOTER, 'PENDING', { tossSellerId: 'seller-1', tossSellerStatus: 'PARTIALLY_APPROVED' });
    await store.insertStatement(statement(), []);
    const notice = await settlements.kycNotice(PROMOTER, '2026-11-30');
    expect(notice).toMatchObject({ promoterId: PROMOTER, sellerStatus: 'PARTIALLY_APPROVED', amount: 10_000_000, threshold: 10_000_000, notice: true });
    expect(notice.from).toBe('2026-11-24');
    expect(notice.to).toBe('2026-12-06');
  });

  test('J-T19 ② 999만 원·APPROVED·창 밖이면 예고하지 않는다', async () => {
    await settlements.recordKyc(PROMOTER, 'VERIFIED', { tossSellerId: 'seller-1', tossSellerStatus: 'PARTIALLY_APPROVED' });
    await store.insertStatement(statement({ payoutAmount: 9_990_000 }), []);
    await store.insertStatement(statement({ statementId: randomUUID(), eventId: randomUUID(), payoutDate: '2026-12-20' }), []);
    const notice = await settlements.kycNotice(PROMOTER, '2026-11-30');
    expect(notice.notice).toBe(false);
    expect(notice.amount).toBe(9_990_000);
    // 금액이 1,000만 원을 넘어도 셀러가 APPROVED면 예고하지 않는다.
    await store.insertStatement(statement({ statementId: randomUUID(), eventId: randomUUID(), payoutAmount: 12_000_000, payoutDate: '2026-12-01' }), []);
    await settlements.recordKyc(PROMOTER, 'VERIFIED', { tossSellerStatus: 'APPROVED' });
    const approvedHigh = await settlements.kycNotice(PROMOTER, '2026-11-30');
    expect(approvedHigh.amount).toBe(21_990_000);
    expect(approvedHigh.notice).toBe(false);
  });

  test('J-T19 ③ seller.changed가 PARTIALLY_APPROVED·KYC_REQUIRED·APPROVED를 반영한다', async () => {
    await settlements.recordKyc(PROMOTER, 'PENDING', { tossSellerId: 'seller-1' });
    const partial = await settlements.applySellerChanged('seller-1', 'PARTIALLY_APPROVED');
    expect(partial).toMatchObject({ promoterId: PROMOTER, tossSellerStatus: 'PARTIALLY_APPROVED' });
    const required = await settlements.applySellerChanged('seller-1', 'KYC_REQUIRED');
    expect(required?.tossSellerStatus).toBe('KYC_REQUIRED');
    const approved = await settlements.applySellerChanged('seller-1', 'APPROVED');
    expect(approved?.tossSellerStatus).toBe('APPROVED');
    expect(approved?.status).toBe('VERIFIED');
  });
});
