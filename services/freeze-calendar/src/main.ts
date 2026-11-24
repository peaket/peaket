#!/usr/bin/env node
// freeze-calendar 시작 파일(F-02-3, OPS-320, docs/devops.md §8.2).
//   node dist/main.js calendar [--now <ISO>]   승인된 온세일 일정을 읽어 deploy/calendar/freeze.json과 적용할 창·예산을 쓴다(10분 주기)
//   node dist/main.js guard    [--now <ISO>]   창의 자동 중단 시각에 진행 중 롤아웃을 중단한다(1분 주기)
// 일정 파일은 PEAKET_FREEZE_SCHEDULE_FILE(로컬) 또는 PEAKET_FREEZE_SCHEDULE_BUCKET·_KEY(S3)에서 읽는다.
// 실제 ArgoCD·Karpenter·Argo Rollouts 연결과 CronJob·RBAC은 구간 5(INF-020)다.
import { join } from 'node:path';
import { CALENDAR_FILE, fsCalendarWriter, runCalendarOnce } from './calendar.js';
import { ConfigError, DEFAULT_SCHEDULE_KEY, parseNowArg, requireEnv } from './config.js';
import { runGuardOnce } from './guard.js';
import { FileCalendarSource } from './adapters/file-calendar-source.js';
import { FileRolloutSource } from './adapters/file-rollout-source.js';
import { FileScheduleSource } from './adapters/file-schedule-source.js';
import { LoggingAborter } from './adapters/logging-aborter.js';
import { S3ScheduleSource } from './adapters/s3-schedule-source.js';

const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ service: 'freeze-calendar', at: new Date().toISOString(), ...line })}\n`);

function rootOf(env: NodeJS.ProcessEnv): string {
  return env.PEAKET_FREEZE_ROOT ?? process.cwd();
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [mode] = argv;
  const nowMs = parseNowArg(argv);
  if (nowMs === null) {
    log({ kind: 'usage', message: 'calendar [--now ISO] | guard [--now ISO]' });
    return 2;
  }
  if (mode === 'calendar') {
    const file = env.PEAKET_FREEZE_SCHEDULE_FILE;
    const source = file
      ? new FileScheduleSource(file)
      : new S3ScheduleSource({
          bucket: requireEnv(env, 'PEAKET_FREEZE_SCHEDULE_BUCKET'),
          key: env.PEAKET_FREEZE_SCHEDULE_KEY ?? DEFAULT_SCHEDULE_KEY,
          ...(env.PEAKET_FREEZE_S3_ENDPOINT ? { endpoint: env.PEAKET_FREEZE_S3_ENDPOINT } : {}),
        });
    await runCalendarOnce({
      root: rootOf(env),
      source,
      writer: fsCalendarWriter(rootOf(env)),
      now: () => nowMs,
      log,
    });
    return 0;
  }
  if (mode === 'guard') {
    const root = rootOf(env);
    const calendarFile = env.PEAKET_FREEZE_CALENDAR_FILE ?? join(root, CALENDAR_FILE);
    const rolloutsFile = requireEnv(env, 'PEAKET_FREEZE_ROLLOUTS_FILE');
    const run = await runGuardOnce({
      now: () => nowMs,
      calendar: new FileCalendarSource(calendarFile),
      rollouts: new FileRolloutSource(rolloutsFile),
      aborter: new LoggingAborter(log),
      log,
    });
    return run.result === 'failed' ? 1 : 0;
  }
  log({ kind: 'usage', message: 'calendar [--now ISO] | guard [--now ISO]' });
  return 2;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ConfigError) {
      log({ kind: 'config-error', message: err.message });
      process.exitCode = 2;
      return;
    }
    log({ kind: 'crash', message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  },
);
