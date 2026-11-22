// 결과 파일(invariants.csv·invariants-detail.ndjson)과 종료 코드(docs/verification.md §2.5, docs/perf-ledger.md, [ASVS v5.0.0-14.2.4]).
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { DETAIL_LIMIT, exitCode, kstIso, skipWarnings, summaryLine, toCsv, toDetailNdjson, type InvariantResult } from '../src/report.js';

const r = (o: Partial<InvariantResult>): InvariantResult => ({ id: 'S1', name: '오버셀(좌석 판매)', sources: ['purchase'], violations: 0, unknown: 0, result: 'PASS', details: [], ...o });
const AS_OF = Date.parse('2026-11-02T01:00:00.000Z');

describe('invariants.csv', () => {
  it('건수만 쓰고 시각 기준은 KST다', () => {
    const csv = toCsv([r({}), r({ id: 'Q1', name: '차례 전 입장', sources: ['records'], violations: 2, unknown: 1, result: 'FAIL', details: [{ subject: 'x', detail: 'y' }] }), r({ id: 'S3', sources: ['ticket'], result: 'SKIPPED', reason: '원본 없음: ticket' })], AS_OF);
    expect(csv.split('\n')).toEqual([
      'id,name,sources,violations,unknown,result,as_of',
      'S1,오버셀(좌석 판매),purchase,0,0,PASS,2026-11-02T10:00:00.000+09:00',
      'Q1,차례 전 입장,records,2,1,FAIL,2026-11-02T10:00:00.000+09:00',
      'S3,오버셀(좌석 판매),ticket,,,SKIPPED,2026-11-02T10:00:00.000+09:00',
      '',
    ]);
    expect(csv).not.toContain('x');
  });

  it('쉼표·따옴표가 든 칸은 RFC 4180대로 감싼다', () => {
    expect(toCsv([r({ name: '정산: 한 환급, "두" 정산서' })], AS_OF).split('\n')[1]).toBe('S1,"정산: 한 환급, ""두"" 정산서",purchase,0,0,PASS,2026-11-02T10:00:00.000+09:00');
  });

  it('kstIso', () => {
    expect(kstIso(Date.parse('2026-12-31T15:30:00.250Z'))).toBe('2027-01-01T00:30:00.250+09:00');
  });
});

describe('invariants-detail.ndjson', () => {
  it('위반 행을 불변식 ID와 함께 쓰고 잘린 수를 적는다', () => {
    const details = Array.from({ length: DETAIL_LIMIT }, (_, i) => ({ subject: `s${i}`, detail: 'd' }));
    const lines = toDetailNdjson([r({ violations: DETAIL_LIMIT + 5, result: 'FAIL', details }), r({ id: 'S2' })]).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(DETAIL_LIMIT + 1);
    expect(lines[0]).toEqual({ id: 'S1', subject: 's0', detail: 'd' });
    expect(lines.at(-1)).toEqual({ id: 'S1', truncated: 5 });
  });
});

describe('종료 코드', () => {
  it('하나라도 FAIL이면 1, 아니면 0', () => {
    expect(exitCode([r({}), r({ result: 'SKIPPED' })])).toBe(0);
    expect(exitCode([r({}), r({ result: 'FAIL', violations: 1 })])).toBe(1);
  });
});

// docs/verification.md §2.5 '건너뜀(SKIPPED)을 드러내기' ①②(FIX-invariant-m3). 줄 꼴은 계획 docs/review/plans/FIX-invariant-m3.md '공개 인터페이스'다
describe('SKIPPED 요약 줄과 경고', () => {
  const skipped = (id: string, sources: string[], reason: string, skip: NonNullable<InvariantResult['skip']>) => r({ id, sources, result: 'SKIPPED', reason, skip });
  // 일부러 불변식 목록(INVARIANTS) 차례가 아니게 섞는다: M3·P5·Q1 차례로 넣어도 Q1·P5·M3 차례로 적어야 한다
  const mixed = [
    skipped('M3', ['payment'], '원본에 표 없음: receivable_movement', { kind: 'table', names: ['receivable_movement'] }),
    r({ id: 'S1' }),
    skipped('P5', ['payment', 'purchase', 'ticket'], '원본 없음: ticket', { kind: 'source', names: ['ticket'] }),
    r({ id: 'M1', sources: ['payment'], result: 'FAIL', violations: 2 }),
    skipped('Q1', ['records'], '시험 기록 없음', { kind: 'records', names: [] }),
    skipped('M1', ['payment'], '원본에 표 없음: settlement_statement, payout', { kind: 'table', names: ['settlement_statement', 'payout'] }),
    r({ id: 'P1', sources: ['payment'] }),
  ];

  it('J-T24 ④ M3 요약 줄은 PASS·FAIL·SKIPPED 개수와 SKIPPED 불변식·까닭을 불변식 목록 차례로 적는다', () => {
    expect(summaryLine(mixed)).toBe('요약: PASS 2 · FAIL 1 · SKIPPED 4 — Q1(시험 기록 없음), P5(원본 없음: ticket), M1(원본에 표 없음: settlement_statement, payout), M3(원본에 표 없음: receivable_movement)');
  });

  it('J-T24 ④ M3 SKIPPED가 없으면 요약 줄 끝이 SKIPPED 없음이다', () => {
    expect(summaryLine([r({}), r({ id: 'M3', sources: ['payment'] }), r({ id: 'P1', result: 'FAIL', violations: 1 })])).toBe('요약: PASS 2 · FAIL 1 · SKIPPED 0 — SKIPPED 없음');
  });

  it('J-T24 ④ M3 경고는 붙은 원본에 표가 없어 건너뛴 것(table)만 불변식 목록 차례로 한 줄씩 내고, 원본·기록이 없어 건너뛴 것은 내지 않는다', () => {
    expect(skipWarnings(mixed)).toEqual([
      '경고: M1 원본(payment)에 붙었는데 표가 없다: settlement_statement, payout — 기능이 아직 없거나 표 이름이 docs/data.md와 다르다',
      '경고: M3 원본(payment)에 붙었는데 표가 없다: receivable_movement — 기능이 아직 없거나 표 이름이 docs/data.md와 다르다',
    ]);
    expect(skipWarnings(mixed.filter((x) => x.skip?.kind !== 'table'))).toEqual([]);
    // 경고가 있어도 끝 코드는 FAIL만 본다(SKIPPED는 끝 코드를 바꾸지 않는다)
    expect(exitCode(mixed.filter((x) => x.result !== 'FAIL'))).toBe(0);
  });
});

describe('명령줄([ASVS v5.0.0-13.3.1])', () => {
  const env = { INVARIANT_CHECK_DB_URL: 'postgres://c', INVARIANT_PURCHASE_DB_URL: 'postgres://p' };

  it('DB 주소는 환경 값으로만 받는다', () => {
    expect(parseCliArgs(['--out', 'runs/x', '--records', 'rec.ndjson'], env)).toEqual({
      out: 'runs/x',
      records: 'rec.ndjson',
      checkUrl: 'postgres://c',
      sources: { purchase: 'postgres://p' },
      enqueueWithinMs: 60_000,
      issueDeadlineMs: 30 * 60_000,
    });
    expect(parseCliArgs(['--out', 'o', '--enqueue-within-sec', '90', '--issue-deadline-min', '20'], env)).toMatchObject({ enqueueWithinMs: 90_000, issueDeadlineMs: 20 * 60_000 });
  });

  it('검사 DB 주소·출력 폴더가 없거나 모르는 인자·명령줄 DB 주소는 거절한다', () => {
    expect(() => parseCliArgs(['--out', 'o'], {})).toThrow(/INVARIANT_CHECK_DB_URL/);
    expect(() => parseCliArgs([], env)).toThrow(/--out/);
    expect(() => parseCliArgs(['--out', 'o', '--db', 'postgres://x'], env)).toThrow(/--db/);
    expect(() => parseCliArgs(['--out', 'o', '--enqueue-within-sec', '0'], env)).toThrow(/enqueue/);
  });
});
