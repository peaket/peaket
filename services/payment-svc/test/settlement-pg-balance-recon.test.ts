// J-T25 ①②③ 토스 결제 상점별 결제사 잔액 대사(F-07-6 LCH-110, settlement §5.5·§11, ADR-0369 결정 2·11).
// 있어야 할 잔액 = 대사 끝난 승인 − 취소·환불 − 결제사 수수료(정산 조회 fees + 지급대행 이용료) − 완료한 지급 − PEAKET 몫 인출(0).
// 결제사가 보여 주는 잔액 = 잔액 조회의 지급 가능 + 정산 대기. 차이 0이면 건 없음, 0이 아니면 CS PG_BALANCE_MISMATCH, 절댓값 1만 원을 넘으면 SEV3.
// 장부 원천(PgLedgerSource)은 경계 짝 가짜다(진짜 DrizzlePgLedgerSource는 test-int가 실제 PostgreSQL로 본다). 결제사는 대역 서버다.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { SettlementDueWorker } from '../src/modules/settlement/index.js';
import type { PgLedgerSource } from '../src/modules/settlement/domain/ports.js';
import type { Pg, PgStore } from '../src/modules/settlement/domain/settlement.js';
import { kst, tossHarness, type TossHarness, type TossHarnessOptions } from './support/toss-harness.js';

const CUTOFF = kst('2026-11-30T22:00:00.000');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMS = { feeMonthlyKrw: 250_000, feeFreeCount: 7, feePerItemKrw: 130 };

/** 장부 원천의 짝 가짜(포트 PgLedgerSource). 상점마다 정한 누적값을 준다 */
class FakeLedger implements PgLedgerSource {
  readonly calls: { pg: Pg; pgStore: PgStore; cutoffAt: Date }[] = [];
  readonly rows = new Map<PgStore, { approvedAmount: number; refundedAmount: number; paidOutAmount: number; payoutCountByMonth: Record<string, number>; firstPaymentAt: Date | null }>();
  async ledger(input: { pg: Pg; pgStore: PgStore; cutoffAt: Date }) {
    this.calls.push(input);
    return this.rows.get(input.pgStore) ?? { approvedAmount: 0, refundedAmount: 0, paidOutAmount: 0, payoutCountByMonth: {}, firstPaymentAt: null };
  }
}

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * 장부: 승인 50,000,000 − 환불 2,000,000 − 수수료(정산 조회 1,234,560 + 이용료) − 지급 30,000,000.
 * 이용료(시험 설정 월 250,000·무료 7건·건당 130원, 11월 지급 10건) = 250,000 + 3 × 130 = 250,390 → 있어야 할 잔액 16,515,050
 */
async function shop(o: { observed: number; terms?: TossHarnessOptions['terms'] | null; count?: number; now?: number } = { observed: 16_515_050 }) {
  const ledger = new FakeLedger();
  const x = (h = await tossHarness({ now: o.now ?? CUTOFF, ledger, ...(o.terms === null ? {} : { terms: o.terms ?? TERMS }) }));
  for (const s of ['STANDARD', 'ESCROW'] as const) {
    ledger.rows.set(s, { approvedAmount: 50_000_000, refundedAmount: 2_000_000, paidOutAmount: 30_000_000, payoutCountByMonth: { '2026-11': o.count ?? 10 }, firstPaymentAt: new Date(kst('2026-11-03T12:00:00.000')) });
    x.fake.settlementRows[s] = [
      { paymentKey: 'pk-1', amount: 40_000_000, fee: 1_000_000 },
      { paymentKey: 'pk-2', amount: 10_000_000, fee: 234_560 },
    ];
    x.fake.balances[s] = { available: o.observed - 515_050, pending: 515_050 };
  }
  return { x, ledger };
}

describe('J-T25 결제사 잔액 대사', () => {
  test('J-T25 ① 장부와 맞는 상점은 차이 0·NONE이고 CS 건이 없으며, 대사 행에 누적값·있어야 할 잔액·보이는 잔액이 남는다', async () => {
    const { x, ledger } = await shop({ observed: 16_515_050 });
    const record = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01' });
    expect(record).toMatchObject({
      pg: 'TOSS',
      pgStore: 'STANDARD',
      kind: 'MONTHLY',
      periodMonth: '2026-11-01',
      cutoffAt: new Date(CUTOFF),
      approvedAmount: 50_000_000,
      refundedAmount: 2_000_000,
      pgFeeAmount: 1_234_560 + 250_390,
      paidOutAmount: 30_000_000,
      peaketWithdrawnAmount: 0,
      expectedAmount: 16_515_050,
      observedAmount: 16_515_050,
      diffAmount: 0,
      severity: 'NONE',
    });
    expect(x.store.pgBalanceReconciliations).toHaveLength(1);
    expect(x.cases('PG_BALANCE_MISMATCH')).toEqual([]);
    expect(ledger.calls).toEqual([{ pg: 'TOSS', pgStore: 'STANDARD', cutoffAt: new Date(CUTOFF) }]);
    // 첫 대사의 수수료 기간은 그 상점의 첫 결제일부터 대사 시각까지다
    const fees = x.fake.calls('GET', /^\/v1\/settlements$/);
    expect(fees.map((r) => [r.store, r.query.startDate, r.query.endDate])).toEqual([['STANDARD', '2026-11-03', '2026-11-30']]);
    expect(await x.metricValue('settlement_pg_balance_diff_krw', { pg: 'TOSS', store: 'STANDARD' })).toBe(0);
  });

  test('J-T25 ② 결제사 잔액만 3만 원 적으면 CS PG_BALANCE_MISMATCH 한 건(대상 TOSS:{상점}, 사건 키 = 대사 행 ID)·SEV3이고, 묶음 때의 대사는 묶음을 멈추지 않는다', async () => {
    const { x } = await shop({ observed: 16_515_050 - 30_000 });
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const s = await x.confirmed({ promoterId, amount: 1_000_000, payoutDate: '2026-12-07' });
    x.fake.balances.STANDARD = { available: 900_000_000, pending: 0 };
    const batch = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-07', actor: randomUUID() });
    x.fake.balances.STANDARD = { available: 16_515_050 - 30_000 - 515_050, pending: 515_050 };
    const record = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'BATCH', batchId: batch.batchId });
    expect(record).toMatchObject({ kind: 'BATCH', batchId: batch.batchId, expectedAmount: 16_515_050, observedAmount: 16_485_050, diffAmount: -30_000, severity: 'SEV3' });
    const cases = x.cases('PG_BALANCE_MISMATCH');
    expect(cases).toEqual([expect.objectContaining({ kind: 'PG_BALANCE_MISMATCH', sourceId: 'TOSS:STANDARD', requestedAt: null })]);
    expect(cases[0]!.eventKey).toMatch(UUID);
    // 사건 키 = 대사 행 ID(reconciliationId, 계획 §5.1 (라)·(바), 시험 리뷰 TR-15)
    expect(cases[0]!.eventKey).toBe(record!.reconciliationId);
    expect(x.store.batches.get(batch.batchId)?.status).toBe('PENDING_APPROVAL');
    expect(x.store.statements.get(s.statementId)?.payoutBatchId).toBe(batch.batchId);
    expect(await x.metricValue('settlement_pg_balance_diff_krw', { pg: 'TOSS', store: 'STANDARD' })).toBe(-30_000);
  });

  test('J-T25 ③ 끝수 1원 차이는 CS 건(CASE, SEV3 아님)이고, 같은 달 두 번째 월 대사는 행·건 0이다', async () => {
    const { x } = await shop({ observed: 16_515_049 });
    const first = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01' });
    expect(first).toMatchObject({ diffAmount: -1, severity: 'CASE' });
    expect(x.cases('PG_BALANCE_MISMATCH')).toHaveLength(1);
    expect(await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01' })).toBeUndefined();
    expect(x.store.pgBalanceReconciliations).toHaveLength(1);
    expect(x.cases('PG_BALANCE_MISMATCH')).toHaveLength(1);
    // 다른 상점의 같은 달은 따로 한 행이다
    expect(await x.settlements.reconcileTossBalance({ pgStore: 'ESCROW', kind: 'MONTHLY', periodMonth: '2026-11-01' })).toMatchObject({ pgStore: 'ESCROW', diffAmount: -1 });
    expect(x.store.pgBalanceReconciliations).toHaveLength(2);
  });

  test('J-T25 ③ 심각도 경계: 차이 ±10,000원은 CASE, ±10,001원은 SEV3다', async () => {
    for (const [delta, severity] of [
      [-10_000, 'CASE'],
      [-10_001, 'SEV3'],
      [10_000, 'CASE'],
      [10_001, 'SEV3'],
    ] as const) {
      const { x } = await shop({ observed: 16_515_050 + delta });
      const record = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01' });
      expect([delta, record?.diffAmount, record?.severity, x.cases('PG_BALANCE_MISMATCH').length]).toEqual([delta, delta, severity, 1]);
      await h?.close();
      h = undefined;
    }
  });

  test('J-T25 ① 지급대행 이용료 기본값(월 30만 원·무료 1,000건·건당 100원): 1,000건은 30만 원, 1,001건은 30만 100원이다', async () => {
    for (const [count, fee] of [
      [1_000, 300_000],
      [1_001, 300_100],
    ] as const) {
      const { x } = await shop({ observed: 0, terms: null, count });
      const record = await x.settlements.reconcileTossBalance({ pgStore: 'ESCROW', kind: 'MONTHLY', periodMonth: '2026-11-01' });
      expect([count, record?.pgFeeAmount, record?.expectedAmount]).toEqual([count, 1_234_560 + fee, 50_000_000 - 2_000_000 - 1_234_560 - fee - 30_000_000]);
      await h?.close();
      h = undefined;
    }
  });

  test('J-T25 정산 일꾼: 매월 마지막 영업일 22:00 KST 첫 tick에 두 상점 월 대사(21:59:59.999에는 없음), 묶음을 만든 뒤 30분 tick에 그 묶음 대사 한 번', async () => {
    const { x } = await shop({ observed: 16_515_050, now: kst('2026-11-30T10:00:00.000') });
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: { setInterval: () => 0, clearInterval: () => undefined } });
    const promoterId = randomUUID();
    await x.partner(promoterId);
    await x.confirmed({ promoterId, amount: 1_000_000, payoutDate: '2026-12-02', pgStore: 'ESCROW' });
    x.fake.balances.ESCROW = { available: 900_000_000, pending: 0 };
    const batch = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'ESCROW', payoutDate: '2026-12-02', actor: randomUUID() });
    x.fake.balances.ESCROW = { available: 16_000_000, pending: 515_050 };
    x.at(kst('2026-11-30T10:30:00.000'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations.map((r) => [r.kind, r.pgStore, r.batchId])).toEqual([['BATCH', 'ESCROW', batch.batchId]]);
    x.at(kst('2026-11-30T11:00:00.000'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations).toHaveLength(1);
    x.at(kst('2026-11-30T21:59:59.999'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations.filter((r) => r.kind === 'MONTHLY')).toEqual([]);
    x.at(CUTOFF);
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations.filter((r) => r.kind === 'MONTHLY').map((r) => [r.pgStore, r.periodMonth]).sort()).toEqual([
      ['ESCROW', '2026-11-01'],
      ['STANDARD', '2026-11-01'],
    ]);
    x.at(kst('2026-11-30T22:30:00.000'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations.filter((r) => r.kind === 'MONTHLY')).toHaveLength(2);
  });

  test('J-T25 ① 수수료는 지난 대사 뒤 기간만 읽어 앞 누적에 더하고, 이용료는 첫 지급 달부터 달마다 센다(11월 대사 뒤 12월 대사, 시험 리뷰 TR-06)', async () => {
    const { x, ledger } = await shop({ observed: 16_515_050 });
    // 정산 행은 날짜가 있고 대역 서버가 조회 기간으로 거른다
    x.fake.settlementRows.STANDARD = [
      { paymentKey: 'pk-1', amount: 40_000_000, fee: 1_000_000, date: '2026-11-10' },
      { paymentKey: 'pk-2', amount: 10_000_000, fee: 234_560, date: '2026-11-20' },
      { paymentKey: 'pk-3', amount: 20_000_000, fee: 345_670, date: '2026-12-15' },
    ];
    const nov = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01' });
    expect(nov).toMatchObject({ pgFeeAmount: 1_234_560 + 250_390, diffAmount: 0 });
    // 12월: 장부 누적이 늘고 12월 지급 9건(무료 7건 넘는 2건 × 130원) → 12월 이용료 250,260
    ledger.rows.set('STANDARD', { approvedAmount: 80_000_000, refundedAmount: 3_000_000, paidOutAmount: 50_000_000, payoutCountByMonth: { '2026-11': 10, '2026-12': 9 }, firstPaymentAt: new Date(kst('2026-11-03T12:00:00.000')) });
    const fee = 1_234_560 + 345_670 + 250_390 + 250_260;
    const expected = 80_000_000 - 3_000_000 - fee - 50_000_000;
    x.fake.balances.STANDARD = { available: expected, pending: 0 };
    x.at(kst('2026-12-31T22:00:00.000'));
    const dec = await x.settlements.reconcileTossBalance({ pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-12-01' });
    expect(dec).toMatchObject({ periodMonth: '2026-12-01', cutoffAt: new Date(kst('2026-12-31T22:00:00.000')), pgFeeAmount: fee, expectedAmount: expected, observedAmount: expected, diffAmount: 0, severity: 'NONE' });
    const queries = x.fake.calls('GET', /^\/v1\/settlements$/).filter((r) => r.store === 'STANDARD');
    expect(queries.map((r) => [r.query.startDate, r.query.endDate])).toEqual([
      ['2026-11-03', '2026-11-30'],
      ['2026-11-30', '2026-12-31'],
    ]);
    expect(x.cases('PG_BALANCE_MISMATCH')).toEqual([]);
  });

  test('J-T25 정산 일꾼: 말일이 주말인 달은 마지막 영업일(2027-01-29 금) 22:00에 돌고(21:59:59.999에는 없음), 말일(31일 일) 22:00에는 새 행이 없다(시험 리뷰 TR-07)', async () => {
    const { x } = await shop({ observed: 16_515_050, now: kst('2027-01-29T21:59:59.999') });
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: { setInterval: () => 0, clearInterval: () => undefined } });
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations).toEqual([]);
    x.at(kst('2027-01-29T22:00:00.000'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations.map((r) => [r.kind, r.pgStore, r.periodMonth]).sort()).toEqual([
      ['MONTHLY', 'ESCROW', '2027-01-01'],
      ['MONTHLY', 'STANDARD', '2027-01-01'],
    ]);
    x.at(kst('2027-01-31T22:00:00.000'));
    await worker.tick(false);
    expect(x.store.pgBalanceReconciliations).toHaveLength(2);
  });
});
