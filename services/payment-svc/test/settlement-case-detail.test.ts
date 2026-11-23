// CS 건 본문 선택 칸 detail(F-07-7 계획 §5.1 (타) 결정 2, ADR-0370 결정 7·8).
// HttpSettlementCaseNotice.openCase는 detail을 줄 때만 ops POST /internal/v1/cs-cases 본문에 detail 칸을 싣는다.
// detail이 없을 때의 본문은 고정된 F-07-6 시험(settlement-toss-execute.test.ts J-T38 ⑥)이 toEqual로 본다. 여기서는 그 모양에 detail 한 칸만 더해지는지 본다.
// ops 쪽 받기(1~2,000자, 어긋나면 202 accepted:false, 같은 사건 키는 글 그대로)는 services/ops-svc/test/cs-case-detail.test.ts가 본다.
// buildCaseDetail(계획 §5.1 (파) (나))의 경계: 뺀 정산서 0·1건, 꼬리 없이 딱 2,000자, 넘을 한 건에서 꼬리로 바뀜(실은 수 + M = 총수), 정산서 ID 오름차순.
import { describe, expect, test } from 'vitest';
import { HttpSettlementCaseNotice } from '../src/modules/settlement/index.js';
import { buildCaseDetail } from '../src/modules/settlement/domain/case-detail.js';

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

/** 코드 포인트 길이(정본 (나) '2,000자(코드 포인트)') */
const cp = (t: string): number => [...t].length;
const TAIL = /^(.*) 외 (\d+)건\(전체는 SCR-049 묶음 상세\)$/su;
const id = (n: number, pad = 0): string => `s-${String(n).padStart(3, '0')}${'x'.repeat(pad)}`;

describe('J-T41 ② buildCaseDetail 경계(계획 §5.1 (파) (나), TR-09)', () => {
  test('J-T41 ② 뺀 정산서 1건은 앞머리 `뺀 정산서 1건: `와 `{ID}({사유})` 하나이고 꼬리가 없다', () => {
    const out = buildCaseDetail({ excluded: [{ statementId: 's-001', reason: 'ACCOUNT_CHANGE' }], flags: [] });
    expect(out).toBe('뺀 정산서 1건: s-001(ACCOUNT_CHANGE)');
  });

  test('J-T41 ② 뺀 정산서 0건이고 표시만 있으면 표시 글만 싣고 정산서 목록·꼬리가 없다', () => {
    const out = buildCaseDetail({ excluded: [], flags: ['commander 확인 필요'] });
    expect(out).toContain('commander 확인 필요');
    expect(out).not.toContain('(');
    expect(out).not.toMatch(TAIL);
    expect(cp(out)).toBeGreaterThanOrEqual(1);
  });

  test('J-T41 ② 표시 글(commander 확인 필요·실행 멈춤·이체 ID)을 먼저 싣고, 뺀 정산서는 정산서 ID 오름차순이다', () => {
    const out = buildCaseDetail({
      excluded: [
        { statementId: 's-030', reason: 'SALE_SUSPENDED' },
        { statementId: 's-010', reason: 'ACCOUNT_CHANGE' },
        { statementId: 's-020', reason: 'ACCOUNT_MISMATCH' },
      ],
      flags: ['실행 멈춤', 'commander 확인 필요'],
      transferIds: ['at-rogue-9'],
    });
    const list = out.indexOf('뺀 정산서 3건: ');
    expect(list).toBeGreaterThan(0);
    for (const flag of ['실행 멈춤', 'commander 확인 필요', 'at-rogue-9']) {
      expect(out.indexOf(flag)).toBeGreaterThanOrEqual(0);
      expect(out.indexOf(flag)).toBeLessThan(list);
    }
    expect(out.slice(list)).toBe('뺀 정산서 3건: s-010(ACCOUNT_CHANGE), s-020(ACCOUNT_MISMATCH), s-030(SALE_SUSPENDED)');
  });

  test('J-T41 ② 전체가 딱 2,000자(코드 포인트)면 꼬리 없이 다 싣고, 한 건을 더하면 꼬리로 바뀌며 실은 수 + M = 총수, 결과는 2,000자 이하다', () => {
    // 앞머리 '뺀 정산서 40건: '와 '{ID}(BALANCE)' 40개를 ', '로 이은 길이를 맞춰 마지막 ID를 늘려 딱 2,000자로 만든다
    const reason = 'BALANCE';
    const base = Array.from({ length: 40 }, (_v, i) => ({ statementId: id(i + 1), reason }));
    const lengthOf = (items: readonly { statementId: string; reason: string }[]) => cp(`뺀 정산서 ${items.length}건: `) + items.map((x) => cp(`${x.statementId}(${x.reason})`)).reduce((a, b) => a + b, 0) + 2 * (items.length - 1);
    const pad = 2_000 - lengthOf(base);
    expect(pad).toBeGreaterThan(0);
    const exact = [...base.slice(0, 39), { statementId: id(40, pad), reason }];
    expect(lengthOf(exact)).toBe(2_000);
    const full = buildCaseDetail({ excluded: [...exact].reverse(), flags: [] });
    expect(cp(full)).toBe(2_000);
    expect(full).not.toMatch(TAIL);
    expect(full).toBe(`뺀 정산서 40건: ${exact.map((x) => `${x.statementId}(${x.reason})`).join(', ')}`);

    const over = [...exact, { statementId: id(41), reason }];
    const cut = buildCaseDetail({ excluded: over, flags: [] });
    expect(cp(cut)).toBeLessThanOrEqual(2_000);
    const m = TAIL.exec(cut);
    expect(m).not.toBeNull();
    expect(cut.startsWith('뺀 정산서 41건: ')).toBe(true);
    const shown = m![1]!.slice('뺀 정산서 41건: '.length).split(', ');
    expect(shown.length + Number(m![2])).toBe(41);
    // 실은 것은 오름차순 앞쪽 그대로다
    expect(shown).toEqual(over.slice(0, shown.length).map((x) => `${x.statementId}(${x.reason})`));
  });
});
