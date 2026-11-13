// support.cases-requested의 REFUND_FAILED를 CS 처리함 건으로 여는 계약(GAT-110 첫 몫).
import { describe, expect, test } from 'vitest';
import { MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';

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
});
