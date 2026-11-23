// 마감 실행기 한 바퀴(docs/features/analytics.md §4.1~§4.3, OPS-240, F-04-6). CronJob이 10분마다 [가정] `run-once`로 부른다.
// 할 일(단계 마감·매일 쌓기)을 오래된 예정부터 한 회차씩 처리한다:
//   ① 사실·차원 빌드(R2 뒤에는 온세일 사실을 R2 판에서, 오래된 날의 F15·F8과 사라진 기준 자료 차원은 앞 현재 판에서 옮긴다)
//   ② R3이면 정산 대조 → 어긋난 지표 코드를 quality_failed로 ③ 지표·판정 빌드 ④ 모두 통과하면 현재 판 바꾸기.
// 어느 단계든 실패하면 판을 바꾸지 않는다(직전 판 리포트가 그대로, '마감 지연'). 실행마다 gold.close_run_log에 한 줄을 남긴다.
import { reconcileRun } from './accuracy.js';
import { ClickHouseError, type ClickHouse } from './clickhouse.js';
import { type DbtExec, type DbtVars, factsArgs, metricsArgs, swapArgs } from './dbt.js';
import { type EventRef, type EventState, kstDateKey, planTasks, type Stage, STAGES, type Task } from './schedule.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 앞 판에서 옮길 날의 기준: 실버 보관 90일보다 앞선 80일 [가정] */
export const CARRY_DAYS = 80;
/** 회차당 실행 시간 상한 20분 [가정](analytics §4.1 '동시 실행') */
export const RUN_TIMEOUT_MS = 20 * 60 * 1_000;

export interface RunnerDeps {
  ch: ClickHouse;
  dbt: DbtExec;
  now: () => Date;
  newRunId: () => string;
  holidays: ReadonlySet<string>;
  log: (event: Record<string, unknown>) => void;
  timeoutMs?: number;
}

export interface TaskOutcome {
  task: Task;
  runId: string;
  result: 'DONE' | 'FAILED' | 'TIMEOUT';
  qualityFailed: string[];
  detail: string;
}

const isUnknownTable = (e: unknown) => e instanceof ClickHouseError && (e.code === 60 || e.code === 81);

async function tryQuery<T>(ch: ClickHouse, sql: string, params: Record<string, string>, fallback: T[]): Promise<T[]> {
  try {
    return await ch.query<T>(sql, params);
  } catch (e) {
    if (isUnknownTable(e)) return fallback;
    throw e;
  }
}

/** 회차 기준 자료: 브론즈(90일 보관)와 골드 현재 판 dim_event를 합쳐 가장 늦게 실린 값 */
export async function readRefs(ch: ClickHouse): Promise<EventRef[]> {
  const bronze = 'SELECT event_id, open_at, starts_at, loaded_at AS at FROM bronze.brz_ref_event';
  const gold =
    'SELECT event_id, open_at, starts_at, built_at AS at FROM gold.dim_event WHERE (event_id, run_id) IN (SELECT event_id, argMax(run_id, switched_at) FROM gold.current_run GROUP BY event_id)';
  const pick = (from: string) =>
    `SELECT event_id, toUnixTimestamp64Milli(argMax(open_at, at)) AS open_ms, toUnixTimestamp64Milli(argMax(starts_at, at)) AS starts_ms FROM (${from}) GROUP BY event_id`;
  let rows: { event_id: string; open_ms: string; starts_ms: string }[];
  try {
    rows = await ch.query(pick(`${bronze} UNION ALL ${gold}`));
  } catch (e) {
    if (!isUnknownTable(e)) throw e;
    rows = await ch.query(pick(bronze));
  }
  return rows.map((r) => ({ eventId: r.event_id, openAt: new Date(Number(r.open_ms)), startsAt: new Date(Number(r.starts_ms)) }));
}

interface Current {
  runId: string;
  stage: Stage;
}

async function readCurrent(ch: ClickHouse): Promise<Map<string, Current>> {
  const rows = await tryQuery<{ event_id: string; run_id: string; close_stage: string }>(
    ch,
    'SELECT event_id, run_id, close_stage FROM gold.fct_event_summary WHERE (event_id, run_id) IN (SELECT event_id, argMax(run_id, switched_at) FROM gold.current_run GROUP BY event_id)',
    {},
    [],
  );
  return new Map(rows.filter((r) => (STAGES as readonly string[]).includes(r.close_stage)).map((r) => [r.event_id, { runId: r.run_id, stage: r.close_stage as Stage }]));
}

async function readLog(ch: ClickHouse): Promise<{ lastDaily: Map<string, string>; r2Run: Map<string, string> }> {
  const rows = await tryQuery<{ event_id: string; last_daily: string; r2_run: string }>(
    ch,
    "SELECT event_id, maxIf(toString(toDate(started_at, 'Asia/Seoul')), kind = 'DAILY') AS last_daily, argMaxIf(run_id, started_at, stage = 'R2' AND kind = 'STAGE') AS r2_run FROM gold.close_run_log WHERE result = 'DONE' GROUP BY event_id",
    {},
    [],
  );
  return {
    lastDaily: new Map(rows.filter((r) => r.last_daily).map((r) => [r.event_id, r.last_daily])),
    r2Run: new Map(rows.filter((r) => r.r2_run).map((r) => [r.event_id, r.r2_run])),
  };
}

/** 실행 기록 표(analytics §16 '마감 실행기 실행 기록'). dbt가 돌기 전에 실패해도 기록이 남게 실행기가 먼저 만든다 */
export const CLOSE_RUN_LOG_DDL =
  'CREATE TABLE IF NOT EXISTS gold.close_run_log (event_id String, run_id String, stage String, kind String, started_at DateTime64(3), finished_at DateTime64(3), result String, detail String, quality_failed Array(String)) ENGINE = MergeTree ORDER BY (event_id, started_at)';

export async function ensureRunLog(ch: ClickHouse): Promise<void> {
  await ch.command('CREATE DATABASE IF NOT EXISTS gold');
  await ch.command(CLOSE_RUN_LOG_DDL);
}

export async function runOnce(deps: RunnerDeps): Promise<TaskOutcome[]> {
  const { ch } = deps;
  await ensureRunLog(ch);
  const refs = await readRefs(ch);
  const current = await readCurrent(ch);
  const log = await readLog(ch);
  const states = new Map<string, EventState>(refs.map((r) => [r.eventId, { completed: current.get(r.eventId)?.stage ?? null, lastDaily: log.lastDaily.get(r.eventId) ?? null }]));
  const tasks = planTasks(refs, states, deps.now(), deps.holidays);
  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) outcomes.push(await runTask(deps, task, current.get(task.eventId)?.runId ?? null, log.r2Run.get(task.eventId) ?? null));
  return outcomes;
}

export async function runTask(deps: RunnerDeps, task: Task, carryRun: string | null, r2Run: string | null): Promise<TaskOutcome> {
  const { ch, dbt } = deps;
  const startedAt = deps.now();
  const runId = deps.newRunId();
  const timeout = deps.timeoutMs ?? RUN_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const left = () => Math.max(deadline - Date.now(), 1_000);
  // R2 동결: R2 판이 있고 이번 실행이 R2 뒤(R3·매일)면 온세일 사실을 그 판에서 옮긴다
  const onsale = r2Run && (task.stage === 'R3' || task.kind === 'DAILY') ? r2Run : null;
  const base: DbtVars = {
    event_id: task.eventId,
    run_id: runId,
    stage: task.stage,
    onsale_run: onsale,
    carry_run: carryRun,
    carry_before: carryRun ? kstDateKey(new Date(startedAt.getTime() - CARRY_DAYS * DAY_MS)) : null,
    holidays: [...deps.holidays].sort(),
  };
  let qualityFailed: string[] = [];
  let detail = '';
  const finish = async (result: TaskOutcome['result'], why: string): Promise<TaskOutcome> => {
    detail = why;
    await ch.insertJsonEachRow(
      'gold.close_run_log',
      `${JSON.stringify({
        event_id: task.eventId,
        run_id: runId,
        stage: task.stage,
        kind: task.kind,
        started_at: startedAt.toISOString(),
        finished_at: deps.now().toISOString(),
        result,
        detail,
        quality_failed: qualityFailed,
      })}\n`,
      { date_time_input_format: 'best_effort' },
    );
    deps.log({ kind: 'close-run', eventId: task.eventId, runId, stage: task.stage, task: task.kind, result, detail, qualityFailed });
    return { task, runId, result, qualityFailed, detail };
  };
  const facts = await dbt(factsArgs(base), left());
  if (facts.code !== 0) return finish(facts.timedOut ? 'TIMEOUT' : 'FAILED', `사실·차원 빌드 실패: ${lastLine(facts.tail)}`);
  let reconciled = '';
  if (task.stage === 'R3') {
    const r = await reconcileRun(ch, task.eventId, runId);
    qualityFailed = r.failed;
    reconciled = r.detail;
  }
  const metrics = await dbt(metricsArgs({ ...base, quality_failed: qualityFailed }), left());
  if (metrics.code !== 0) return finish(metrics.timedOut ? 'TIMEOUT' : 'FAILED', `지표·판정 빌드 실패: ${lastLine(metrics.tail)}`);
  const swap = await dbt(swapArgs(task.eventId, runId), left());
  if (swap.code !== 0) return finish(swap.timedOut ? 'TIMEOUT' : 'FAILED', `현재 판 바꾸기 실패: ${lastLine(swap.tail)}`);
  return finish('DONE', reconciled || '완료');
}

const lastLine = (tail: string) =>
  tail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' / ')
    .slice(0, 400);
