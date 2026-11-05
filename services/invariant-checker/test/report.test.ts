// 결과 파일(invariants.csv·invariants-detail.ndjson)과 종료 코드(docs/verification.md §2.5, docs/perf-ledger.md, [ASVS v5.0.0-14.2.4]).
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { DETAIL_LIMIT, exitCode, kstIso, toCsv, toDetailNdjson, type InvariantResult } from '../src/report.js';

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
