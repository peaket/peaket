// support.cases-requested의 REFUND_FAILED를 CS 처리함 건으로 여는 계약(GAT-110 첫 몫).
import { describe, expect, test } from 'vitest';
import { CS_CASE_KINDS, MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const payload = { eventKey: '0193a000-0000-7000-8000-000000000001', kind: 'REFUND_FAILED' as const, sourceId: 'cancel-1', category: 'REFUND', createdAt: new Date(NOW).toISOString() };

describe('CS 처리함 건 접수', () => {
  test('GAT110_REFUND_FAILED는_열린_건_하나를_만든다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const r = await handler.handle(payload, NOW);
    expect(r.accepted).toBe(true);
    expect(r.case).toMatchObject({ kind: 'REFUND_FAILED', targetRef: 'cancel-1', status: 'OPEN' });
    expect(store.cases.size).toBe(1);
  });

  test('GAT110_같은_대상의_다시_온_요청은_같은_열린_건이다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const a = await handler.handle(payload, NOW);
    const b = await handler.handle(payload, NOW + 1000);
    expect(b.case!.caseId).toBe(a.case!.caseId);
    expect(store.cases.size).toBe(1);
  });

  test('GAT110_이_골격이_받지_않는_종류는_건을_만들지_않는다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const r = await handler.handle({ ...payload, kind: 'INQUIRY' }, NOW);
    expect(r.accepted).toBe(false);
    expect(store.cases.size).toBe(0);
  });

  // BAT-420 GAT-090 A·GAT-110 Q·P: 이상 표시(입장 기록 대조)와 회차 취소 판정 대기 건을 받는다. 시험 담당이 구현 전에 썼다.
  test('GAT-090 A4 이상 표시 FLAGGED는 CS 처리함 건으로 열리고 같은 취소는 한 건이다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const cancellationId = '0194b000-0000-7000-8000-0000000a0001';
    const flagged = { eventKey: `entry-after-cancel:${cancellationId}`, kind: 'FLAGGED' as const, sourceId: cancellationId, category: 'ENTRY_AFTER_CANCEL', createdAt: new Date(NOW).toISOString() };
    const a = await handler.handle(flagged, NOW);
    expect(a.accepted).toBe(true);
    expect(a.case).toMatchObject({ kind: 'FLAGGED', targetRef: cancellationId, status: 'OPEN' });
    const b = await handler.handle(flagged, NOW + 60_000);
    expect(b.case!.caseId).toBe(a.case!.caseId);
    expect(store.cases.size).toBe(1);
  });

  test('GAT-090 A4 회차 취소 판정 대기 JUDGEMENT_PENDING은 요청 ID마다 한 건으로 열린다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const requestId = '0194b000-0000-7000-8000-0000000a0002';
    const pending = { eventKey: `judgement-pending:${requestId}`, kind: 'JUDGEMENT_PENDING' as const, sourceId: requestId, category: 'EVENT_CANCELLATION', createdAt: new Date(NOW).toISOString() };
    const a = await handler.handle(pending, NOW);
    expect(a.accepted).toBe(true);
    expect(a.case).toMatchObject({ kind: 'JUDGEMENT_PENDING', targetRef: requestId, status: 'OPEN' });
    expect((await handler.handle(pending, NOW + 1)).case!.caseId).toBe(a.case!.caseId);
    // F-06-2 시험 이의 판단(시험 담당 lane3-f062-test, 2026-11-23): eventKey는 cs_case_request 기본 키로 한 번만 받는다(ADR-0364 결정 4,
    // data.md cs_case_request.event_key). 같은 eventKey에 종류만 바꾼 요청은 이미 받은 사건(duplicate)이고 새 건이 없다
    const sameKey = await handler.handle({ ...pending, kind: 'REFUND_FAILED' }, NOW + 2);
    expect([sameKey.result, sameKey.case!.caseId]).toEqual(['duplicate', a.case!.caseId]);
    expect(store.cases.size).toBe(1);
    // 같은 대상이라도 종류가 다르면(다른 사건) 다른 건이다
    const refundFailed = await handler.handle({ ...pending, eventKey: `refund-failed:${requestId}`, kind: 'REFUND_FAILED' }, NOW + 3);
    expect(refundFailed.case!.caseId).not.toBe(a.case!.caseId);
    expect(store.cases.size).toBe(2);
  });

  // BAT-420-rest 리뷰 반영 RV-01(시험 담당 l3-b420-test, 2026-11-19): 정본(transfer-refund §3.1 ⑥ '실패 기록', P-T75)이 환불 대기(REFUND_ACCOUNT_PENDING)를 받는 종류에 더해 셋에서 넷으로 바꿨다(정본 변경 반영)
  // F-07-5 시험 담당(lane5-f075-test, 2026-11-23): 정본 settlement §4.2 '이의 받기'(ADR-0368 결정 5)가 payment-svc의 정산 이의 건(STATEMENT_DISPUTE)을
  // 내부 HTTP로 받게 해 받는 종류에 더했다(정본 변경 반영). 그 밖 종류는 여전히 건을 만들지 않는다.
  // F-06-2 시험 이의 판단(시험 담당 lane3-f062-test, 2026-11-23): ADR-0364 결정 4(transfer-refund §11 R-T48 ①)의 아홉과 위 STATEMENT_DISPUTE를 합쳐 받는 종류는 열이다
  // F-07-6 시험 담당(lane5-f076-test, 2026-11-23, 시험 이의 TO-02): ADR-0369 결정 10이 지급 쪽 다섯(SELLER_KYC_REQUIRED·PAYOUT_ERROR·PAYOUT_FAILED·PAYOUT_DELAYED·
  // PG_BALANCE_MISMATCH)을 받게 해(J-T38 ⑥, cs-case-payout-kinds.test.ts) 받는 종류는 열다섯이다
  // F-07-7 시험 담당(lane5-f077-test, 2026-11-23, 시험 이의 TO-07): ADR-0370 결정 7·8(계획 I-07)이 포트원 둘(PORTONE_PAYOUT_EXECUTION·PORTONE_LEDGER_MISMATCH)을
  // 받게 해(J-T41 ②·J-T20 ②, cs-case-portone-kinds.test.ts) 받는 종류는 열일곱이다
  test('GAT-090 A4 J-T35 ③ R-T48 ③ J-T38 ⑥ J-T41 ② 받는 종류 열여덟 밖은 종류마다 건을 만들지 않는다', async () => {
    const accepted = new Set([
      'REFUND_FAILED',
      'FLAGGED',
      'JUDGEMENT_PENDING',
      'REFUND_ACCOUNT_PENDING',
      'COMPENSATION_PENDING',
      'VERIFICATION_APPEAL',
      'DISPUTE',
      'SCANNER_UNREPORTED',
      'APPROVAL_EXECUTION_FAILED',
      'STATEMENT_DISPUTE',
      'SELLER_KYC_REQUIRED',
      'PAYOUT_ERROR',
      'PAYOUT_FAILED',
      'PAYOUT_DELAYED',
      'PG_BALANCE_MISMATCH',
      'PORTONE_PAYOUT_EXECUTION',
      'PORTONE_LEDGER_MISMATCH',
      'SETTLEMENT_ADJUSTMENT_SUGGESTED',
    ]);
    const others = CS_CASE_KINDS.filter((k) => !accepted.has(k));
    expect(others.length).toBe(CS_CASE_KINDS.length - 18);
    expect(others).toEqual(expect.arrayContaining(['INQUIRY', 'CONTENT_REPORT', 'APPEAL', 'TICKET_NOT_ISSUED']));
    expect(others).not.toContain('STATEMENT_DISPUTE');
    // 포트원 실행·원장 불일치는 이제 받는 쪽이다
    expect(others).not.toContain('PORTONE_PAYOUT_EXECUTION');
    expect(others).not.toContain('PORTONE_LEDGER_MISMATCH');
    for (const kind of others) {
      const store = new MemoryCsCaseStore();
      const r = await new ReceiveCaseRequested(store).handle({ ...payload, kind }, NOW);
      expect({ kind, accepted: r.accepted }).toEqual({ kind, accepted: false });
      expect(store.cases.size).toBe(0);
    }
  });

  test('P-T75 ① 환불 대기 REFUND_ACCOUNT_PENDING은 대상 취소 ID로 건 하나를 열고 같은 취소의 다시 온 요청은 같은 건이다', async () => {
    const store = new MemoryCsCaseStore();
    const handler = new ReceiveCaseRequested(store);
    const cancellationId = '0194b000-0000-7000-8000-0000000a0009';
    const pending = { eventKey: cancellationId, kind: 'REFUND_ACCOUNT_PENDING' as const, sourceId: cancellationId, category: 'REFUND', createdAt: new Date(NOW).toISOString() };
    const a = await handler.handle(pending, NOW);
    expect(a.accepted).toBe(true);
    expect(a.case).toMatchObject({ kind: 'REFUND_ACCOUNT_PENDING', targetRef: cancellationId, status: 'OPEN' });
    expect((await handler.handle(pending, NOW + 1)).case!.caseId).toBe(a.case!.caseId);
    expect(store.cases.size).toBe(1);
  });
});
