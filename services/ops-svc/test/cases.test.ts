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
    // 같은 대상이라도 종류가 다르면 다른 건이다
    const refundFailed = await handler.handle({ ...pending, kind: 'REFUND_FAILED' }, NOW + 2);
    expect(refundFailed.case!.caseId).not.toBe(a.case!.caseId);
    expect(store.cases.size).toBe(2);
  });

  // BAT-420-rest 리뷰 반영 RV-01(시험 담당 l3-b420-test, 2026-11-19): 정본(transfer-refund §3.1 ⑥ '실패 기록', P-T75)이 환불 대기(REFUND_ACCOUNT_PENDING)를 받는 종류에 더해 셋에서 넷으로 바꿨다(정본 변경 반영)
  test('GAT-090 A4 받는 종류 넷(REFUND_FAILED·FLAGGED·JUDGEMENT_PENDING·REFUND_ACCOUNT_PENDING) 밖은 종류마다 건을 만들지 않는다', async () => {
    const accepted = new Set(['REFUND_FAILED', 'FLAGGED', 'JUDGEMENT_PENDING', 'REFUND_ACCOUNT_PENDING']);
    const others = CS_CASE_KINDS.filter((k) => !accepted.has(k));
    expect(others.length).toBe(CS_CASE_KINDS.length - 4);
    expect(others).toContain('DISPUTE');
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
