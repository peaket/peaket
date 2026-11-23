// J-T23 ③ ops-svc가 대사 풀린 결제의 조정 제안 CS 건(SETTLEMENT_ADJUSTMENT_SUGGESTED)을 받는다(F-07-8 계획 I-05, ADR-0380 결정 7, 시험 리뷰 TR-11).
// payment-svc가 settlement_case_request에 적어 POST /internal/v1/cs-cases로 보내는 모양(eventKey·kind·sourceId = 대상 정산서 ID·category SETTLEMENT·createdAt)을 그대로 쓴다.
// 받는 목록에 없으면 202 accepted:false 거절이 쌓여 payment 쪽이 영구 실패로 남긴다(F-07-7 계획 §5.1 (파) 마). 같은 사건 키는 같은 건이다.
// 기준 트리: 받는 목록(receive-case-requested.ts ACCEPTED)에 그 종류가 없어 실패한다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T01:30:00.000Z');

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

const body = (statementId: string, paymentId: string) => ({
  eventKey: `reconciliation-resolved:${statementId}:${paymentId}`,
  kind: 'SETTLEMENT_ADJUSTMENT_SUGGESTED' as const,
  sourceId: statementId,
  category: 'SETTLEMENT' as const,
  createdAt: new Date(NOW).toISOString(),
});
const post = (b: unknown) => svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });

describe('J-T23 ③ 조정 제안 CS 건 받기', () => {
  test('J-T23 ③ SETTLEMENT_ADJUSTMENT_SUGGESTED는 202·accepted true로 건을 열고 같은 사건 키를 다시 보내면 같은 건이다', async () => {
    const statementId = randomUUID();
    const paymentId = randomUUID();
    const first = await post(body(statementId, paymentId));
    expect([first.statusCode, JSON.parse(first.payload)]).toEqual([202, { accepted: true, caseId: expect.any(String) }]);
    const again = await post(body(statementId, paymentId));
    expect(JSON.parse(again.payload)).toEqual({ accepted: true, caseId: (JSON.parse(first.payload) as { caseId: string }).caseId });
    // 같은 정산서의 다른 결제는 다른 건이다
    const other = await post(body(statementId, randomUUID()));
    expect(JSON.parse(other.payload).caseId).not.toBe((JSON.parse(first.payload) as { caseId: string }).caseId);
  });

  test('J-T23 ③ 건은 OPEN이고 대상은 그 정산서 ID다', async () => {
    const store = new MemoryCsCaseStore();
    const receive = new ReceiveCaseRequested(store);
    const statementId = randomUUID();
    const r = await receive.handle(body(statementId, randomUUID()), NOW);
    expect([r.accepted, r.result]).toEqual([true, 'opened']);
    expect(r.case).toMatchObject({ kind: 'SETTLEMENT_ADJUSTMENT_SUGGESTED', targetRef: statementId, status: 'OPEN' });
    expect(store.cases.size).toBe(1);
  });
});
