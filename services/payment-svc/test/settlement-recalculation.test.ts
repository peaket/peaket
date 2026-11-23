// J-T23 ①② 회차 취소·연기 환급의 정산 보류와 다시 계산(F-07-8 계획 I-03, ADR-0380 결정 1~8).
// 정본: docs/features/settlement.md §4.1 '다시 계산'·'다시 계산의 시점과 부르는 길', §4.4 상태표, §7 '다시 계산과 음수 미수금'·'미수금 이동 기록', §12 첫 두 줄, §13 J-T23,
// docs/planning/03-policies-glossary.md §2.12 T10·T14~T17·T19.
// - 보류 열기(확정 직후): NOTIFIED·DISPUTED는 그대로, CONFIRMED는 HELD(RECALCULATION), 묶음에 묶인 접수 전은 묶음에서 빼고 상계 되돌림, 토스 REQUESTED는 예약 취소,
//   포트원은 수기 정산건 취소(T10), 지급 건이 진행 중·끝난 정산서는 다시 계산하지 않는다(skipped).
// - 완료(일괄 환불 끝): 대상마다 판 +1 새 판(새 원본 목록, 옛 판 수수료율·적용된 조정 합 이어받음, 바로 NOTIFIED·2영업일), 옛 판은 금액 그대로 SUPERSEDED,
//   열린 이의는 결과 SUPERSEDED, 적용 전 조정은 무효. CARRIED_OVER 옛 판의 NEGATIVE_STATEMENT 미수금은 남은 금액만큼 SUPERSEDED 이동으로 닫고, 돌려받은 금액은 새 판 조정 합에 더한다(결정 8).
// 외부 결제사는 부르지 않는다: 토스 전송·포트원 플랫폼은 F-07-6·F-07-7 포트의 짝 대역이다(test/support/recalc-*-double.ts).
// 단언 값은 정본 값(판 2, 2영업일, 금요일 완료 → 화요일)을 적고 수수료율은 코드 기본값과 다른 850bp를 쓴다.
// 기준 트리: openEventRecalculation·completeEventRecalculation·recalculationActionOf와 F-07-6·F-07-7의 의존(toss·portone)이 없어 실패한다(계획 §7).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  MemorySettlementStore,
  SettlementDueWorker,
  SettlementModule,
  SettlementProblem,
  UnavailableTossPayoutGateway,
} from '../src/modules/settlement/index.js';
import { recalculationActionOf } from '../src/modules/settlement/domain/recalculation.js';
import type { PayoutStatus, StatementStatus } from '../src/modules/settlement/domain/settlement.js';
import { quiet } from './settlement-flow-support.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';
import {
  approvedTossSeller,
  auditsOf,
  DAY,
  eventsOf,
  fact,
  liveStatementsOf,
  recalcHarness,
  remainingByMoves,
  seedBatch,
  seedOffset,
  seedPayout,
  seedReceivable,
  seedStatement,
  verifiedKyc,
  type RecalcHarness,
} from './support/recalc-harness.js';

/** 2026-11-23(월) 10:00 KST: 회차 취소 확정 */
const CONFIRMED_AT = Date.parse('2026-11-23T01:00:00.000Z');
/** 2026-11-27(금) 10:00 KST: 일괄 환불 끝. + 2영업일 = 2026-12-01(화) 10:00 KST */
const FRIDAY = Date.parse('2026-11-27T01:00:00.000Z');
const TUESDAY = Date.parse('2026-12-01T01:00:00.000Z');

const statusOf = (h: RecalcHarness, id: string) => h.store.statements.get(id)!.status;
const open = (h: RecalcHarness, o: { requestId: string; eventId: string; kind?: 'CANCEL' | 'POSTPONE' }) =>
  h.settlements.openEventRecalculation({ requestId: o.requestId, eventId: o.eventId, kind: o.kind ?? 'CANCEL', confirmedAt: new Date(CONFIRMED_AT) });

describe('J-T23 ② 정산서 상태별 처리 판정(recalculationActionOf)', () => {
  const s = (status: StatementStatus, o: { batch?: string | null; pg?: 'TOSS' | 'PORTONE'; pieces?: PayoutStatus[] } = {}) => ({
    status,
    payoutBatchId: o.batch ?? null,
    pg: o.pg ?? ('TOSS' as const),
    payouts: (o.pieces ?? []).map((p) => ({ status: p })),
  });

  // F-08: 정산서 상태 열과 조각 상태마다(허용 목록 밖 값마다 본다)
  test('J-T23 ② NOTIFIED·DISPUTED·HELD·CARRIED_OVER는 KEEP, 묶이지 않은 CONFIRMED는 HOLD, 묶인 CONFIRMED는 UNBATCH_HOLD', () => {
    expect(recalculationActionOf(s('NOTIFIED'))).toBe('KEEP');
    expect(recalculationActionOf(s('DISPUTED'))).toBe('KEEP');
    expect(recalculationActionOf(s('HELD'))).toBe('KEEP');
    expect(recalculationActionOf(s('CARRIED_OVER'))).toBe('KEEP');
    expect(recalculationActionOf(s('CONFIRMED'))).toBe('HOLD');
    expect(recalculationActionOf(s('CONFIRMED', { batch: randomUUID() }))).toBe('UNBATCH_HOLD');
    expect(recalculationActionOf(s('CONFIRMED', { batch: randomUUID(), pg: 'PORTONE' }))).toBe('UNBATCH_HOLD');
  });

  test('J-T23 ② SCHEDULED 토스는 조각이 모두 REQUESTED일 때만 CANCEL_TOSS이고, 하나라도 IN_PROGRESS·COMPLETED면 SKIP이다', () => {
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['REQUESTED'] }))).toBe('CANCEL_TOSS');
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['REQUESTED', 'REQUESTED'] }))).toBe('CANCEL_TOSS');
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['REQUESTED', 'IN_PROGRESS'] }))).toBe('SKIP');
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['COMPLETED', 'REQUESTED'] }))).toBe('SKIP');
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['IN_PROGRESS'] }))).toBe('SKIP');
    expect(recalculationActionOf(s('SCHEDULED', { pieces: ['COMPLETED'] }))).toBe('SKIP');
  });

  test('J-T23 ② SCHEDULED 포트원은 조각 없음·모두 REQUESTED면 CANCEL_PORTONE, IN_PROGRESS·COMPLETED가 있으면 SKIP', () => {
    expect(recalculationActionOf(s('SCHEDULED', { pg: 'PORTONE' }))).toBe('CANCEL_PORTONE');
    expect(recalculationActionOf(s('SCHEDULED', { pg: 'PORTONE', pieces: ['REQUESTED'] }))).toBe('CANCEL_PORTONE');
    expect(recalculationActionOf(s('SCHEDULED', { pg: 'PORTONE', pieces: ['IN_PROGRESS'] }))).toBe('SKIP');
    expect(recalculationActionOf(s('SCHEDULED', { pg: 'PORTONE', pieces: ['COMPLETED'] }))).toBe('SKIP');
  });

  test('J-T23 ② 지급이 끝났거나 실패한 PAID·FAILED는 SKIP이고, SUPERSEDED는 대상이 아니라 던진다', () => {
    expect(recalculationActionOf(s('PAID', { pieces: ['COMPLETED'] }))).toBe('SKIP');
    expect(recalculationActionOf(s('FAILED', { pieces: ['FAILED'] }))).toBe('SKIP');
    expect(() => recalculationActionOf(s('SUPERSEDED'))).toThrow();
  });
});

/** 같은 파트너·같은 회차의 결제사·상점 셋(토스 일반·토스 에스크로·포트원)과 결제 원장 */
function threeStores(h: RecalcHarness) {
  const promoterId = randomUUID();
  const eventId = randomUUID();
  const payT = fact({ amount: 10_000_000, refundedAt: null });
  const payE = fact({ amount: 10_000_000, refundedAt: null });
  const payP = fact({ amount: 10_000_000, refundedAt: null });
  h.payments.set(eventId, 'TOSS', [payT], 'STANDARD');
  h.payments.set(eventId, 'TOSS', [payE], 'ESCROW');
  h.payments.set(eventId, 'PORTONE', [payP], 'STANDARD');
  return { promoterId, eventId, payT, payE, payP };
}

describe('J-T23 ① NOTIFIED·DISPUTED·CONFIRMED 정산서의 보류와 다시 계산', () => {
  test('J-T23 ① 세 정산서(결제사·상점 셋)에서 보류 열기 → 환급 → 완료: 판 2 새 판 NOTIFIED(2영업일, 금 → 화), 옛 판은 금액 그대로 SUPERSEDED [ASVS v5.0.0-2.3.3]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT - 2 * DAY });
    const w = threeStores(h);
    const sN = await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    const sD = await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'TOSS', pgStore: 'ESCROW' });
    const sC = await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'PORTONE', pgStore: 'STANDARD' });
    for (const s of [sN, sD, sC]) expect(s).toMatchObject({ status: 'NOTIFIED', grossAmount: 10_000_000, refundAmount: 0, commissionAmount: 850_000, commissionVat: 85_000, payoutAmount: 9_065_000, revision: 1 });
    // DISPUTED: 파트너 이의
    await h.settlements.dispute(w.promoterId, randomUUID(), sD.statementId, { reasonCode: 'GROSS_AMOUNT' });
    // CONFIRMED: 적용된 수기 조정 +30,000원(옮겨 갈 조정 합)
    const c = h.store.statements.get(sC.statementId)!;
    h.store.statements.set(sC.statementId, { ...c, status: 'CONFIRMED', adjustmentAmount: 30_000, payoutAmount: 9_095_000 });
    // NOTIFIED 정산서의 적용 전 조정(승인 대기) → 다시 계산 때 무효
    const pendingApproval = randomUUID();
    h.store.adjustments.set(pendingApproval, { adjustmentId: randomUUID(), statementId: sN.statementId, approvalId: pendingApproval, reasonCode: 'LEDGER_ERROR', disputeId: null, amount: 5_000, evidenceNote: '원장 오류', status: 'PENDING', requestedBy: randomUUID(), requestedAt: new Date(CONFIRMED_AT - DAY), appliedAt: null });
    const oldSources = new Map([sN, sD, sC].map((s) => [s.statementId, structuredClone(h.store.sources.get(s.statementId))]));
    const oldRecords = new Map([sN, sD, sC].map((s) => [s.statementId, { ...h.store.statements.get(s.statementId)! }]));

    h.at(CONFIRMED_AT);
    const requestId = randomUUID();
    const opened = await open(h, { requestId, eventId: w.eventId });
    expect(opened).toMatchObject({ requestId, eventId: w.eventId, kind: 'CANCEL', state: 'PENDING', held: [sC.statementId], skipped: [], retrying: [], recalculated: [] });
    expect(statusOf(h, sN.statementId)).toBe('NOTIFIED');
    expect(statusOf(h, sD.statementId)).toBe('DISPUTED');
    expect(h.store.statements.get(sC.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION', payoutBatchId: null });
    expect(eventsOf(h.store, sC.statementId, 'PAYOUT_HELD').map((e) => e.value.amount)).toEqual([9_095_000]);
    expect(auditsOf(h.store, sC.statementId).at(-1)).toMatchObject({ fromStatus: 'CONFIRMED', toStatus: 'HELD', reason: `event-recalculation:${requestId}` });

    // 일괄 환불: 결제마다 400만 원 환급. 그사이 회차 수수료율 원천이 바뀌어도 새 판은 옛 판의 고정 수수료율(850bp)을 쓴다
    h.rate.value = 1200;
    h.at(FRIDAY - 60_000);
    h.payments.set(w.eventId, 'TOSS', [fact({ ...w.payT, cancelledAmount: 4_000_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(FRIDAY - 120_000) })], 'STANDARD');
    h.payments.set(w.eventId, 'TOSS', [fact({ ...w.payE, cancelledAmount: 4_000_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(FRIDAY - 120_000) })], 'ESCROW');
    h.payments.set(w.eventId, 'PORTONE', [fact({ ...w.payP, cancelledAmount: 4_000_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(FRIDAY - 120_000) })], 'STANDARD');

    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.state).toBe('DONE');
    expect(done.recalculated.map((r) => r.oldStatementId).sort()).toEqual([sN.statementId, sD.statementId, sC.statementId].sort());
    for (const r of done.recalculated) expect(r).toMatchObject({ revision: 2, negativeClosed: null });

    const live = liveStatementsOf(h.store, w.eventId);
    expect(live).toHaveLength(3);
    for (const r of done.recalculated) {
      const old = oldRecords.get(r.oldStatementId)!;
      const fresh = h.store.statements.get(r.newStatementId)!;
      const adjustment = r.oldStatementId === sC.statementId ? 30_000 : 0;
      expect(fresh).toMatchObject({
        promoterId: w.promoterId,
        eventId: w.eventId,
        pg: old.pg,
        pgStore: old.pgStore,
        revision: 2,
        supersedesId: r.oldStatementId,
        status: 'NOTIFIED',
        holdReason: null,
        grossAmount: 10_000_000,
        refundAmount: 4_000_000,
        commissionAmount: 510_000,
        commissionVat: 51_000,
        offsetAmount: 0,
        adjustmentAmount: adjustment,
        payoutAmount: 5_439_000 + adjustment,
        commissionRateBp: 850,
      });
      expect(fresh.disputeDueAt?.toISOString()).toBe(new Date(TUESDAY).toISOString());
      // 새 판의 원본 목록(새로), 옛 판의 목록은 그대로
      expect((h.store.sources.get(r.newStatementId) ?? []).map((x) => [x.kind, x.amount]).sort()).toEqual([
        ['GROSS', 10_000_000],
        ['REFUND', 4_000_000],
      ]);
      expect(h.store.sources.get(r.oldStatementId)).toEqual(oldSources.get(r.oldStatementId));
      // 옛 판: 금액 칸 그대로 SUPERSEDED
      expect(h.store.statements.get(r.oldStatementId)).toMatchObject({
        status: 'SUPERSEDED',
        grossAmount: old.grossAmount,
        refundAmount: old.refundAmount,
        commissionAmount: old.commissionAmount,
        commissionVat: old.commissionVat,
        offsetAmount: old.offsetAmount,
        payoutAmount: old.payoutAmount,
        revision: 1,
      });
      // 사건: 새 판 STATEMENT_NOTIFIED 한 건(판·옛 판 실음)
      expect(eventsOf(h.store, r.newStatementId, 'STATEMENT_NOTIFIED').map((e) => e.value)).toEqual([
        expect.objectContaining({ revision: 2, supersedesId: r.oldStatementId, salesAmount: 10_000_000, refundAmount: 4_000_000, feeAmount: 510_000 }),
      ]);
    }
    // 감사: 옛 판은 출발 상태(T14 NOTIFIED·T15 DISPUTED·T17 HELD)에서 SUPERSEDED로, 사유 recalculated:{요청 ID}
    const supersededFrom = (id: string) => auditsOf(h.store, id).filter((a) => a.toStatus === 'SUPERSEDED');
    expect(supersededFrom(sN.statementId)).toEqual([expect.objectContaining({ fromStatus: 'NOTIFIED', reason: `recalculated:${requestId}` })]);
    expect(supersededFrom(sD.statementId)).toEqual([expect.objectContaining({ fromStatus: 'DISPUTED', reason: `recalculated:${requestId}` })]);
    expect(supersededFrom(sC.statementId)).toEqual([expect.objectContaining({ fromStatus: 'HELD', reason: `recalculated:${requestId}` })]);
    // 옛 판의 열린 이의는 결과 SUPERSEDED로 닫힌다(새 판에 다시 낼 수 있다)
    expect([...h.store.disputes.values()].filter((d) => d.statementId === sD.statementId)).toEqual([expect.objectContaining({ result: 'SUPERSEDED' })]);
    // 적용 전 조정은 무효
    expect(h.store.adjustments.get(pendingApproval)).toMatchObject({ status: 'VOID' });

    // 같은 완료를 다시 부르면 처음 결과 그대로이고 새 판이 늘지 않는다
    const again = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY + 60_000) });
    expect(again).toEqual(done);
    expect(liveStatementsOf(h.store, w.eventId)).toHaveLength(3);
    expect(h.store.statements.size).toBe(6);
  });

  // F-02: 이의 기한 2영업일의 경계(− 1ms 자동 확정 없음)
  test('J-T23 ① 새 판의 이의 기한(금요일 완료 → 화요일 같은 시각) − 1ms에는 자동 확정되지 않고 기한에 확정된다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const w = threeStores(h);
    const s = await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    const requestId = randomUUID();
    await open(h, { requestId, eventId: w.eventId });
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    const newId = done.recalculated.find((r) => r.oldStatementId === s.statementId)!.newStatementId;
    h.at(TUESDAY - 1);
    await h.settlements.confirmDueStatements();
    expect(statusOf(h, newId)).toBe('NOTIFIED');
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    expect(statusOf(h, newId)).toBe('CONFIRMED');
  });

  test('J-T23 ① 공휴일이 낀 주: 목요일 완료, 금요일 공휴일이면 이의 기한은 화요일이다', async () => {
    const thursday = Date.parse('2026-11-26T01:00:00.000Z');
    const h = recalcHarness({ now: CONFIRMED_AT, holidays: new Set(['2026-11-27']) });
    const w = threeStores(h);
    const s = await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    const requestId = randomUUID();
    await open(h, { requestId, eventId: w.eventId });
    h.at(thursday);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(thursday) });
    const newId = done.recalculated.find((r) => r.oldStatementId === s.statementId)!.newStatementId;
    expect(h.store.statements.get(newId)!.disputeDueAt?.toISOString()).toBe(new Date(TUESDAY).toISOString());
  });

  // F-03: 판 번호를 글로 견주는 결함(9 → 10)
  test('J-T23 ① 판 9인 정산서를 다시 계산하면 새 판은 10이다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const pay = fact({ amount: 10_000_000, refundedAt: null });
    h.payments.set(eventId, 'TOSS', [pay]);
    const nine = seedStatement(h.store, { promoterId, eventId, pg: 'TOSS', status: 'NOTIFIED', revision: 9, supersedesId: randomUUID(), disputeDueAt: new Date(CONFIRMED_AT + DAY), at: new Date(CONFIRMED_AT - DAY) });
    h.store.sources.set(nine.statementId, [{ statementId: nine.statementId, sourceId: pay.paymentId, kind: 'GROSS', paymentId: pay.paymentId, amount: 10_000_000 }]);
    const requestId = randomUUID();
    await open(h, { requestId, eventId });
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.recalculated).toEqual([expect.objectContaining({ oldStatementId: nine.statementId, revision: 10 })]);
    expect(h.store.statements.get(done.recalculated[0]!.newStatementId)).toMatchObject({ revision: 10, supersedesId: nine.statementId });
  });

  test('J-T23 ① 정산서가 아직 없는 회차(계산 전)는 완료 때 바로 DONE이고 새 판이 없다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const requestId = randomUUID();
    const eventId = randomUUID();
    await expect(open(h, { requestId, eventId })).resolves.toMatchObject({ state: 'PENDING', held: [], skipped: [] });
    h.at(FRIDAY);
    await expect(h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) })).resolves.toMatchObject({ state: 'DONE', recalculated: [] });
    expect(h.store.statements.size).toBe(0);
  });

  test('J-T23 ① 같은 요청 ID를 같은 본문으로 다시 열면 같은 답이고, 다른 회차·종류면 409 recalculation-conflict, 없는 요청의 완료는 404다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'PORTONE', [fact({ amount: 10_000_000 })]);
    const s = seedStatement(h.store, { promoterId, eventId, pg: 'PORTONE', status: 'CONFIRMED', at: new Date(CONFIRMED_AT - DAY) });
    const requestId = randomUUID();
    const first = await open(h, { requestId, eventId });
    expect(first.held).toEqual([s.statementId]);
    await expect(open(h, { requestId, eventId })).resolves.toEqual(first);
    expect(eventsOf(h.store, s.statementId, 'PAYOUT_HELD')).toHaveLength(1);
    expect(h.store.recalculations.size).toBe(1);
    await expect(open(h, { requestId, eventId: randomUUID() })).rejects.toMatchObject({ type: 'recalculation-conflict', status: 409 });
    await expect(open(h, { requestId, eventId, kind: 'POSTPONE' })).rejects.toMatchObject({ type: 'recalculation-conflict', status: 409 });
    await expect(h.settlements.completeEventRecalculation(randomUUID(), { completedAt: new Date(FRIDAY) })).rejects.toBeInstanceOf(SettlementProblem);
    await expect(h.settlements.completeEventRecalculation(randomUUID(), { completedAt: new Date(FRIDAY) })).rejects.toMatchObject({ type: 'not-found', status: 404 });
  });

  // F-22: 완료를 두 번 겹쳐 부름 → 새 판 하나
  test('J-T23 ① 완료 두 번을 겹쳐 불러도 옛 판마다 새 판은 하나이고 두 답이 같다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT - DAY });
    const w = threeStores(h);
    await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    await h.settlements.calculateEvent({ promoterId: w.promoterId, eventId: w.eventId, pg: 'PORTONE', pgStore: 'STANDARD' });
    const requestId = randomUUID();
    h.at(CONFIRMED_AT);
    await open(h, { requestId, eventId: w.eventId });
    h.at(FRIDAY);
    const [a, b] = await Promise.all([
      h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) }),
      h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) }),
    ]);
    expect(a).toEqual(b);
    expect(liveStatementsOf(h.store, w.eventId).map((s) => s.revision)).toEqual([2, 2]);
    expect(h.store.statements.size).toBe(4);
    expect(h.store.outbox.filter((e) => e.value.type === 'STATEMENT_NOTIFIED' && e.value.revision === 2)).toHaveLength(2);
  });
});

/**
 * 음수 옛 판(ADR-0380 결정 8, Q-02, F-25): 판매 대금 100만·수수료율 0bp·감액 조정 −130만 원 → 지급액 −30만 원으로 확정되어 CARRIED_OVER,
 * NEGATIVE_STATEMENT 미수금 30만 원 중 12만 원은 다른 정산서 상계로 이미 돌려받았다(남은 18만 원). 수수료율 0bp라 새 판의 '바뀐 것'은 환급뿐이다
 */
function negativeOld(h: RecalcHarness, o: { recovered: number }) {
  const promoterId = randomUUID();
  const eventId = randomUUID();
  const at = new Date(CONFIRMED_AT - 10 * DAY);
  const pay = fact({ amount: 1_000_000, refundedAt: null });
  h.payments.set(eventId, 'TOSS', [pay]);
  const old = seedStatement(h.store, {
    promoterId,
    eventId,
    pg: 'TOSS',
    status: 'CARRIED_OVER',
    grossAmount: 1_000_000,
    refundAmount: 0,
    commissionAmount: 0,
    commissionVat: 0,
    adjustmentAmount: -1_300_000,
    payoutAmount: -300_000,
    commissionRateBp: 0,
    at,
  });
  h.store.sources.set(old.statementId, [{ statementId: old.statementId, sourceId: pay.paymentId, kind: 'GROSS', paymentId: pay.paymentId, amount: 1_000_000 }]);
  const negative = seedReceivable(h.store, { promoterId, pg: 'TOSS', cause: 'NEGATIVE_STATEMENT', eventId, sourceRef: `negative-statement:${old.statementId}`, amount: 300_000, at });
  const elsewhere = seedStatement(h.store, { promoterId, eventId: randomUUID(), pg: 'TOSS', status: 'PAID', offsetAmount: o.recovered, at });
  if (o.recovered > 0) seedOffset(h.store, { receivableId: negative.receivableId, statementId: elsewhere.statementId, amount: o.recovered, at });
  return { promoterId, eventId, pay, old, negative };
}

const openNegatives = (h: RecalcHarness, promoterId: string) => [...h.store.receivables.values()].filter((r) => r.promoterId === promoterId && r.cause === 'NEGATIVE_STATEMENT' && r.status !== 'CLOSED');

describe('J-T23 ① CARRIED_OVER 음수 옛 판의 NEGATIVE_STATEMENT 미수금(ADR-0380 결정 8, F-25)', () => {
  test('J-T23 ① 바뀐 것 없는 다시 계산: 옛 미수금은 남은 18만 원만큼 SUPERSEDED 이동·CLOSED, 새 판 조정 합 +12만 원, 새 판 확정 때 새 미수금 18만 원 하나 [ASVS v5.0.0-2.3.4]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const n = negativeOld(h, { recovered: 120_000 });
    const requestId = randomUUID();
    const opened = await open(h, { requestId, eventId: n.eventId });
    expect(opened).toMatchObject({ held: [], skipped: [] });
    expect(statusOf(h, n.old.statementId)).toBe('CARRIED_OVER');
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.recalculated).toEqual([{ oldStatementId: n.old.statementId, newStatementId: expect.any(String), revision: 2, negativeClosed: { receivableId: n.negative.receivableId, closedAmount: 180_000, recoveredCredit: 120_000 } }]);
    const newId = done.recalculated[0]!.newStatementId;
    // 옛 미수금: SUPERSEDED 이동 한 줄(남은 금액만큼)·남은 0·CLOSED, 이동 합 불변식
    expect(h.store.receivableMoves.filter((m) => m.receivableId === n.negative.receivableId && m.kind === 'SUPERSEDED')).toEqual([expect.objectContaining({ amount: 180_000 })]);
    expect(h.store.receivables.get(n.negative.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED', amount: 300_000 });
    expect(remainingByMoves(h.store, n.negative.receivableId)).toBe(0);
    // 새 판: 옛 조정 합 −130만 + 돌려받은 12만 = −118만, 지급액 −18만 원
    expect(h.store.statements.get(newId)).toMatchObject({ status: 'NOTIFIED', revision: 2, supersedesId: n.old.statementId, grossAmount: 1_000_000, refundAmount: 0, adjustmentAmount: -1_180_000, payoutAmount: -180_000, commissionRateBp: 0 });
    expect(auditsOf(h.store, newId).some((a) => a.reason.includes(`negative-recovered:${n.negative.receivableId}`))).toBe(true);
    expect(statusOf(h, n.old.statementId)).toBe('SUPERSEDED');
    // 닫은 뒤 새 판 확정 전: 열린 음수 미수금 0
    expect(openNegatives(h, n.promoterId)).toEqual([]);
    // 새 판 확정(T5·T6) → 새 판 ID의 NEGATIVE_STATEMENT 18만 원 하나(옛 남은 금액과 같다)
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    expect(statusOf(h, newId)).toBe('CARRIED_OVER');
    expect(openNegatives(h, n.promoterId)).toEqual([expect.objectContaining({ sourceRef: `negative-statement:${newId}`, amount: 180_000, remaining: 180_000, status: 'OPEN' })]);
  });

  test('J-T23 ① 환급 5만 원이 더해진 다시 계산이면 새 판 지급액 −23만 원, 확정 때 새 미수금 23만 원 하나다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const n = negativeOld(h, { recovered: 120_000 });
    const requestId = randomUUID();
    await open(h, { requestId, eventId: n.eventId });
    h.at(FRIDAY - 60_000);
    h.payments.set(n.eventId, 'TOSS', [fact({ ...n.pay, cancelledAmount: 50_000, status: 'PARTIAL_CANCELED', refundedAt: new Date(FRIDAY - 120_000) })]);
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    const newId = done.recalculated[0]!.newStatementId;
    expect(h.store.statements.get(newId)).toMatchObject({ refundAmount: 50_000, adjustmentAmount: -1_180_000, payoutAmount: -230_000 });
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    expect(openNegatives(h, n.promoterId)).toEqual([expect.objectContaining({ sourceRef: `negative-statement:${newId}`, amount: 230_000 })]);
  });

  test('J-T23 ① 옛 미수금이 전부 상계된 경우(남은 0): 닫는 이동 0줄, 새 판 조정 합에 30만 원을 더해 지급액 0이고 확정 때 새 미수금이 없다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const n = negativeOld(h, { recovered: 300_000 });
    expect(h.store.receivables.get(n.negative.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });
    const requestId = randomUUID();
    await open(h, { requestId, eventId: n.eventId });
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.recalculated[0]!.negativeClosed).toEqual({ receivableId: n.negative.receivableId, closedAmount: 0, recoveredCredit: 300_000 });
    expect(h.store.receivableMoves.filter((m) => m.receivableId === n.negative.receivableId && m.kind === 'SUPERSEDED')).toEqual([]);
    const newId = done.recalculated[0]!.newStatementId;
    expect(h.store.statements.get(newId)).toMatchObject({ adjustmentAmount: -1_000_000, payoutAmount: 0 });
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    expect(openNegatives(h, n.promoterId)).toEqual([]);
  });

  test('J-T23 ① 옛 미수금이 상계되지 않은 경우(남은 30만): SUPERSEDED 30만 원, 조정 합 그대로, 새 미수금 30만 원 하나', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const n = negativeOld(h, { recovered: 0 });
    const requestId = randomUUID();
    await open(h, { requestId, eventId: n.eventId });
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.recalculated[0]!.negativeClosed).toEqual({ receivableId: n.negative.receivableId, closedAmount: 300_000, recoveredCredit: 0 });
    const newId = done.recalculated[0]!.newStatementId;
    expect(h.store.statements.get(newId)).toMatchObject({ adjustmentAmount: -1_300_000, payoutAmount: -300_000 });
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    expect(openNegatives(h, n.promoterId)).toEqual([expect.objectContaining({ sourceRef: `negative-statement:${newId}`, amount: 300_000 })]);
  });
});

describe('J-T23 ② 지급을 요청한 뒤의 회차 취소', () => {
  /** 토스 SCHEDULED 정산서와 그 묶음·조각. 상계 offset원(배상 미수금)을 함께 심는다 */
  function scheduledToss(h: RecalcHarness, o: { promoterId: string; eventId: string; pieces: PayoutStatus[]; offset?: number; pg?: 'TOSS' | 'PORTONE' }) {
    const at = new Date(CONFIRMED_AT - 3 * DAY);
    const pg = o.pg ?? 'TOSS';
    const total = 9_065_000 - (o.offset ?? 0);
    const b = seedBatch(h.store, { pg, payoutDate: '2026-11-25', totalAmount: total, statementCount: 1, at });
    const s = seedStatement(h.store, { promoterId: o.promoterId, eventId: o.eventId, pg, status: 'SCHEDULED', payoutBatchId: b.batchId, payoutDate: '2026-11-25', offsetAmount: o.offset ?? 0, payoutAmount: total, at });
    const each = Math.floor(total / Math.max(1, o.pieces.length));
    const pieces = o.pieces.map((status, i) => seedPayout(h.store, { batchId: b.batchId, statementId: s.statementId, seq: i + 1, amount: i === o.pieces.length - 1 ? total - each * i : each, payoutDate: '2026-11-25', status, at }));
    let receivableId: string | undefined;
    let moveId: string | undefined;
    if (o.offset) {
      const r = seedReceivable(h.store, { promoterId: o.promoterId, pg: null, cause: 'COMPENSATION_ADVANCE', sourceRef: `compensation:${randomUUID()}`, amount: 500_000, at });
      receivableId = r.receivableId;
      moveId = seedOffset(h.store, { receivableId: r.receivableId, statementId: s.statementId, amount: o.offset, at });
    }
    return { s, b, pieces, receivableId, moveId };
  }

  test('J-T23 ② 토스 예약지급이 모두 REQUESTED → 조각마다 예약 취소 1번·CANCELED·HELD(RECALCULATION)·PAYOUT_HELD, 상계 되돌림(REVERSAL·미수금 OPEN 되살림), 완료 뒤 새 판 [ASVS v5.0.0-2.3.3]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, toss: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: ['REQUESTED', 'REQUESTED'], offset: 200_000 });
    expect(h.store.receivables.get(x.receivableId!)).toMatchObject({ remaining: 300_000, status: 'OPEN' });
    const requestId = randomUUID();
    const opened = await open(h, { requestId, eventId });
    expect(opened.held).toEqual([x.s.statementId]);
    expect(h.toss!.cancels.map((c) => [c.pgStore, c.pgPayoutId]).sort()).toEqual(x.pieces.map((p) => ['STANDARD', p.pgPayoutId]).sort());
    for (const p of x.pieces) expect(h.store.payouts.get(p.payoutId)?.status).toBe('CANCELED');
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION', offsetAmount: 0, payoutAmount: 9_065_000 });
    expect(eventsOf(h.store, x.s.statementId, 'PAYOUT_HELD')).toHaveLength(1);
    // 상계 되돌림: 지우지 않고 되돌림 한 줄(되돌린 OFFSET을 가리킴), 미수금 남은 금액 되살림
    const reversal = h.store.receivableMoves.filter((m) => m.kind === 'REVERSAL');
    // data.md receivable_movement: 금액은 양수이고 REVERSAL은 되돌린 금액, reverses_id는 되돌린 이동 기록
    expect(reversal).toEqual([expect.objectContaining({ receivableId: x.receivableId, statementId: x.s.statementId, reversesId: x.moveId, amount: 200_000 })]);
    expect(h.store.receivableMoves.filter((m) => m.moveId === x.moveId)).toHaveLength(1);
    expect(h.store.receivables.get(x.receivableId!)).toMatchObject({ remaining: 500_000, status: 'OPEN' });
    expect(remainingByMoves(h.store, x.receivableId!)).toBe(500_000);

    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done.recalculated).toEqual([expect.objectContaining({ oldStatementId: x.s.statementId, revision: 2 })]);
    expect(h.store.statements.get(done.recalculated[0]!.newStatementId)).toMatchObject({ status: 'NOTIFIED', offsetAmount: 0, supersedesId: x.s.statementId });
  });

  test('J-T23 ② 조각 하나가 IN_PROGRESS인 정산서는 취소 0번·그대로·skipped이고, 다시 계산하지 않으며 환급은 계산 뒤 환급 미수금이 된다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, toss: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const pay = fact({ amount: 10_000_000, refundedAt: null });
    h.payments.set(eventId, 'TOSS', [pay]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: ['IN_PROGRESS', 'REQUESTED'] });
    h.store.sources.set(x.s.statementId, [{ statementId: x.s.statementId, sourceId: pay.paymentId, kind: 'GROSS', paymentId: pay.paymentId, amount: 10_000_000 }]);
    const requestId = randomUUID();
    const opened = await open(h, { requestId, eventId });
    expect(opened).toMatchObject({ held: [], skipped: [x.s.statementId], retrying: [] });
    expect(h.toss!.cancels).toEqual([]);
    expect(x.pieces.map((p) => h.store.payouts.get(p.payoutId)?.status)).toEqual(['IN_PROGRESS', 'REQUESTED']);
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(eventsOf(h.store, x.s.statementId, 'PAYOUT_HELD')).toEqual([]);
    h.at(FRIDAY - 60_000);
    h.payments.set(eventId, 'TOSS', [fact({ ...pay, cancelledAmount: 10_000_000, status: 'CANCELED', refundedAt: new Date(FRIDAY - 120_000) })]);
    await h.settlements.recordRefundsAfterCalculation();
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    expect(done).toMatchObject({ state: 'DONE', recalculated: [] });
    expect(liveStatementsOf(h.store, eventId).map((s) => [s.statementId, s.revision])).toEqual([[x.s.statementId, 1]]);
    expect([...h.store.receivables.values()].filter((r) => r.cause === 'REFUND_AFTER_PAYOUT')).toEqual([expect.objectContaining({ statementId: x.s.statementId, amount: 9_065_000 })]);
  });

  test('J-T23 ② 포트원 SCHEDULED(실행 건 전)는 수기 정산건 취소 1번(정산서 ID) 뒤 HELD(RECALCULATION)이다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, portone: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'PORTONE', [fact({ amount: 10_000_000 })]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: [], pg: 'PORTONE' });
    const opened = await open(h, { requestId: randomUUID(), eventId });
    expect(opened.held).toEqual([x.s.statementId]);
    expect(h.portone!.cancels).toEqual([x.s.statementId]);
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
    expect(auditsOf(h.store, x.s.statementId).at(-1)).toMatchObject({ fromStatus: 'SCHEDULED', toStatus: 'HELD' });
  });

  test('J-T23 ② 포트원 지급대행이 꺼진 조립(수기 포트원 길)이면 취소할 결제사 건이 없어 바로 HELD(RECALCULATION)이다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'PORTONE', [fact({ amount: 10_000_000 })]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: [], pg: 'PORTONE' });
    const opened = await open(h, { requestId: randomUUID(), eventId });
    expect(opened.held).toEqual([x.s.statementId]);
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
  });

  test('J-T23 ② 묶음에 묶인 접수 전 CONFIRMED는 묶음에서 빠지고(합계·건수 다시 셈) 상계를 되돌린 뒤 HELD·PAYOUT_HELD(되돌린 지급액)이고, 같은 묶음의 다른 정산서는 그대로다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const otherEvent = randomUUID();
    const at = new Date(CONFIRMED_AT - DAY);
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const b = seedBatch(h.store, { pg: 'TOSS', payoutDate: '2026-11-26', totalAmount: 8_965_000 + 9_065_000, statementCount: 2, status: 'PENDING_APPROVAL', approvalId: null, at });
    const target = seedStatement(h.store, { promoterId, eventId, pg: 'TOSS', status: 'CONFIRMED', payoutBatchId: b.batchId, payoutDate: '2026-11-26', offsetAmount: 100_000, payoutAmount: 8_965_000, at });
    const other = seedStatement(h.store, { promoterId: randomUUID(), eventId: otherEvent, pg: 'TOSS', status: 'CONFIRMED', payoutBatchId: b.batchId, payoutDate: '2026-11-26', at });
    const r = seedReceivable(h.store, { promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 100_000, at });
    const moveId = seedOffset(h.store, { receivableId: r.receivableId, statementId: target.statementId, amount: 100_000, at });
    const opened = await open(h, { requestId: randomUUID(), eventId });
    expect(opened.held).toEqual([target.statementId]);
    // 정산서: 묶음 빠짐·상계 0·지급액 다시 셈·HELD
    expect(h.store.statements.get(target.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION', payoutBatchId: null, offsetAmount: 0, payoutAmount: 9_065_000 });
    expect(eventsOf(h.store, target.statementId, 'PAYOUT_HELD').map((e) => e.value.amount)).toEqual([9_065_000]);
    // 묶음: 합계·건수 다시 셈
    expect(h.store.batches.get(b.batchId)).toMatchObject({ totalAmount: 9_065_000, statementCount: 1 });
    // 다른 정산서는 그대로 묶여 있다
    expect(h.store.statements.get(other.statementId)).toMatchObject({ status: 'CONFIRMED', payoutBatchId: b.batchId, payoutAmount: 9_065_000 });
    // 이동·미수금
    expect(h.store.receivableMoves.filter((m) => m.kind === 'REVERSAL')).toEqual([expect.objectContaining({ receivableId: r.receivableId, statementId: target.statementId, reversesId: moveId, amount: 100_000 })]);
    expect(h.store.receivables.get(r.receivableId)).toMatchObject({ remaining: 100_000, status: 'OPEN' });
    expect(remainingByMoves(h.store, r.receivableId)).toBe(100_000);
  });

  // F-14: 예약 취소 응답 없음·5xx, 포트원 수기 정산건 취소 실패 → 그 정산서 그대로·다시 하기, 다른 정산서는 이어 간다
  test('J-T23 ② 토스 예약 취소 응답 없음·포트원 취소 5xx면 그 정산서는 그대로 retrying이고 다른 정산서는 이어 가며, 다음 다시 하기가 마저 한다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, toss: true, portone: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })], 'STANDARD');
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })], 'ESCROW');
    h.payments.set(eventId, 'PORTONE', [fact({ amount: 10_000_000 })]);
    const failing = scheduledToss(h, { promoterId, eventId, pieces: ['REQUESTED'] });
    const ok = scheduledToss(h, { promoterId, eventId, pieces: ['REQUESTED'] });
    h.store.statements.set(ok.s.statementId, { ...h.store.statements.get(ok.s.statementId)!, pgStore: 'ESCROW' });
    const portone = scheduledToss(h, { promoterId, eventId, pieces: [], pg: 'PORTONE' });
    h.toss!.failCancel(failing.pieces[0]!.pgPayoutId!, 'NO_RESPONSE');
    h.portone!.failCancel(portone.s.statementId);
    const requestId = randomUUID();
    const opened = await open(h, { requestId, eventId });
    expect(opened.held).toEqual([ok.s.statementId]);
    expect([...opened.retrying].sort()).toEqual([failing.s.statementId, portone.s.statementId].sort());
    expect(h.store.statements.get(failing.s.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(h.store.payouts.get(failing.pieces[0]!.payoutId)?.status).toBe('REQUESTED');
    expect(h.store.statements.get(portone.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
    expect(h.store.statements.get(ok.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
    expect([...h.store.recalculations.get(requestId)!.retryStatementIds].sort()).toEqual([failing.s.statementId, portone.s.statementId].sort());

    await expect(h.settlements.retryEventRecalculations()).resolves.toMatchObject({ retried: 2 });
    expect(h.store.statements.get(failing.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
    expect(h.store.statements.get(portone.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
    expect(h.store.recalculations.get(requestId)!.retryStatementIds).toEqual([]);
    // 같은 요청 ID로 다시 열어도 이미 한 것은 건너뛴다(취소 호출이 늘지 않는다)
    const cancelsBefore = h.toss!.cancels.length;
    await open(h, { requestId, eventId });
    expect(h.toss!.cancels).toHaveLength(cancelsBefore);
  });

  test('J-T23 ② 토스 예약 취소 5xx도 retrying이고, 정산 일꾼의 30분 tick이 다시 한다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, toss: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: ['REQUESTED'] });
    h.toss!.failCancel(x.pieces[0]!.pgPayoutId!, 'HTTP_5XX');
    const requestId = randomUUID();
    await expect(open(h, { requestId, eventId })).resolves.toMatchObject({ retrying: [x.s.statementId] });
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    h.at(CONFIRMED_AT + 30 * 60_000);
    await worker.tick(false);
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION' });
    expect(h.store.payouts.get(x.pieces[0]!.payoutId)?.status).toBe('CANCELED');
  });

  test('J-T23 ② PENDING 동안 확정된 정산서는 지급 묶음 판정이 HELD(RECALCULATION)로 두고 묶지 않으며, 재확정은 409 statement-recalculation-pending이다', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const at = new Date(CONFIRMED_AT - DAY);
    h.store.kycs.set(promoterId, verifiedKyc(promoterId, at));
    approvedTossSeller(h.store, promoterId, 'STANDARD', at);
    const target = seedStatement(h.store, { promoterId, eventId, pg: 'TOSS', status: 'NOTIFIED', disputeDueAt: new Date(CONFIRMED_AT + DAY), payoutDate: '2026-11-30', at });
    const unrelated = seedStatement(h.store, { promoterId, eventId: randomUUID(), pg: 'TOSS', status: 'CONFIRMED', payoutDate: '2026-11-30', at });
    await open(h, { requestId: randomUUID(), eventId });
    expect(statusOf(h, target.statementId)).toBe('NOTIFIED');
    h.at(CONFIRMED_AT + DAY);
    await h.settlements.confirmDueStatements();
    expect(statusOf(h, target.statementId)).toBe('CONFIRMED');
    const batch = await h.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-30', actor: randomUUID() });
    expect(batch).toMatchObject({ statementCount: 1, totalAmount: 9_065_000 });
    expect(h.store.statements.get(target.statementId)).toMatchObject({ status: 'HELD', holdReason: 'RECALCULATION', payoutBatchId: null });
    expect(h.store.statements.get(unrelated.statementId)!.payoutBatchId).toBe(batch.batchId);
    await expect(h.settlements.reconfirmStatement(target.statementId, { actor: randomUUID(), reason: '보류 풀기' })).rejects.toMatchObject({ type: 'statement-recalculation-pending', status: 409 });
    expect(statusOf(h, target.statementId)).toBe('HELD');
  });

  test('J-T23 ② 완료 뒤에는 그 회차의 새 판이 다음 묶음에서 다시 상계되고 미수금 남은 금액 = 금액 − 이동 합이 지켜진다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = recalcHarness({ now: CONFIRMED_AT, toss: true });
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const at = new Date(CONFIRMED_AT - DAY);
    h.store.kycs.set(promoterId, verifiedKyc(promoterId, at));
    approvedTossSeller(h.store, promoterId, 'STANDARD', at);
    h.payments.set(eventId, 'TOSS', [fact({ amount: 10_000_000 })]);
    const x = scheduledToss(h, { promoterId, eventId, pieces: ['REQUESTED'], offset: 200_000 });
    const requestId = randomUUID();
    await open(h, { requestId, eventId });
    h.at(FRIDAY);
    const done = await h.settlements.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) });
    const newId = done.recalculated[0]!.newStatementId;
    h.at(TUESDAY);
    await h.settlements.confirmDueStatements();
    const fresh = h.store.statements.get(newId)!;
    expect(fresh.status).toBe('CONFIRMED');
    await h.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: fresh.payoutDate!, actor: randomUUID() });
    expect(h.store.receivableMoves.filter((m) => m.statementId === newId && m.kind !== 'REVERSAL')).toEqual([expect.objectContaining({ receivableId: x.receivableId, amount: 500_000 })]);
    expect(h.store.receivables.get(x.receivableId!)).toMatchObject({ remaining: 0, status: 'CLOSED' });
    expect(remainingByMoves(h.store, x.receivableId!)).toBe(0);
  });
});

describe('J-T23 ① 내부 HTTP 두 경로', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function http() {
    vi.stubEnv('PEAKET_INTERNAL_TOKEN', 'internal-f078');
    const clock = fakeClock({ now: CONFIRMED_AT });
    const store = new MemorySettlementStore();
    const svc = await createService({
      name: 'payment-svc',
      module: SettlementModule.register({
        store,
        payments: new MemorySettlementPaymentSource(),
        approvals: noApprovals,
        saleSuspensions: noSaleSuspensions,
        eventCommission: { rateBp: async () => 850 },
        gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
        reauth: new MemoryReauthVerifier(),
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
    });
    return { svc, store, clock };
  }

  test('J-T23 ① PUT …/event-recalculations/{requestId}는 200·no-store이고 같은 답을 주며, 모르는 칸 400 invalid-body, 다른 회차 409 recalculation-conflict', async () => {
    const { svc, store } = await http();
    try {
      const requestId = randomUUID();
      const eventId = randomUUID();
      const url = `/internal/v1/settlements/event-recalculations/${requestId}`;
      const headers = { 'content-type': 'application/json', 'x-peaket-internal-token': 'internal-f078' };
      const body = { eventId, kind: 'CANCEL', confirmedAt: new Date(CONFIRMED_AT).toISOString() };
      const ok = await svc.http.inject({ method: 'PUT', url, headers, payload: JSON.stringify(body) });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toContain('no-store');
      expect(JSON.parse(ok.payload)).toMatchObject({ requestId, eventId, kind: 'CANCEL', state: 'PENDING', held: [], skipped: [], retrying: [], recalculated: [] });
      const again = await svc.http.inject({ method: 'PUT', url, headers, payload: JSON.stringify(body) });
      expect(again.statusCode).toBe(200);
      expect(JSON.parse(again.payload)).toEqual(JSON.parse(ok.payload));
      const extra = await svc.http.inject({ method: 'PUT', url: `/internal/v1/settlements/event-recalculations/${randomUUID()}`, headers, payload: JSON.stringify({ ...body, accountNumber: '11012345678901' }) });
      expect(extra.statusCode).toBe(400);
      expect(JSON.parse(extra.payload).type).toContain('invalid-body');
      const conflict = await svc.http.inject({ method: 'PUT', url, headers, payload: JSON.stringify({ ...body, eventId: randomUUID() }) });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.payload).type).toContain('recalculation-conflict');
      expect(store.recalculations.size).toBe(1);

      const completion = await svc.http.inject({ method: 'POST', url: `${url}/completion`, headers, payload: JSON.stringify({ completedAt: new Date(FRIDAY).toISOString() }) });
      expect(completion.statusCode).toBe(200);
      expect(JSON.parse(completion.payload)).toMatchObject({ requestId, state: 'DONE' });
      const missing = await svc.http.inject({ method: 'POST', url: `/internal/v1/settlements/event-recalculations/${randomUUID()}/completion`, headers, payload: JSON.stringify({ completedAt: new Date(FRIDAY).toISOString() }) });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.payload).type).toContain('not-found');
    } finally {
      await svc.close();
    }
  });

  // F-24: 내부 토큰 없음·틀림은 거절이고 아무것도 쓰지 않는다. 정본·계획은 401이라 적었고 플랫폼 InternalTokenGuard는 403을 낸다(계획 §7 '인터페이스 빈칸')
  test('J-T23 ① 내부 토큰 없음·틀림이면 두 경로 모두 거절(401·403)이고 다시 계산 행·정산서가 생기지 않는다', async () => {
    const { svc, store } = await http();
    try {
      const requestId = randomUUID();
      const url = `/internal/v1/settlements/event-recalculations/${requestId}`;
      const body = JSON.stringify({ eventId: randomUUID(), kind: 'CANCEL', confirmedAt: new Date(CONFIRMED_AT).toISOString() });
      for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'x-peaket-internal-token': 'wrong' }]) {
        const put = await svc.http.inject({ method: 'PUT', url, headers, payload: body });
        expect([401, 403]).toContain(put.statusCode);
        const post = await svc.http.inject({ method: 'POST', url: `${url}/completion`, headers, payload: JSON.stringify({ completedAt: new Date(FRIDAY).toISOString() }) });
        expect([401, 403]).toContain(post.statusCode);
      }
      expect(store.recalculations.size).toBe(0);
      expect(store.statements.size).toBe(0);
    } finally {
      await svc.close();
    }
  });
});
