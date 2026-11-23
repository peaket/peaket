// close-runner 시작 파일(docs/features/analytics.md §3.2·§4.1, OPS-240, F-04-6). 쿠버네티스 CronJob(10분마다 [가정], 동시 실행 금지)이 부른다.
//   node dist/main.js run-once [--now <ISO 시각>]   수집 폴더가 있으면 먼저 싣고, 마감 단계·매일 쌓기를 처리한다
//   node dist/main.js load-ref --dir <폴더>          회차 기준 자료 파일만 싣는다
// 연결은 dbt 프로필과 같은 환경 변수(PEAKET_ANALYTICS_CLICKHOUSE_HOST·_PORT·_USER·_PASSWORD, _SECURE=true면 https)다. --now는 데모 시계·시험용이다.
// 실패한 할 일이 하나라도 있으면 종료 코드 1(CronJob 실패 → 경보), 설정·인자 오류는 2다.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseHttp } from './clickhouse.js';
import { spawnDbt } from './dbt.js';
import { loadIntakeDir } from './intake.js';
import { runOnce } from './runner.js';
import { parseHolidayCalendar } from './schedule.js';

const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ service: 'close-runner', at: new Date().toISOString(), ...event })}\n`);

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [cmd] = argv;
  const missing = ['PEAKET_ANALYTICS_CLICKHOUSE_HOST', 'PEAKET_ANALYTICS_CLICKHOUSE_USER', 'PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) {
    log({ kind: 'config-error', missing });
    return 2;
  }
  const scheme = env.PEAKET_ANALYTICS_CLICKHOUSE_SECURE === 'true' ? 'https' : 'http';
  const ch = clickHouseHttp({
    url: `${scheme}://${env.PEAKET_ANALYTICS_CLICKHOUSE_HOST}:${env.PEAKET_ANALYTICS_CLICKHOUSE_PORT ?? '8123'}`,
    user: env.PEAKET_ANALYTICS_CLICKHOUSE_USER!,
    password: env.PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD!,
  });
  if (cmd === 'load-ref') {
    const dir = arg(argv, '--dir');
    if (!dir) return 2;
    const out = await loadIntakeDir(ch, dir);
    for (const o of out) log({ kind: 'intake', ...o });
    return out.some((o) => o.result === 'REJECTED') ? 1 : 0;
  }
  if (cmd !== 'run-once') {
    log({ kind: 'usage', message: 'run-once [--now ISO] | load-ref --dir <폴더>' });
    return 2;
  }
  const nowArg = arg(argv, '--now');
  const fixed = nowArg ? new Date(nowArg) : null;
  if (fixed && Number.isNaN(fixed.getTime())) return 2;
  let failed = false;
  if (env.PEAKET_CLOSE_INTAKE_DIR) {
    const out = await loadIntakeDir(ch, env.PEAKET_CLOSE_INTAKE_DIR);
    for (const o of out) log({ kind: 'intake', ...o });
    failed ||= out.some((o) => o.result === 'REJECTED');
  }
  const holidays = env.PEAKET_HOLIDAY_CALENDAR_FILE ? parseHolidayCalendar(readFileSync(env.PEAKET_HOLIDAY_CALENDAR_FILE, 'utf8')) : new Set<string>();
  const projectDir = env.PEAKET_DBT_PROJECT_DIR ?? resolve(fileURLToPath(new URL('../../../data', import.meta.url)));
  const outcomes = await runOnce({
    ch,
    dbt: spawnDbt(env.PEAKET_DBT_BIN ?? 'dbt', projectDir, env),
    now: () => fixed ?? new Date(),
    newRunId: randomUUID,
    holidays,
    log,
  });
  log({ kind: 'close-run-summary', tasks: outcomes.length, failed: outcomes.filter((o) => o.result !== 'DONE').length });
  return failed || outcomes.some((o) => o.result !== 'DONE') ? 1 : 0;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log({ kind: 'crash', error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  },
);
