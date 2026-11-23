// dbt 부르기(docs/features/analytics.md §4.1 'SQL 규칙', docs/security/asvs/analytics.md 1.2.5·15.2.2, F-04-6).
// 셸을 거치지 않고 고정 인자 목록으로 실행한다. 회차·판 ID는 UUID, 단계는 R0~R3, 품질 실패 지표 코드는 소문자·숫자·밑줄만 넣는다.
import { spawn } from 'node:child_process';
import { STAGES, type Stage } from './schedule.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface DbtVars {
  event_id: string;
  run_id: string;
  stage: Stage;
  quality_failed?: readonly string[];
  /** R2 판(온세일 사실을 옮길 판) */
  onsale_run?: string | null;
  /** 앞 현재 판과 그 판에서 옮길 날의 기준(그보다 앞선 날) */
  carry_run?: string | null;
  carry_before?: string | null;
  /** KST 공휴일(dim_date의 영업일·공휴일 칸). 마감 실행기가 달력 파일에서 읽어 넘긴다 */
  holidays?: readonly string[];
}

export function checkVars(v: DbtVars): DbtVars {
  for (const [name, id] of [['event_id', v.event_id], ['run_id', v.run_id], ['onsale_run', v.onsale_run], ['carry_run', v.carry_run]] as const) {
    if (id !== undefined && id !== null && !UUID.test(id)) throw new Error(`${name}는 소문자 UUID여야 한다`);
  }
  if (!STAGES.includes(v.stage)) throw new Error('stage는 R0~R3이어야 한다');
  for (const c of v.quality_failed ?? []) if (!CODE.test(c)) throw new Error('quality_failed에는 지표 코드만 넣는다');
  if (v.carry_before !== undefined && v.carry_before !== null && !DATE_KEY.test(v.carry_before)) throw new Error('carry_before는 YYYY-MM-DD여야 한다');
  if ((v.carry_run ?? null) !== null && (v.carry_before ?? null) === null) throw new Error('carry_run에는 carry_before가 함께 있어야 한다');
  if ((v.holidays?.length ?? 0) > 400) throw new Error('holidays는 400개 이하여야 한다');
  for (const h of v.holidays ?? []) if (!DATE_KEY.test(h)) throw new Error('holidays는 YYYY-MM-DD여야 한다');
  return v;
}

/** 사실·차원(지표 폴더 밖) 빌드 */
export const factsArgs = (v: DbtVars): string[] => ['build', '--exclude', 'path:models/metrics', '--profiles-dir', '.', '--vars', JSON.stringify(checkVars(v))];
/** 지표·판정(지표 폴더) 빌드 */
export const metricsArgs = (v: DbtVars): string[] => ['build', '--select', 'path:models/metrics', '--profiles-dir', '.', '--vars', JSON.stringify(checkVars(v))];
/** 현재 판 바꾸기(macros/current_run.sql swap_current_run) */
export function swapArgs(eventId: string, runId: string): string[] {
  if (!UUID.test(eventId) || !UUID.test(runId)) throw new Error('회차·판 ID는 소문자 UUID여야 한다');
  return ['run-operation', 'swap_current_run', '--args', JSON.stringify({ event_id: eventId, run_id: runId }), '--profiles-dir', '.', '--vars', JSON.stringify({ event_id: eventId, run_id: runId })];
}

export interface DbtResult {
  code: number;
  /** 마지막 출력(실패 까닭을 남기려고. 비밀은 dbt가 출력하지 않는다) */
  tail: string;
  timedOut: boolean;
}
export type DbtExec = (args: readonly string[], timeoutMs: number) => Promise<DbtResult>;

/** dbt 실행 파일을 고정 인자로 부른다(shell: false). 시간을 넘기면 끝낸다 */
export function spawnDbt(bin: string, cwd: string, env: NodeJS.ProcessEnv): DbtExec {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn(bin, [...args], { cwd, env: { ...env, PYTHONUTF8: '1' }, shell: false, windowsHide: true });
      let tail = '';
      const keep = (b: Buffer) => {
        tail = (tail + b.toString('utf8')).slice(-4_000);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 127, tail: `${tail}\n${err.message}`.slice(-4_000), timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, tail, timedOut });
      });
    });
}
