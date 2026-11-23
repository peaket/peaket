// CS 처리함 '포트원 일괄 지급 실행'·'포트원 원장 불일치' 건(ops 쪽, F-07-7 LCH-120, ADR-0370 결정 7·8, docs/features/settlement.md §5.3).
// payment-svc 정산 일꾼이 settlement_case_request를 POST /internal/v1/cs-cases로 보낸다:
// PORTONE_PAYOUT_EXECUTION(대상 = 묶음 ID, 사건 키 portone-execution:{묶음 ID}), PORTONE_LEDGER_MISMATCH(대상 = 이체 ID·파트너 ID·정산서 ID·묶음 ID).
// ops의 ACCEPTED 목록이 이 둘을 받고(같은 사건 키는 같은 건), 목록 밖 종류는 여전히 받지 않는지 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCsCaseStore, ReceiveCaseRequested, type CaseRequested, type CsCaseKind } from '../src/modules/cases/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-25T00:00:00.000Z');
let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

/** HTTP 본문(종류는 글 그대로 보낸다) */
const body = (kind: string, sourceId: string, eventKey: string) => ({ eventKey, kind, sourceId, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString() });
/** 유스케이스 입력(종류는 계약 목록 안의 이름) */
const requested = (kind: CsCaseKind, sourceId: string, eventKey: string): CaseRequested => ({ eventKey, kind, sourceId, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString() });
const answer = async (b: unknown): Promise<[number, { accepted: boolean; caseId?: string }]> => {
  const r = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });
  return [r.statusCode, JSON.parse(r.payload) as { accepted: boolean; caseId?: string }];
};

describe('J-T41 ② J-T20 ② 포트원 CS 건 종류', () => {
  test('J-T41 ② PORTONE_PAYOUT_EXECUTION(대상 = 묶음 ID)을 받아 건 하나를 열고, 같은 사건 키를 다시 보내도 같은 건이다', async () => {
    const batchId = randomUUID();
    const [status, first] = await answer(body('PORTONE_PAYOUT_EXECUTION', batchId, `portone-execution:${batchId}`));
    expect(status).toBe(202);
    expect(first).toEqual({ accepted: true, caseId: expect.any(String) });
    expect(await answer(body('PORTONE_PAYOUT_EXECUTION', batchId, `portone-execution:${batchId}`))).toEqual([202, { accepted: true, caseId: first.caseId }]);
    // 다른 묶음(다른 지급일)은 다른 건이다
    const otherBatch = randomUUID();
    const [, other] = await answer(body('PORTONE_PAYOUT_EXECUTION', otherBatch, `portone-execution:${otherBatch}`));
    expect(other.accepted).toBe(true);
    expect(other.caseId).not.toBe(first.caseId);
  });

  test('J-T20 ② PORTONE_LEDGER_MISMATCH를 이체·파트너·정산서·묶음 대상마다 받고, 같은 이체의 같은 사건 키는 건 하나다', async () => {
    const transferId = `tr-${randomUUID()}`;
    const [status, first] = await answer(body('PORTONE_LEDGER_MISMATCH', transferId, `portone-transfer:${transferId}`));
    expect(status).toBe(202);
    expect(first).toEqual({ accepted: true, caseId: expect.any(String) });
    expect(await answer(body('PORTONE_LEDGER_MISMATCH', transferId, `portone-transfer:${transferId}`))).toEqual([202, { accepted: true, caseId: first.caseId }]);
    const promoterId = randomUUID();
    const statementId = randomUUID();
    const batchId = randomUUID();
    for (const [sourceId, eventKey] of [
      [promoterId, `portone-account:${promoterId}:2026-11-25`],
      [statementId, `portone-settlement-amount:${statementId}`],
      [batchId, `portone-balance:${batchId}`],
    ] as const) {
      const [s, r] = await answer(body('PORTONE_LEDGER_MISMATCH', sourceId, eventKey));
      expect([s, r.accepted], eventKey).toEqual([202, true]);
      expect(r.caseId, eventKey).not.toBe(first.caseId);
    }
  });

  test('J-T41 ② J-T20 ② 두 종류는 대상 ID를 그대로 targetRef로 가진 열린 건이 된다', async () => {
    const store = new MemoryCsCaseStore();
    const receive = new ReceiveCaseRequested(store);
    const batchId = randomUUID();
    const transferId = `tr-${randomUUID()}`;
    const a = await receive.handle(requested('PORTONE_PAYOUT_EXECUTION', batchId, `portone-execution:${batchId}`), NOW);
    const b = await receive.handle(requested('PORTONE_LEDGER_MISMATCH', transferId, `portone-transfer:${transferId}`), NOW);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(a.case).toMatchObject({ kind: 'PORTONE_PAYOUT_EXECUTION', targetRef: batchId, status: 'OPEN' });
    expect(b.case).toMatchObject({ kind: 'PORTONE_LEDGER_MISMATCH', targetRef: transferId, status: 'OPEN' });
    expect(store.cases.size).toBe(2);
  });

  test('J-T41 ② J-T20 ② 목록 밖 종류(INQUIRY·CONTENT_REPORT·소문자·지어낸 이름)는 여전히 accepted: false이고 건이 없다', async () => {
    const store = new MemoryCsCaseStore();
    const receive = new ReceiveCaseRequested(store);
    for (const kind of ['INQUIRY', 'CONTENT_REPORT', 'portone_ledger_mismatch', 'PORTONE_PAYOUT', 'PORTONE_LEDGER']) {
      expect(await answer(body(kind, randomUUID(), randomUUID())), kind).toEqual([202, { accepted: false }]);
    }
    for (const kind of ['INQUIRY', 'CONTENT_REPORT'] as const) {
      const r = await receive.handle(requested(kind, randomUUID(), randomUUID()), NOW);
      expect(r.accepted, kind).toBe(false);
    }
    expect(store.cases.size).toBe(0);
  });
});
