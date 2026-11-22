// J-T35 ③ CS 처리함 '정산 이의' 건(ops 쪽, F-07-5 LCH-100, ADR-0368 결정 5, docs/features/settlement.md §4.2 '이의 받기').
// payment-svc가 이의를 받은 뒤 POST /internal/v1/cs-cases로 STATEMENT_DISPUTE(sourceId = 정산서 ID, eventKey = 이의 ID)를 보낸다.
// ops는 같은 종류·같은 정산서의 열린 건을 하나로 모은다: 같은 이의를 다시 보내도, 같은 정산서의 새 이의가 와도 건은 하나다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-18T02:00:00.000Z');
let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

/** payment-svc HttpSettlementCaseNotice가 보내는 본문 모양(정본 §4.2: 종류·대상 정산서·이의 ID) */
const body = (statementId: string, disputeId: string) => ({ eventKey: disputeId, kind: 'STATEMENT_DISPUTE', sourceId: statementId, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString() });
const post = (b: unknown) => svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });

describe('J-T35 ③ 정산 이의 건', () => {
  test('J-T35 ③ STATEMENT_DISPUTE를 받아 건 하나를 열고, 같은 이의를 두 번 보내도 같은 건이다', async () => {
    const statementId = randomUUID();
    const disputeId = randomUUID();
    const a = await post(body(statementId, disputeId));
    expect(a.statusCode).toBe(202);
    const first = JSON.parse(a.payload) as { accepted: boolean; caseId?: string };
    expect(first).toEqual({ accepted: true, caseId: expect.any(String) });
    const again = await post(body(statementId, disputeId));
    expect([again.statusCode, JSON.parse(again.payload)]).toEqual([202, { accepted: true, caseId: first.caseId }]);
    // 같은 정산서의 다음 이의(다시 알린 뒤)도 열린 건에 모인다
    expect(JSON.parse((await post(body(statementId, randomUUID()))).payload)).toEqual({ accepted: true, caseId: first.caseId });
    // 다른 정산서는 다른 건이다
    const other = JSON.parse((await post(body(randomUUID(), randomUUID()))).payload) as { caseId: string };
    expect(other.caseId).not.toBe(first.caseId);
  });

  test('J-T35 ③ 건은 대상이 정산서 ID인 STATEMENT_DISPUTE 종류로 열린다', async () => {
    const store = new MemoryCsCaseStore();
    const statementId = randomUUID();
    const r = await new ReceiveCaseRequested(store).handle({ ...body(statementId, randomUUID()), kind: 'STATEMENT_DISPUTE' }, NOW);
    expect(r.accepted).toBe(true);
    expect(r.case).toMatchObject({ kind: 'STATEMENT_DISPUTE', targetRef: statementId, status: 'OPEN' });
    expect(store.cases.size).toBe(1);
  });
});
