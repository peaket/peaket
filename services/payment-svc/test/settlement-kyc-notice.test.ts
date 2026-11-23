// J-T19 KYC 예고(BAT-630 LCH-110, settlement §6). PARTIALLY_APPROVED 셀러의 지급일 앞뒤 6일 토스 지급 합계가
// 1,000만 원 이상일 때만 예고하는지, seller.changed가 셀러 상태를 바꾸는지 본다.
// F-07-6(ADR-0369 결정 3·4): 셀러는 파트너·결제 상점마다 toss_seller 한 행이고, 예고는 그 묶음 상점의 셀러 상태로 본다.
// seller.changed(단건 조회 결과 applyTossSellerFact)는 toss_seller만 바꾸고 PEAKET 판매자 확인(seller_kyc)은 바꾸지 않는다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import type { StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { MemoryReauthVerifier, MemorySettlementPaymentSource, MemorySettlementStore, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { seedTossSeller } from './settlement-support.js';

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
  store.tossSellers.clear();
});

describe('J-T19 KYC 예고', () => {
  test('J-T19 ① PARTIALLY_APPROVED 셀러의 ±6일 토스 지급 합계가 1,000만 원이면 예고한다', async () => {
    await settlements.recordKyc(PROMOTER, 'PENDING');
    await seedTossSeller(store, PROMOTER, { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED', tossSellerId: 'seller-1' });
    await store.insertStatement(statement(), []);
    const notice = await settlements.kycNotice(PROMOTER, '2026-11-30', 'STANDARD');
    expect(notice).toMatchObject({ promoterId: PROMOTER, sellerStatus: 'PARTIALLY_APPROVED', amount: 10_000_000, threshold: 10_000_000, notice: true });
    expect(notice.from).toBe('2026-11-24');
    expect(notice.to).toBe('2026-12-06');
  });

  test('J-T19 ② 999만 원·APPROVED·창 밖이면 예고하지 않는다', async () => {
    await settlements.recordKyc(PROMOTER, 'VERIFIED');
    await seedTossSeller(store, PROMOTER, { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED', tossSellerId: 'seller-1' });
    await store.insertStatement(statement({ payoutAmount: 9_990_000 }), []);
    await store.insertStatement(statement({ statementId: randomUUID(), eventId: randomUUID(), payoutDate: '2026-12-20' }), []);
    const notice = await settlements.kycNotice(PROMOTER, '2026-11-30', 'STANDARD');
    expect(notice.notice).toBe(false);
    expect(notice.amount).toBe(9_990_000);
    // 금액이 1,000만 원을 넘어도 셀러가 APPROVED면 예고하지 않는다.
    await store.insertStatement(statement({ statementId: randomUUID(), eventId: randomUUID(), payoutAmount: 12_000_000, payoutDate: '2026-12-01' }), []);
    await seedTossSeller(store, PROMOTER, { pgStore: 'STANDARD', status: 'APPROVED', tossSellerId: 'seller-1' });
    const approvedHigh = await settlements.kycNotice(PROMOTER, '2026-11-30', 'STANDARD');
    expect(approvedHigh.amount).toBe(21_990_000);
    expect(approvedHigh.notice).toBe(false);
  });

  test('J-T19 ② 예고는 그 묶음 상점의 셀러 상태로 본다(에스크로 셀러가 APPROVED여도 일반 상점이 PARTIALLY_APPROVED면 일반 상점 묶음에 예고)', async () => {
    await settlements.recordKyc(PROMOTER, 'VERIFIED');
    await seedTossSeller(store, PROMOTER, { pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED', tossSellerId: 'seller-std' });
    await seedTossSeller(store, PROMOTER, { pgStore: 'ESCROW', status: 'APPROVED', tossSellerId: 'seller-esc' });
    await store.insertStatement(statement({ payoutAmount: 10_000_001 }), []);
    expect(await settlements.kycNotice(PROMOTER, '2026-11-30', 'STANDARD')).toMatchObject({ sellerStatus: 'PARTIALLY_APPROVED', notice: true });
    expect(await settlements.kycNotice(PROMOTER, '2026-11-30', 'ESCROW')).toMatchObject({ sellerStatus: 'APPROVED', notice: false });
  });

  test('J-T19 ③ seller.changed(단건 조회 결과)가 PARTIALLY_APPROVED·KYC_REQUIRED·APPROVED를 그 상점 toss_seller에 반영하고 seller_kyc는 그대로다', async () => {
    await settlements.recordKyc(PROMOTER, 'PENDING');
    await seedTossSeller(store, PROMOTER, { pgStore: 'STANDARD', status: 'PENDING', tossSellerId: 'seller-1' });
    for (const status of ['PARTIALLY_APPROVED', 'KYC_REQUIRED', 'APPROVED'] as const) {
      await settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: 'seller-1', status, checkedAt: NOW });
      expect([status, store.tossSellers.get(`${PROMOTER}:STANDARD`)?.status]).toEqual([status, status]);
    }
    expect(store.kycs.get(PROMOTER)).toMatchObject({ status: 'PENDING', businessVerified: false, representativeVerified: false });
  });
});
