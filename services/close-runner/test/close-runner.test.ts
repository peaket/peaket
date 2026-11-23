// close-runner 단위 시험(F-04-6 빠른 길). 실제 ClickHouse·dbt를 쓰는 끝까지 시험은 data/tests_int/test_close_runner.py다.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reconcile } from '../src/accuracy.js';
import { ClickHouseError, type ClickHouse } from '../src/clickhouse.js';
import { checkVars, type DbtExec, factsArgs, metricsArgs, swapArgs } from '../src/dbt.js';
import { loadIntakeDir, REF_MAX_BYTES } from '../src/intake.js';
import { runTask } from '../src/runner.js';
import { nextBusinessDay10Kst, parseHolidayCalendar, planTasks, stageTimes } from '../src/schedule.js';

const E = '0b5e2f3c-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
const R = '1c6f3a4d-2e3f-4a5b-9c7d-8e9f0a1b2c3d';
const kst = (s: string) => new Date(`${s}+09:00`);

describe('마감 단계 예정 시각(analytics §4.2)', () => {
  it('OPS-240 ① R0는 오픈 + 90분, R1은 오픈 다음 영업일 10시, R2는 오픈 + 7일, R3는 공연 다음 영업일 10시다', () => {
    // 금요일 11시 오픈, 공연은 120일 뒤(화요일)
    const t = stageTimes({ eventId: E, openAt: kst('2026-03-06T11:00:00'), startsAt: kst('2026-07-04T19:00:00') }, new Set());
    expect(t.R0.toISOString()).toBe(kst('2026-03-06T12:30:00').toISOString());
    expect(t.R1.toISOString()).toBe(kst('2026-03-09T10:00:00').toISOString());
    expect(t.R2.toISOString()).toBe(kst('2026-03-13T11:00:00').toISOString());
    // 7월 4일은 토요일 → 다음 영업일 월요일 7월 6일 10시
    expect(t.R3.toISOString()).toBe(kst('2026-07-06T10:00:00').toISOString());
  });

  it('OPS-240 ② 공휴일 파일의 날은 영업일에서 빠진다(payment·settlement와 같은 달력 꼴)', () => {
    const holidays = parseHolidayCalendar('{ "holidays": ["2026-03-09"] }');
    expect(nextBusinessDay10Kst(kst('2026-03-06T11:00:00'), holidays).toISOString()).toBe(kst('2026-03-10T10:00:00').toISOString());
    expect(() => parseHolidayCalendar('["2026-3-9"]')).toThrow();
  });

  it('OPS-240 ③ 할 일: 예정이 지난 가장 높은 단계가 완료보다 높으면 그 단계, R2 뒤 R3 전이면 하루 한 번 매일 쌓기, 오래된 예정부터', () => {
    const a = { eventId: 'a', openAt: kst('2026-03-06T11:00:00'), startsAt: kst('2026-07-04T19:00:00') };
    const b = { eventId: 'b', openAt: kst('2026-03-02T11:00:00'), startsAt: kst('2026-03-05T19:00:00') };
    const now = kst('2026-03-20T09:00:00');
    const tasks = planTasks([a, b], new Map([['a', { completed: 'R1', lastDaily: null }]]), now, new Set());
    // b는 공연이 오픈 뒤 7일 안이라 R3가 R2보다 먼저 지나 R3, a는 R2
    expect(tasks.map((t) => [t.eventId, t.stage, t.kind])).toEqual([['b', 'R3', 'STAGE'], ['a', 'R2', 'STAGE']]);
    const daily = planTasks([a], new Map([['a', { completed: 'R2', lastDaily: '2026-03-19' }]]), now, new Set());
    expect(daily.map((t) => [t.stage, t.kind])).toEqual([['R2', 'DAILY']]);
    expect(planTasks([a], new Map([['a', { completed: 'R2', lastDaily: '2026-03-20' }]]), now, new Set())).toEqual([]);
    expect(planTasks([a], new Map([['a', { completed: 'R3', lastDaily: null }]]), kst('2026-07-07T09:00:00'), new Set())).toEqual([]);
  });
});

describe('dbt 부르기(ASVS 1.2.5)', () => {
  it('ASVS 1.2.5 ① 고정 인자 목록이고 회차·판 ID는 소문자 UUID, 단계는 R0~R3, 품질 지표 코드는 소문자·숫자·밑줄만', () => {
    expect(factsArgs({ event_id: E, run_id: R, stage: 'R1' }).slice(0, 3)).toEqual(['build', '--exclude', 'path:models/metrics']);
    expect(metricsArgs({ event_id: E, run_id: R, stage: 'R3', quality_failed: ['sales_amount'] }).slice(0, 3)).toEqual(['build', '--select', 'path:models/metrics']);
    expect(swapArgs(E, R)[0]).toBe('run-operation');
    expect(() => checkVars({ event_id: `${E}'; DROP TABLE x`, run_id: R, stage: 'R1' })).toThrow();
    expect(() => checkVars({ event_id: E, run_id: R, stage: 'R9' as 'R1' })).toThrow();
    expect(() => checkVars({ event_id: E, run_id: R, stage: 'R3', quality_failed: ['a b'] })).toThrow();
    expect(() => checkVars({ event_id: E, run_id: R, stage: 'R3', carry_run: R })).toThrow();
    expect(() => checkVars({ event_id: E, run_id: R, stage: 'R3', holidays: ['2026-3-1'] })).toThrow();
    expect(factsArgs({ event_id: E, run_id: R, stage: 'R1', holidays: ['2026-03-10'] }).at(-1)).toContain('"holidays":["2026-03-10"]');
  });
});

describe('R3 정산 대조(analytics §7 정확성(돈))', () => {
  it('A-T9 ① 결제사별 판매 대금과 환급 합이 정산서와 같으면 실패 없음', () => {
    expect(reconcile(new Map([['TOSS', 300_000], ['PORTONE', 100_000]]), 50_000, [{ pg: 'TOSS', sales: 300_000, refund: 50_000 }, { pg: 'PORTONE', sales: 100_000, refund: 0 }])).toEqual({ failed: [], detail: '정산서와 0원 차이' });
  });

  it('A-T9 ② 1원 차이면 판매 금액 판정을 보류하고, 환급이 다르면 환불도, 정산서가 없으면 둘 다', () => {
    const r = reconcile(new Map([['TOSS', 300_001]]), 0, [{ pg: 'TOSS', sales: 300_000, refund: 0 }]);
    expect(r.failed).toEqual(['sales_amount']);
    expect(r.detail).toContain('300001');
    expect(reconcile(new Map([['TOSS', 1]]), 10, [{ pg: 'TOSS', sales: 1, refund: 0 }]).failed).toEqual(['refunds']);
    expect(reconcile(new Map(), 0, []).failed).toEqual(['sales_amount', 'refunds']);
  });
});

/** 질의를 기록하고 정해 둔 답을 주는 가짜 ClickHouse */
function fakeCh(answer: (sql: string) => unknown[] = () => []) {
  const inserts: { table: string; body: string; settings?: Record<string, string | number> }[] = [];
  const queries: string[] = [];
  const ch: ClickHouse = {
    async query<T>(sql: string) {
      queries.push(sql);
      return answer(sql) as T[];
    },
    async command(sql: string) {
      queries.push(sql);
    },
    async insertJsonEachRow(table, body, settings) {
      if (table === 'bronze.brz_ref_event' && body.includes('"bad"')) throw new ClickHouseError(500, 117, 'Code: 117. DB::Exception: Unknown field');
      inserts.push({ table, body, ...(settings ? { settings } : {}) });
      return body.trim().split('\n').length;
    },
  };
  return { ch, inserts, queries };
}

describe('한 회차 처리(analytics §4.1·§4.2)', () => {
  const task = { eventId: E, stage: 'R3' as const, kind: 'STAGE' as const, due: new Date() };
  it('A-T7 ① dbt가 실패하면 판을 바꾸지 않고(바꾸기 호출 없음) 실행 기록에 FAILED를 남긴다', async () => {
    const { ch, inserts } = fakeCh();
    const calls: string[][] = [];
    const dbt: DbtExec = async (args) => {
      calls.push([...args]);
      return { code: 1, tail: 'Database Error in model fct_sales_daily', timedOut: false };
    };
    const out = await runTask({ ch, dbt, now: () => new Date('2026-07-06T01:05:00Z'), newRunId: () => R, holidays: new Set(), log: () => {} }, task, null, null);
    expect(out.result).toBe('FAILED');
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c[0] === 'run-operation')).toBe(false);
    expect(JSON.parse(inserts.find((i) => i.table === 'gold.close_run_log')!.body)).toMatchObject({ event_id: E, run_id: R, stage: 'R3', result: 'FAILED' });
  });

  it('A-T9 ③ R3는 사실 빌드 뒤 정산 대조를 하고 어긋난 지표 코드를 지표 빌드의 quality_failed로 넘긴 뒤 판을 바꾼다, R2 판이 있으면 온세일을 옮기고 앞 판에서 80일 앞의 날을 잇는다', async () => {
    const { ch } = fakeCh((sql) => {
      if (sql.includes('FROM gold.fct_sales_daily')) return [{ pg: 'TOSS', amount: '300001' }];
      if (sql.includes('FROM gold.fct_refund_daily')) return [{ amount: '0' }];
      if (sql.includes('stg_settlement_event')) return [{ pg: 'TOSS', sales: '300000', refund: '0' }];
      return [];
    });
    const calls: string[][] = [];
    const dbt: DbtExec = async (args) => {
      calls.push([...args]);
      return { code: 0, tail: '', timedOut: false };
    };
    const carry = '2d7a4b5e-3f4a-4b6c-8d8e-9f0a1b2c3d4e';
    const r2 = '3e8b5c6f-4a5b-4c7d-9e9f-0a1b2c3d4e5f';
    const out = await runTask({ ch, dbt, now: () => new Date('2026-07-06T01:05:00Z'), newRunId: () => R, holidays: new Set(), log: () => {} }, task, carry, r2);
    expect(out).toMatchObject({ result: 'DONE', qualityFailed: ['sales_amount'] });
    expect(calls.map((c) => c[0])).toEqual(['build', 'build', 'run-operation']);
    const facts = JSON.parse(calls[0]!.at(-1)!);
    expect(facts).toMatchObject({ event_id: E, run_id: R, stage: 'R3', onsale_run: r2, carry_run: carry, carry_before: '2026-04-17' });
    expect(JSON.parse(calls[1]!.at(-1)!).quality_failed).toEqual(['sales_amount']);
  });
});

describe('회차 기준 자료 파일 싣기(analytics §3.2)', () => {
  it('ASVS 5.2.1 ① 크기 상한·확장자를 넘기면 싣지 않고, 맞지 않는 줄이 있으면 파일 전체를 거절하며, 실은 파일은 다시 싣지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intake-'));
    mkdirSync(join(dir, 'ref-event'));
    writeFileSync(join(dir, 'ref-event', 'a.json'), '{"event_id":"e1","open_at":"2026-03-06T02:00:00Z"}\n');
    writeFileSync(join(dir, 'ref-event', 'b.json'), '{"event_id":"e2","bad":1}\n');
    writeFileSync(join(dir, 'ref-event', 'c.csv'), 'x');
    const seen = new Set<string>();
    const { ch, inserts } = fakeCh((sql) => (sql.includes('brz_intake_log') && seen.size > 0 ? [{ n: '1' }] : [{ n: '0' }]));
    const first = await loadIntakeDir(ch, dir);
    expect(first.map((o) => [o.path, o.result, o.reason])).toEqual([
      ['ref-event/a.json', 'LOADED', ''],
      ['ref-event/b.json', 'REJECTED', 'CLICKHOUSE_117'],
      ['ref-event/c.csv', 'REJECTED', 'EXTENSION'],
    ]);
    expect(inserts.find((i) => i.table === 'bronze.brz_ref_event')!.settings).toMatchObject({ input_format_skip_unknown_fields: 0 });
    seen.add('a');
    const again = await loadIntakeDir(ch, dir);
    expect(again[0]).toMatchObject({ path: 'ref-event/a.json', result: 'SKIPPED' });
    expect(REF_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
