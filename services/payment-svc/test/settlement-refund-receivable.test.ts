// J-T11 계산 뒤(지급 뒤) 환급의 미수금(F-07-8 계획 I-02, ADR-0197 결정 2 뒤 몫, ADR-0380 결정 5).
// 정본: docs/features/settlement.md §7 '환불 미수금에서 수수료 몫을 뺀다'·'계산 뒤 환급의 미수금 만들기', §13 J-T11, docs/data.md partner_receivable.
// 미수금 = 환불액 − ⌊환불액 × 수수료율 ÷ 10,000⌋ − ⌊수수료 몫 × 10%⌋(원 미만 버림, §4.1 계산과 같은 버림). 예: 10%·50만 원 → 5만·5천·44만 5천 원.
// 미수금은 같은 결제사 정산서에서만 상계되고(§7 회수 순서 1), PEAKET 부담 환급(settlement_burden = PEAKET)은 미수금도 계산 환급도 아니다.
// 다시 계산 대기(PENDING) 회차의 환급은 다시 계산이 넣으므로 미수금이 아니고, 다시 계산에서 빠진 정산서(지급이 나간 것)만 미수금이다(ADR-0380 결정 5).
// 단언 값은 정본 값(50만 원·10% → 44만 5천 원, 2,492만 원 → 2,447만 5천 원)을 적고, 코드 상수와 겹치지 않게 850bp 경우도 둔다.
// 기준 트리: refundReceivableOf·recordRefundsAfterCalculation·openEventRecalculation·commissionRateBp 칸이 없어 실패한다(계획 §7).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemorySettlementStore, SettlementProblem } from '../src/modules/settlement/index.js';
import { refundReceivableOf } from '../src/modules/settlement/domain/settlement.js';
import { approvedTossSeller, DAY, fact, recalcHarness, seedBatch, seedPayout, seedStatement, verifiedKyc, type FactPlus, type RecalcHarness } from './support/recalc-harness.js';

/** 2026-11-23(월) 10:00 KST */
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const CALC_REFUNDED_AT = new Date(NOW - 3 * DAY);

describe('J-T11 환급 미수금 식(refundReceivableOf)', () => {
  test('J-T11 ① 50만 원·10%(1000bp) → 수수료 몫 5만·부가세 5천·미수금 44만 5천 원', () => {
    expect(refundReceivableOf({ refundAmount: 500_000, commissionRateBp: 1000 })).toEqual({ commissionShare: 50_000, commissionVatShare: 5_000, amount: 445_000 });
  });

  test('J-T11 ① 850bp(코드 기본값과 다른 값) 50만 원 → 42,500·4,250·453,250', () => {
    expect(refundReceivableOf({ refundAmount: 500_000, commissionRateBp: 850 })).toEqual({ commissionShare: 42_500, commissionVatShare: 4_250, amount: 453_250 });
  });

  // F-01: 올림·반올림이면 1원 차이가 나는 값
  test('J-T11 ① 끝수는 모두 버림: 333,333원·1000bp → 33,333·3,333·296,667, 9원·1000bp → 0·0·9, 1원 → 0·0·1', () => {
    expect(refundReceivableOf({ refundAmount: 333_333, commissionRateBp: 1000 })).toEqual({ commissionShare: 33_333, commissionVatShare: 3_333, amount: 296_667 });
    expect(refundReceivableOf({ refundAmount: 9, commissionRateBp: 1000 })).toEqual({ commissionShare: 0, commissionVatShare: 0, amount: 9 });
    expect(refundReceivableOf({ refundAmount: 1, commissionRateBp: 1000 })).toEqual({ commissionShare: 0, commissionVatShare: 0, amount: 1 });
    // 부가세의 버림: 수수료 몫 33,339원(333,399원·1000bp)의 10%는 3,333.9 → 3,333
    expect(refundReceivableOf({ refundAmount: 333_399, commissionRateBp: 1000 })).toEqual({ commissionShare: 33_339, commissionVatShare: 3_333, amount: 296_727 });
  });

  test('J-T11 ① 수수료율 경계 0·10000과 환불액 0은 받는다(식 그대로)', () => {
    expect(refundReceivableOf({ refundAmount: 500_000, commissionRateBp: 0 })).toEqual({ commissionShare: 0, commissionVatShare: 0, amount: 500_000 });
    expect(refundReceivableOf({ refundAmount: 500_000, commissionRateBp: 10_000 })).toEqual({ commissionShare: 500_000, commissionVatShare: 50_000, amount: -50_000 });
    expect(refundReceivableOf({ refundAmount: 0, commissionRateBp: 850 })).toEqual({ commissionShare: 0, commissionVatShare: 0, amount: 0 });
  });

  test('J-T11 ① 음수·소수 환불액, 0~10000 밖·소수 수수료율은 400 invalid-body', () => {
    for (const bad of [
      { refundAmount: -1, commissionRateBp: 1000 },
      { refundAmount: 1.5, commissionRateBp: 1000 },
      { refundAmount: Number.NaN, commissionRateBp: 1000 },
      { refundAmount: 500_000, commissionRateBp: -1 },
      { refundAmount: 500_000, commissionRateBp: 10_001 },
      { refundAmount: 500_000, commissionRateBp: 12.5 },
    ]) {
      let thrown: unknown;
      try {
        refundReceivableOf(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(SettlementProblem);
      expect(thrown, JSON.stringify(bad)).toMatchObject({ type: 'invalid-body', status: 400 });
    }
  });
});

/** J-T1 정산서(판매 대금 3,000만·환급 200만·10%, 지급액 2,492만 원)를 계산하고 지급 끝(PAID)으로 둔다 */
async function paidJT1(h: RecalcHarness, o: { promoterId?: string; rateBp?: number } = {}) {
  const promoterId = o.promoterId ?? randomUUID();
  const eventId = randomUUID();
  h.rate.value = o.rateBp ?? 1000;
  const pay = fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED', refundedAt: CALC_REFUNDED_AT });
  h.payments.set(eventId, 'TOSS', [pay]);
  const view = await h.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
  const stored = h.store.statements.get(view.statementId)!;
  h.store.statements.set(view.statementId, { ...stored, status: 'PAID' });
  return { promoterId, eventId, pay, statementId: view.statementId };
}

/** 그 결제의 누적 환급을 바꾼다(결제 취소가 끝난 시각과 함께) */
const refundTo = (h: RecalcHarness, eventId: string, pay: FactPlus, cumulative: number, at: number, extra: Partial<FactPlus> = {}, pg: 'TOSS' | 'PORTONE' = 'TOSS') =>
  h.payments.set(eventId, pg, [{ ...pay, cancelledAmount: cumulative, status: cumulative >= pay.amount ? 'CANCELED' : 'PARTIAL_CANCELED', refundedAt: new Date(at), ...extra }]);

const refundReceivables = (store: MemorySettlementStore) => [...store.receivables.values()].filter((r) => r.cause === 'REFUND_AFTER_PAYOUT');

describe('J-T11 계산 뒤 환급의 미수금 만들기(recordRefundsAfterCalculation)', () => {
  test('J-T11 ② J-T1 정산서를 지급한 뒤 토스 결제분 50만 원 환불 → 미수금 1행(다섯 칸·근거)이고 두 번째 tick은 0행이다', async () => {
    const h = recalcHarness({ now: NOW });
    const { promoterId, eventId, pay, statementId } = await paidJT1(h);
    expect(h.store.statements.get(statementId)).toMatchObject({ payoutAmount: 24_920_000, commissionRateBp: 1000 });
    h.at(NOW + 60_000);
    refundTo(h, eventId, pay, 2_500_000, NOW + 30_000);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 1 });
    const rows = refundReceivables(h.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cause: 'REFUND_AFTER_PAYOUT',
      promoterId,
      pg: 'TOSS',
      eventId,
      statementId,
      commissionRateBp: 1000,
      refundAmount: 500_000,
      commissionShare: 50_000,
      commissionVatShare: 5_000,
      amount: 445_000,
      remaining: 445_000,
      status: 'OPEN',
      sourceRef: `refund:${statementId}:${pay.paymentId}:2500000`,
    });
    // 두 번째 tick: 새 환급이 없으면 0행(같은 근거 부분 유일과 '이미 만든 환급 미수금 합' 두 가드가 겹쳐 지킨다)
    h.at(NOW + 31 * 60_000);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 0 });
    expect(refundReceivables(h.store)).toHaveLength(1);
  });

  test('J-T11 ② 같은 50만 원을 계산 전에 환불하면 지급액 2,447만 5천 원이고, 차이 44만 5천 원이 계산 뒤 미수금과 같다', async () => {
    const h = recalcHarness({ now: NOW, rateBp: 1000 });
    const eventId = randomUUID();
    h.payments.set(eventId, 'TOSS', [fact({ amount: 30_000_000, cancelledAmount: 2_500_000, status: 'PARTIAL_CANCELED', refundedAt: CALC_REFUNDED_AT })]);
    const before = await h.settlements.calculateEvent({ promoterId: randomUUID(), eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(before).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_500_000, commissionAmount: 2_750_000, commissionVat: 275_000, payoutAmount: 24_475_000 });
    expect(24_920_000 - before.payoutAmount).toBe(445_000);
    expect(refundReceivableOf({ refundAmount: 500_000, commissionRateBp: 1000 }).amount).toBe(24_920_000 - before.payoutAmount);
  });

  // 겹친 가드 하나씩 빼 보기(지시서 '자주 놓친 결함'): '이미 만든 환급 미수금 합'을 빼면 두 번째 환불 때 누적 80만 원으로 한 행이 더 생긴다
  test('J-T11 ② 두 번 나눠 환불(50만 → 누적 80만)하면 두 번째 미수금은 30만 원 몫만이고(합 가드), 근거는 누적 환급액마다 다르다', async () => {
    const h = recalcHarness({ now: NOW });
    const { eventId, pay, statementId } = await paidJT1(h, { rateBp: 850 });
    h.at(NOW + 60_000);
    refundTo(h, eventId, pay, 2_500_000, NOW + 30_000);
    await h.settlements.recordRefundsAfterCalculation();
    h.at(NOW + 31 * 60_000);
    refundTo(h, eventId, pay, 2_800_000, NOW + 30 * 60_000);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 1 });
    const rows = refundReceivables(h.store).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.map((r) => [r.sourceRef, r.refundAmount, r.commissionShare, r.commissionVatShare, r.amount, r.commissionRateBp])).toEqual([
      [`refund:${statementId}:${pay.paymentId}:2500000`, 500_000, 42_500, 4_250, 453_250, 850],
      [`refund:${statementId}:${pay.paymentId}:2800000`, 300_000, 25_500, 2_550, 271_950, 850],
    ]);
  });

  // F-09: 누적 환급이 계산 원본의 REFUND 줄과 같으면 0행, 1원 많으면 1행
  test('J-T11 ② 누적 환급이 그 판 계산 원본의 환급 줄과 같으면 0행, 1원 많으면 1원 미수금 1행이다', async () => {
    const h = recalcHarness({ now: NOW });
    const { eventId, pay, statementId } = await paidJT1(h);
    h.at(NOW + 60_000);
    refundTo(h, eventId, pay, 2_000_000, NOW + 30_000);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 0 });
    expect(refundReceivables(h.store)).toEqual([]);
    h.at(NOW + 31 * 60_000);
    refundTo(h, eventId, pay, 2_000_001, NOW + 30 * 60_000);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 1 });
    expect(refundReceivables(h.store)).toEqual([expect.objectContaining({ statementId, refundAmount: 1, commissionShare: 0, commissionVatShare: 0, amount: 1, remaining: 1 })]);
  });

  test('J-T11 ② 정산서가 아직 없으면(계산 전 환급) 미수금을 만들지 않고, 그 환급은 06시 계산의 환급에 든다', async () => {
    const h = recalcHarness({ now: NOW, rateBp: 1000 });
    const eventId = randomUUID();
    h.payments.set(eventId, 'TOSS', [fact({ amount: 30_000_000, cancelledAmount: 500_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(NOW - 60_000) })]);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 0 });
    expect(refundReceivables(h.store)).toEqual([]);
    const s = await h.settlements.calculateEvent({ promoterId: randomUUID(), eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s.refundAmount).toBe(500_000);
  });

  test('J-T11 ② PEAKET 부담 환급(시스템 잘못 확인, POL-038 ①) 50만 원은 미수금 0이고, 계산 환급에도 넣지 않는다', async () => {
    const h = recalcHarness({ now: NOW });
    const { eventId, pay } = await paidJT1(h);
    h.at(NOW + 60_000);
    refundTo(h, eventId, pay, 2_500_000, NOW + 30_000, { peaketBorneRefund: 500_000 });
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 0 });
    expect(refundReceivables(h.store)).toEqual([]);

    // 계산 전이면: 누적 취소 250만 원 중 PEAKET 부담 50만 원은 환급에서 빠져 J-T1과 같은 2,492만 원이다
    const h2 = recalcHarness({ now: NOW, rateBp: 1000 });
    const e2 = randomUUID();
    h2.payments.set(e2, 'TOSS', [fact({ amount: 30_000_000, cancelledAmount: 2_500_000, status: 'PARTIAL_CANCELED', peaketBorneRefund: 500_000, refundedAt: CALC_REFUNDED_AT })]);
    const s2 = await h2.settlements.calculateEvent({ promoterId: randomUUID(), eventId: e2, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s2).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000, payoutAmount: 24_920_000 });
  });

  test('J-T11 ② 대사 불일치로 계산에서 뺀 결제(excludedPayments)의 뒤 환급은 미수금이 아니다(§4.1 대사 미완 결제 길로 간다)', async () => {
    const h = recalcHarness({ now: NOW, rateBp: 1000 });
    const eventId = randomUUID();
    const kept = fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED', refundedAt: CALC_REFUNDED_AT });
    const open = fact({ amount: 1_000_000, cancelledAmount: 0, excludedReason: 'RECONCILIATION_OPEN' });
    h.payments.set(eventId, 'TOSS', [kept, open]);
    const s = await h.settlements.calculateEvent({ promoterId: randomUUID(), eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s.excludedPayments).toEqual([`${open.paymentId}:RECONCILIATION_OPEN`]);
    h.at(NOW + 60_000);
    h.payments.set(eventId, 'TOSS', [kept, { ...open, cancelledAmount: 400_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(NOW + 30_000) }]);
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 0 });
    expect(refundReceivables(h.store)).toEqual([]);
  });

  test('J-T11 ② 다시 계산 대기(PENDING) 회차는 미수금 0이고, 다시 계산에서 빠진(지급이 나간) 정산서만 미수금 1행이다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = recalcHarness({ now: NOW, toss: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const at = new Date(NOW - 5 * DAY);
    // 토스 정산서: 지급 건 하나가 IN_PROGRESS → 다시 계산 밖(SKIP)
    const tossPay = fact({ amount: 10_000_000, refundedAt: null });
    h.payments.set(eventId, 'TOSS', [tossPay]);
    const b = seedBatch(h.store, { pg: 'TOSS', payoutDate: '2026-11-24', totalAmount: 9_065_000, statementCount: 1, at });
    const skipped = seedStatement(h.store, { promoterId, eventId, pg: 'TOSS', status: 'SCHEDULED', payoutBatchId: b.batchId, payoutDate: '2026-11-24', at });
    h.store.sources.set(skipped.statementId, [{ statementId: skipped.statementId, sourceId: tossPay.paymentId, kind: 'GROSS', paymentId: tossPay.paymentId, amount: 10_000_000 }]);
    seedPayout(h.store, { batchId: b.batchId, statementId: skipped.statementId, amount: 9_065_000, payoutDate: '2026-11-24', status: 'IN_PROGRESS', at });
    // 포트원 정산서: NOTIFIED → 다시 계산 대상(KEEP)
    const portonePay = fact({ amount: 10_000_000, refundedAt: null });
    h.payments.set(eventId, 'PORTONE', [portonePay]);
    const kept = seedStatement(h.store, { promoterId, eventId, pg: 'PORTONE', status: 'NOTIFIED', disputeDueAt: new Date(NOW + 2 * DAY), at });
    h.store.sources.set(kept.statementId, [{ statementId: kept.statementId, sourceId: portonePay.paymentId, kind: 'GROSS', paymentId: portonePay.paymentId, amount: 10_000_000 }]);

    const opened = await h.settlements.openEventRecalculation({ requestId: randomUUID(), eventId, kind: 'CANCEL', confirmedAt: new Date(NOW) });
    expect(opened.skipped).toEqual([skipped.statementId]);
    h.at(NOW + 60_000);
    refundTo(h, eventId, tossPay, 10_000_000, NOW + 30_000);
    refundTo(h, eventId, portonePay, 10_000_000, NOW + 30_000, {}, 'PORTONE');
    await expect(h.settlements.recordRefundsAfterCalculation()).resolves.toMatchObject({ created: 1 });
    expect(refundReceivables(h.store)).toEqual([
      expect.objectContaining({ statementId: skipped.statementId, pg: 'TOSS', refundAmount: 10_000_000, commissionShare: 850_000, commissionVatShare: 85_000, amount: 9_065_000, sourceRef: `refund:${skipped.statementId}:${tossPay.paymentId}:10000000` }),
    ]);
  });

  // F-17: tick 중간 실패 → 읽은 자리(read_through)를 옮기지 않고, 다음 tick이 같은 결과를 중복 없이 만든다
  test('J-T11 ② tick 중간에 미수금 쓰기가 실패하면 읽은 자리를 옮기지 않고 다음 tick이 빠진 것만 만든다(부분 유일로 중복 0)', async () => {
    class FailSecondInsert extends MemorySettlementStore {
      calls = 0;
      failAt = 2;
      override async insertReceivableIfAbsent(record: Parameters<MemorySettlementStore['insertReceivableIfAbsent']>[0]): Promise<boolean> {
        this.calls += 1;
        if (this.calls === this.failAt) throw new Error('미수금 쓰기 실패(시험 주입)');
        return super.insertReceivableIfAbsent(record);
      }
    }
    const store = new FailSecondInsert();
    const h = recalcHarness({ now: NOW, store });
    const a = await paidJT1(h);
    const b = await paidJT1(h, { promoterId: a.promoterId });
    const scanBefore = h.store.refundScans.get('EVENT_REFUND');
    h.at(NOW + 60_000);
    refundTo(h, a.eventId, a.pay, 2_500_000, NOW + 20_000);
    refundTo(h, b.eventId, b.pay, 2_700_000, NOW + 30_000);
    // 실패를 던지든 건마다 삼키든(정본이 정하지 않음) 읽은 자리는 그대로여야 한다
    await h.settlements.recordRefundsAfterCalculation().catch(() => undefined);
    expect(store.calls).toBeGreaterThanOrEqual(2);
    expect(h.store.refundScans.get('EVENT_REFUND')).toEqual(scanBefore);
    const afterFailure = refundReceivables(h.store).length;
    expect(afterFailure).toBeLessThanOrEqual(1);
    store.failAt = 0;
    h.at(NOW + 31 * 60_000);
    await h.settlements.recordRefundsAfterCalculation();
    expect(refundReceivables(h.store).map((r) => r.sourceRef).sort()).toEqual([`refund:${a.statementId}:${a.pay.paymentId}:2500000`, `refund:${b.statementId}:${b.pay.paymentId}:2700000`].sort());
    expect(h.store.refundScans.get('EVENT_REFUND')).toMatchObject({ name: 'EVENT_REFUND' });
    expect(h.store.refundScans.get('EVENT_REFUND')!.readThrough).toBeInstanceOf(Date);
  });
});

describe('J-T11 미수금 상계는 같은 결제사 정산서에서만', () => {
  test('J-T11 ③ 토스 환불 미수금 44만 5천 원은 다음 포트원 정산서 묶음에서 상계 0이고, 다음 토스 정산서 묶음에서 OFFSET 1줄·남은 0·CLOSED다', async () => {
    const h = recalcHarness({ now: NOW });
    const { promoterId, eventId, pay } = await paidJT1(h);
    h.store.kycs.set(promoterId, verifiedKyc(promoterId, new Date(NOW - 30 * DAY)));
    approvedTossSeller(h.store, promoterId, 'STANDARD', new Date(NOW - 30 * DAY));
    h.at(NOW + 60_000);
    refundTo(h, eventId, pay, 2_500_000, NOW + 30_000);
    await h.settlements.recordRefundsAfterCalculation();
    const [r] = refundReceivables(h.store);
    expect(r).toMatchObject({ amount: 445_000, remaining: 445_000 });

    const at = new Date(NOW + 60_000);
    const portoneNext = seedStatement(h.store, { promoterId, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-27', at });
    await h.settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-11-27', portoneBalance: { amount: 100_000_000_000, observedAt: at.toISOString() }, actor: randomUUID() });
    expect(h.store.receivableMoves.filter((m) => m.receivableId === r!.receivableId)).toEqual([]);
    expect(h.store.statements.get(portoneNext.statementId)).toMatchObject({ offsetAmount: 0, payoutAmount: 9_065_000 });
    expect(h.store.receivables.get(r!.receivableId)).toMatchObject({ remaining: 445_000, status: 'OPEN' });

    const tossNext = seedStatement(h.store, { promoterId, eventId: randomUUID(), pg: 'TOSS', payoutDate: '2026-11-30', at });
    await h.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-30', actor: randomUUID() });
    expect(h.store.receivableMoves.filter((m) => m.receivableId === r!.receivableId)).toEqual([expect.objectContaining({ receivableId: r!.receivableId, statementId: tossNext.statementId, amount: 445_000 })]);
    expect(h.store.receivables.get(r!.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });
    expect(h.store.statements.get(tossNext.statementId)).toMatchObject({ offsetAmount: 445_000, payoutAmount: 9_065_000 - 445_000 });
  });
});
