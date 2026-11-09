// 대사의 값과 규칙(BUILD_ORDER HOT-153, docs/features/payment.md §8 '대사의 첫 구현', P-T32): 비교 표(모든 종류), 시간 규칙, 대상 날짜, 호출 몫.
import { describe, expect, test } from 'vitest';
import type { QueryStatus } from '../src/modules/payment/domain/payment-gateway.js';
import { decideLedgerOnly, decideReconciliation, DEPOSIT_SECRET_HASH_RETENTION_MS, reconChangedAfterDay, reconciliationCallsPerSecond, reconDateOf, reconListRangeOf, reconRangeOf, reconStartDecision, reconTargets, reconWindowDates, RECON_DIFF_KINDS, RECON_MARGIN_MS, type ReconLedger, type ReconSeen } from '../src/modules/payment/domain/reconciliation.js';

const ORDER = '0195f3a0-0000-7000-8000-000000000001';
const seen = (o: { status?: QueryStatus; amount?: number; orderRef?: string } = {}): ReconSeen => ({ paymentRef: 'pk-1', orderRef: o.orderRef ?? ORDER, pgStatus: o.status ?? 'APPROVED', amount: o.amount ?? 1000 });
const ledger = (o: Partial<ReconLedger> = {}): ReconLedger => ({ paymentId: 'p-1', orderId: ORDER, eventId: 'e-1', attemptNo: 1, pg: 'TOSS', paymentRef: 'pk-1', amount: 1000, status: 'APPROVED', ...o });
const KST = (iso: string) => Date.parse(`${iso}+09:00`);

describe('P-T32 비교 표', () => {
  test('P-T32_승인 + 원장 승인·금액 같음은 맞음이다', () => {
    expect(decideReconciliation(seen(), ledger(), 'TOSS')).toEqual({ kind: 'MATCH' });
  });

  test('P-T32_결제사 승인 + 원장 없음은 불일치와 SEV1이다 [ASVS v5.0.0-16.3.3]', () => {
    expect(decideReconciliation(seen(), undefined, 'TOSS')).toEqual({ kind: 'DIFF', diff: 'PG_APPROVED_NO_LEDGER', action: 'NONE', sev1: true });
  });

  test('P-T32_원장 없음이어도 취소·입금 대기처럼 돈이 없는 거래는 맞음으로 본다', () => {
    expect(decideReconciliation(seen({ status: 'WAITING_FOR_DEPOSIT' }), undefined, 'TOSS')).toEqual({ kind: 'MATCH' });
  });

  test('P-T32_원장의 pg가 대사 중인 결제사와 다르면 결제사 혼동이다(상태를 보지 않는다) [ASVS v5.0.0-2.2.3]', () => {
    expect(decideReconciliation(seen(), ledger({ pg: 'PORTONE' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'PG_MISMATCH', action: 'NONE', sev1: true });
    expect(decideReconciliation(seen({ status: 'CANCELED' }), ledger({ pg: 'SIMULATOR', status: 'UNKNOWN' }), 'TOSS')).toMatchObject({ diff: 'PG_MISMATCH' });
  });

  test('P-T32_주문 ID가 다르면 불일치다(구현에서 정함)', () => {
    expect(decideReconciliation(seen({ orderRef: 'other' }), ledger(), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'ORDER_MISMATCH', action: 'NONE', sev1: true });
  });

  test.each(['APPROVED', 'UNKNOWN', 'AWAITING_DEPOSIT', 'FAILED'] as const)('P-T32_금액이 다르면 원장 %s에서도 기록과 SEV1이고 원장을 바꾸지 않는다 [ASVS v5.0.0-2.2.3]', (status) => {
    expect(decideReconciliation(seen({ amount: 2000 }), ledger({ status }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'AMOUNT_MISMATCH', action: 'NONE', sev1: true });
  });

  test('P-T32_결제사 승인 + 원장 UNKNOWN은 조회로 넘긴다(SEV1 없음)', () => {
    expect(decideReconciliation(seen(), ledger({ status: 'UNKNOWN' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'UNKNOWN_HANDED_OFF', action: 'REQUERY', sev1: false });
  });

  test('P-T32_결제사 승인 + 원장 입금 대기도 조회로 넘긴다', () => {
    expect(decideReconciliation(seen(), ledger({ status: 'AWAITING_DEPOSIT' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'UNKNOWN_HANDED_OFF', action: 'REQUERY', sev1: false });
  });

  test('P-T32_결제사 입금 완료 + 원장 FAILED는 늦은 입금으로 기록·SEV1(csCase)이고 환불·재발권을 하지 않는다', () => {
    expect(decideReconciliation(seen(), ledger({ status: 'FAILED' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'LEDGER_FAILED_PG_APPROVED', action: 'NONE', sev1: true, csCase: 'PAYMENT_LATE_DEPOSIT' });
  });

  test.each(['FAILED', 'EXPIRED', 'CANCELED', 'WAITING_FOR_DEPOSIT', 'READY'] as const)('P-T32_원장 승인인데 결제사 %s이면 기록·SEV1이고 APPROVED → UNKNOWN 전이가 없어 원장을 바꾸지 않는다', (status) => {
    expect(decideReconciliation(seen({ status }), ledger(), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'LEDGER_APPROVED_PG_NOT_PAID', action: 'NONE', sev1: true });
  });

  test.each(['APPROVED', 'UNKNOWN'] as const)('P-T32_부분 취소는 원장 %s에서 CS로 둔다(기록·SEV1, 닫지 않는다)', (status) => {
    expect(decideReconciliation(seen({ status: 'PARTIAL_CANCELED' }), ledger({ status }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'PARTIAL_CANCELED_AT_PG', action: 'NONE', sev1: true });
  });

  test('P-T32_UNKNOWN + 결제사 전액 취소는 원장을 닫는다(SEV1 없음)', () => {
    expect(decideReconciliation(seen({ status: 'CANCELED' }), ledger({ status: 'UNKNOWN' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'UNKNOWN_CANCELED_CLOSED', action: 'CLOSE_CANCELED', sev1: false });
  });

  test('P-T32_UNKNOWN + 결제사 실패·입금 대기는 조회로 넘긴다', () => {
    for (const status of ['FAILED', 'EXPIRED', 'WAITING_FOR_DEPOSIT'] as const) expect(decideReconciliation(seen({ status }), ledger({ status: 'UNKNOWN' }), 'TOSS'), status).toEqual({ kind: 'DIFF', diff: 'UNKNOWN_HANDED_OFF', action: 'REQUERY', sev1: false });
  });

  test('P-T32_결제사가 아직 처리 중인 UNKNOWN은 맞음으로 센다(조회가 계속 묻는다)', () => {
    expect(decideReconciliation(seen({ status: 'IN_PROGRESS' }), ledger({ status: 'UNKNOWN' }), 'TOSS')).toEqual({ kind: 'MATCH' });
  });

  test('P-T32_원장 취소인데 결제사 승인이면 환급 불일치다', () => {
    expect(decideReconciliation(seen(), ledger({ status: 'CANCELED' }), 'TOSS')).toEqual({ kind: 'DIFF', diff: 'LEDGER_CANCELED_PG_APPROVED', action: 'NONE', sev1: true });
    expect(decideReconciliation(seen(), ledger({ status: 'PARTIAL_CANCELED' }), 'TOSS')).toMatchObject({ diff: 'LEDGER_CANCELED_PG_APPROVED' });
  });

  test('P-T32_원장 실패·결제사 취소처럼 돈이 없으면 맞음이다', () => {
    expect(decideReconciliation(seen({ status: 'CANCELED' }), ledger({ status: 'FAILED' }), 'TOSS')).toEqual({ kind: 'MATCH' });
    expect(decideReconciliation(seen({ status: 'FAILED' }), ledger({ status: 'FAILED' }), 'TOSS')).toEqual({ kind: 'MATCH' });
    expect(decideReconciliation(seen({ status: 'CANCELED' }), ledger({ status: 'CANCELED' }), 'TOSS')).toEqual({ kind: 'MATCH' });
    expect(decideReconciliation(seen(), ledger({ status: 'ACCEPTED' }), 'TOSS')).toEqual({ kind: 'MATCH' });
  });

  test('P-T32_원장 승인 + 결제사 기록 없음은 불일치, 그 밖의 상태는 맞음이다', () => {
    expect(decideLedgerOnly({ status: 'APPROVED' })).toEqual({ kind: 'DIFF', diff: 'LEDGER_APPROVED_NO_PG_RECORD', action: 'NONE', sev1: true });
    expect(decideLedgerOnly({ status: 'FAILED' })).toEqual({ kind: 'MATCH' });
  });
});

describe('P-T32 시간 규칙', () => {
  test('P-T32_리뷰 고침 M10·M11: 시작은 여백 10분이 지난 00:10부터 04시대까지이고, 윈도우 안이면 04시 전까지 미룬다 [ASVS v5.0.0-2.4.1]', () => {
    // M11: 전날 ± 10분을 받으려면 00:10까지 기다린다
    expect(reconStartDecision(KST('2026-11-10T00:05:00'), false)).toBe('DEFER');
    expect(reconStartDecision(KST('2026-11-10T00:09:59'), false)).toBe('DEFER');
    expect(reconStartDecision(KST('2026-11-10T00:10:00'), false)).toBe('START');
    expect(reconStartDecision(KST('2026-11-10T00:10:00'), true)).toBe('DEFER');
    expect(reconStartDecision(KST('2026-11-10T03:59:59'), true)).toBe('DEFER');
    expect(reconStartDecision(KST('2026-11-10T04:00:00'), true)).toBe('START');
    expect(reconStartDecision(KST('2026-11-10T04:59:59'), false)).toBe('START');
    // M10: 낮에 프로세스가 다시 떠도 대사를 시작하지 않는다
    expect(reconStartDecision(KST('2026-11-10T05:00:00'), false)).toBe('DEFER');
    expect(reconStartDecision(KST('2026-11-10T23:00:00'), true)).toBe('DEFER');
  });

  test('P-T32_리뷰 고침 H2: 대상 날짜 끝 이후에 바뀐 원장을 가린다(그날 목록 값과 견주지 않는다)', () => {
    expect(reconChangedAfterDay({ statusChangedAtMs: KST('2026-11-10T00:00:00') }, '2026-11-09')).toBe(true);
    expect(reconChangedAfterDay({ statusChangedAtMs: KST('2026-11-09T23:59:59') }, '2026-11-09')).toBe(false);
    expect(reconChangedAfterDay({}, '2026-11-09')).toBe(false);
  });

  test('P-T32_리뷰 고침 M13: 못 읽는 줄의 종류가 있다', () => {
    expect(RECON_DIFF_KINDS).toContain('UNREADABLE');
  });

  test('P-T32_대상 날짜는 KST 전날이고 범위는 그날 0시~다음날 0시다', () => {
    expect(reconDateOf(KST('2026-11-10T00:05:00'))).toBe('2026-11-09');
    expect(reconDateOf(Date.parse('2026-11-09T14:59:59Z'))).toBe('2026-11-08');
    const { fromMs, toMs } = reconRangeOf('2026-11-09');
    expect(fromMs).toBe(KST('2026-11-09T00:00:00'));
    expect(toMs).toBe(KST('2026-11-10T00:00:00'));
  });

  test('P-T32_결제사 조회 범위는 앞뒤로 10분 넓다', () => {
    const { fromMs, toMs } = reconListRangeOf('2026-11-09');
    expect(fromMs).toBe(KST('2026-11-09T00:00:00') - RECON_MARGIN_MS);
    expect(toMs).toBe(KST('2026-11-10T00:00:00') + RECON_MARGIN_MS);
  });

  test('P-T32_리뷰 고침 H4: 지난 7일을 모두 나열해 행이 없는 날도 빠뜨리지 않고 DONE이 아닌 날을 오래된 차례로 돈다', () => {
    const now = KST('2026-11-10T00:10:00');
    const week = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
    const done = (date: string) => ({ date, status: 'DONE' as const });
    expect(reconWindowDates(now)).toEqual(week);
    expect(reconTargets([], now)).toEqual(week);
    expect(reconTargets(week.map(done), now)).toEqual([]);
    // 가운데 하루의 행이 없어도(그날 프로세스가 돌지 않았다) 다시 돈다
    expect(reconTargets(week.filter((d) => d !== '2026-11-06').map(done), now)).toEqual(['2026-11-06']);
    expect(
      reconTargets(
        [
          ...week.slice(0, 4).map(done),
          { date: '2026-11-07', status: 'RUNNING' },
          { date: '2026-11-08', status: 'FAILED', finishedAtMs: KST('2026-11-09T02:00:00') },
          { date: '2026-11-09', status: 'FAILED', finishedAtMs: KST('2026-11-10T00:05:00') },
        ],
        now,
      ),
    ).toEqual(['2026-11-07', '2026-11-08']);
    // 오늘 실패한 전날은 오늘 다시 하지 않는다(다음 날 다시)
    expect(reconTargets([...week.slice(0, 6).map(done), { date: '2026-11-09', status: 'FAILED', finishedAtMs: KST('2026-11-10T00:05:00') }], KST('2026-11-10T00:20:00'))).toEqual([]);
  });

  test('P-T32_입금 secret 해시는 입금 확정 뒤 90일이 지나야 지운다(기간 값을 고정한다) [ASVS v5.0.0-14.2.7]', () => {
    expect(DEPOSIT_SECRET_HASH_RETENTION_MS).toBe(90 * 86_400_000);
  });

  test('P-T32_대사의 호출 몫은 초당 상한의 10%다 [ASVS v5.0.0-2.4.1]', () => {
    expect(reconciliationCallsPerSecond(300)).toBe(30);
    expect(reconciliationCallsPerSecond(1)).toBeCloseTo(0.1);
  });
});
