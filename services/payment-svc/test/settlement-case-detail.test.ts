// CS 건 본문 선택 칸 detail(F-07-7 계획 §5.1 (타) 결정 2, ADR-0370 결정 7·8).
// HttpSettlementCaseNotice.openCase는 detail을 줄 때만 ops POST /internal/v1/cs-cases 본문에 detail 칸을 싣는다.
// detail이 없을 때의 본문은 고정된 F-07-6 시험(settlement-toss-execute.test.ts J-T38 ⑥)이 toEqual로 본다. 여기서는 그 모양에 detail 한 칸만 더해지는지 본다.
// ops 쪽 받기(1~2,000자, 같은 사건 키는 글 그대로)는 services/ops-svc/test/cs-case-detail.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { HttpSettlementCaseNotice } from '../src/modules/settlement/index.js';

const CREATED = new Date('2026-12-02T00:00:00.000Z');

function recording() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const notice = new HttpSettlementCaseNotice('http://ops-svc:8080', 'internal-token', async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ accepted: true, caseId: '00000000-0000-4000-8000-000000000001' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  return { calls, notice };
}

describe('J-T41 ② CS 건 본문 detail', () => {
  test('J-T41 ② openCase에 detail을 주면 본문에 그 글이 그대로 detail 칸으로 실리고 나머지 칸은 detail 없는 본문과 같다', async () => {
    const { calls, notice } = recording();
    const detail = '뺀 정산서: 0193a7c2-0000-7000-8000-00000000000a(ACCOUNT_CHANGE), 0193a7c2-0000-7000-8000-00000000000b(SALE_SUSPENDED)';
    await notice.openCase({ eventKey: 'portone-execution:b-1', kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: 'b-1', createdAt: CREATED, detail });
    await notice.openCase({ eventKey: 'portone-execution:b-2', kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: 'b-2', createdAt: CREATED });
    expect(calls.map((c) => c.url)).toEqual(['http://ops-svc:8080/internal/v1/cs-cases', 'http://ops-svc:8080/internal/v1/cs-cases']);
    expect(calls[0]!.body).toEqual({ eventKey: 'portone-execution:b-1', kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: 'b-1', category: 'SETTLEMENT', createdAt: CREATED.toISOString(), detail });
    // detail이 없으면 칸 자체가 없다(빈 글·null을 싣지 않는다)
    expect(calls[1]!.body).toEqual({ eventKey: 'portone-execution:b-2', kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: 'b-2', category: 'SETTLEMENT', createdAt: CREATED.toISOString() });
    expect(Object.keys(calls[1]!.body)).not.toContain('detail');
  });

  test('J-T41 ② 2,000자 detail은 자르지 않고 그대로 싣는다(ops 상한과 같은 경계)', async () => {
    const { calls, notice } = recording();
    const detail = `commander 확인 필요 ${'가'.repeat(2_000 - 'commander 확인 필요 '.length)}`;
    expect(detail.length).toBe(2_000);
    await notice.openCase({ eventKey: 'k-2000', kind: 'PORTONE_LEDGER_MISMATCH', sourceId: 't-1', createdAt: CREATED, detail });
    expect(calls[0]!.body.detail).toBe(detail);
  });
});
