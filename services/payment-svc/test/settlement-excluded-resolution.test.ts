// J-T23 ③ 대사 불일치로 계산에서 뺀 결제가 풀린 뒤의 처리(F-07-8 계획 I-05, ADR-0380 결정 7. 줄일 때 맨 먼저 빼는 몫).
// 정본: docs/features/settlement.md §4.1 '대사가 끝나지 않은 결제', §12 셋째 줄, §13 J-T23 ③.
// 풀린 결제의 순액(판매 대금 − 환급 − 수수료 몫 − 부가세, J-T11 식과 같은 버림)을 조정 제안 CS 건(SETTLEMENT_ADJUSTMENT_SUGGESTED)으로 연다.
// 조정 행을 바로 적용하지 않는다(§4.3 2인 승인을 그대로 거친다). 지급 전이면 그 정산서, 지급 뒤면 같은 파트너·결제사의 다음 지급 전 정산서에 제안한다.
// CS 건 요청은 F-07-6 `settlement_case_request`(메모리 저장소 `caseRequests`, 키 사건 키)에 남는다. 사건 키 `reconciliation-resolved:{정산서 ID}:{결제 ID}`.
// 기준 트리: resolveExcludedPayments·caseRequests가 없어 실패한다(계획 §7).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DAY, fact, recalcHarness, seedStatement, type RecalcHarness } from './support/recalc-harness.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');

/** 한 회차 토스 결제 둘: 하나는 대사 완료, 하나(100만 원)는 대사 불일치가 남았다. 수수료율 850bp */
async function excluded(h: RecalcHarness) {
  const promoterId = randomUUID();
  const eventId = randomUUID();
  const kept = fact({ amount: 10_000_000 });
  const open = fact({ amount: 1_000_000, cancelledAmount: 0, excludedReason: 'RECONCILIATION_OPEN' });
  h.payments.set(eventId, 'TOSS', [kept, open]);
  const s = await h.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
  return { promoterId, eventId, kept, open, s };
}

const resolve = (h: RecalcHarness, w: Awaited<ReturnType<typeof excluded>>) => h.payments.set(w.eventId, 'TOSS', [w.kept, { ...w.open, excludedReason: null }]);
const suggestions = (h: RecalcHarness) => [...h.store.caseRequests.values()].filter((c) => c.kind === 'SETTLEMENT_ADJUSTMENT_SUGGESTED');

describe('J-T23 ③ 대사 미완 결제', () => {
  test('J-T23 ③ 대사 불일치 결제 1건이 남은 회차는 그 결제만 빠진 정산서와 뺀 목록이 나온다', async () => {
    const h = recalcHarness({ now: NOW });
    const w = await excluded(h);
    expect(w.s).toMatchObject({ grossAmount: 10_000_000, refundAmount: 0, commissionAmount: 850_000, commissionVat: 85_000, payoutAmount: 9_065_000, excludedPayments: [`${w.open.paymentId}:RECONCILIATION_OPEN`] });
    expect((h.store.sources.get(w.s.statementId) ?? []).map((x) => x.paymentId)).toEqual([w.kept.paymentId]);
  });

  test('J-T23 ③ 지급 전에 풀리면 그 정산서에 조정 제안 CS 건 하나(순액 906,500원)를 열고 다시 tick해도 0이며, 조정 행을 바로 적용하지 않는다', async () => {
    const h = recalcHarness({ now: NOW });
    const w = await excluded(h);
    expect(await h.settlements.resolveExcludedPayments()).toMatchObject({ suggested: 0 });
    h.at(NOW + 30 * 60_000);
    resolve(h, w);
    await expect(h.settlements.resolveExcludedPayments()).resolves.toMatchObject({ suggested: 1, waiting: 0 });
    const key = `reconciliation-resolved:${w.s.statementId}:${w.open.paymentId}`;
    expect(suggestions(h)).toEqual([expect.objectContaining({ eventKey: key, kind: 'SETTLEMENT_ADJUSTMENT_SUGGESTED', sourceId: w.s.statementId })]);
    // 순액 = 100만 − ⌊100만 × 850 ÷ 10,000⌋(85,000) − 8,500 = 906,500원. 본문 칸 이름은 정본에 없어(계획 §7 '인터페이스 빈칸') 기록 어딘가에 값이 있는지 본다
    expect(JSON.stringify(h.store.caseRequests.get(key))).toContain(w.open.paymentId);
    expect(JSON.stringify(h.store.caseRequests.get(key))).toContain('906500');
    // 처리한 결제에 표시를 더해 다시 열지 않는다
    expect(h.store.statements.get(w.s.statementId)!.excludedPayments).toEqual([`${w.open.paymentId}:RECONCILIATION_OPEN:RESOLVED`]);
    // 정산서 금액·조정은 그대로(2인 승인 전)
    expect(h.store.statements.get(w.s.statementId)).toMatchObject({ payoutAmount: 9_065_000, adjustmentAmount: 0 });
    expect([...h.store.adjustments.values()]).toEqual([]);
    h.at(NOW + 60 * 60_000);
    await expect(h.settlements.resolveExcludedPayments()).resolves.toMatchObject({ suggested: 0 });
    expect(suggestions(h)).toHaveLength(1);
  });

  test('J-T23 ③ 아직 풀리지 않은 결제는 제안하지 않는다', async () => {
    const h = recalcHarness({ now: NOW });
    const w = await excluded(h);
    h.at(NOW + 30 * 60_000);
    await expect(h.settlements.resolveExcludedPayments()).resolves.toMatchObject({ suggested: 0 });
    expect(suggestions(h)).toEqual([]);
    expect(h.store.statements.get(w.s.statementId)!.excludedPayments).toEqual([`${w.open.paymentId}:RECONCILIATION_OPEN`]);
  });

  test('J-T23 ③ 지급 뒤에 풀리면 같은 파트너·같은 결제사의 다음 지급 전 정산서에 제안하고, 그런 정산서가 없으면 기다렸다가 생긴 뒤 연다', async () => {
    const h = recalcHarness({ now: NOW });
    const w = await excluded(h);
    h.store.statements.set(w.s.statementId, { ...h.store.statements.get(w.s.statementId)!, status: 'PAID' });
    h.at(NOW + 30 * 60_000);
    resolve(h, w);
    // 다른 결제사(포트원) 정산서는 대상이 아니다
    seedStatement(h.store, { promoterId: w.promoterId, eventId: randomUUID(), pg: 'PORTONE', status: 'NOTIFIED', at: new Date(NOW) });
    await expect(h.settlements.resolveExcludedPayments()).resolves.toMatchObject({ suggested: 0, waiting: 1 });
    expect(suggestions(h)).toEqual([]);
    const next = seedStatement(h.store, { promoterId: w.promoterId, eventId: randomUUID(), pg: 'TOSS', status: 'CONFIRMED', at: new Date(NOW + DAY) });
    h.at(NOW + DAY + 30 * 60_000);
    await expect(h.settlements.resolveExcludedPayments()).resolves.toMatchObject({ suggested: 1, waiting: 0 });
    expect(suggestions(h)).toEqual([expect.objectContaining({ eventKey: `reconciliation-resolved:${next.statementId}:${w.open.paymentId}`, sourceId: next.statementId })]);
  });
});
