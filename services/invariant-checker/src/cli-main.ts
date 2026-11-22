// 불변식 검사기 명령의 몸(docs/verification.md §2.5). cli.ts는 이것을 불러 끝 코드로 process.exit만 한다.
// 시험이 명령 경계(인자·환경 값·표준 출력·표준 오류·끝 코드)로 부를 수 있게 따로 둔다(FIX-invariant-m3).
// - 표준 출력: 불변식마다 한 줄, 끝에 요약 한 줄(결과별 개수와 SKIPPED 불변식·까닭)
// - 표준 오류: 붙은 원본에 표가 없어 건너뛴 불변식의 경고 줄, 오류 메시지
// - 끝 코드: FAIL이 있으면 1, 아니면 0(SKIPPED만 있어도 0), 인자·연결·기록·검사 오류 2
// 오류 메시지에 DB 주소를 싣지 않는다(ASVS v5.0.0-16.2.5).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { CliError, parseCliArgs } from './cli-args.js';
import { RecordFormatError, parseRecords } from './records.js';
import { exitCode, skipWarnings, summaryLine, toCsv, toDetailNdjson } from './report.js';
import { runInvariantChecks } from './run.js';
import type { SourceName } from './tables.js';

/** 명령의 출력 자리. 받는 글은 줄 끝(\n)까지 든 한 줄이다 */
export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

async function check(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo): Promise<0 | 1> {
  const cfg = parseCliArgs(argv, env);
  const records = cfg.records ? parseRecords(readFileSync(cfg.records, 'utf8')) : undefined;
  const clients: pg.Client[] = [];
  const connect = async (url: string, name: string) => {
    const c = new pg.Client({ connectionString: url, application_name: `peaket-invariants-${name}` });
    try {
      await c.connect();
    } catch (e) {
      throw new CliError(`${name} DB에 붙지 못했다(${(e as { code?: string }).code ?? 'unknown'})`);
    }
    clients.push(c);
    return c;
  };
  try {
    const checkDb = await connect(cfg.checkUrl, 'check');
    const sources: Partial<Record<SourceName, pg.Client>> = {};
    for (const [name, url] of Object.entries(cfg.sources) as Array<[SourceName, string]>) sources[name] = await connect(url, name);
    const run = await runInvariantChecks({ check: checkDb, sources, records, enqueueWithinMs: cfg.enqueueWithinMs, issueDeadlineMs: cfg.issueDeadlineMs });
    mkdirSync(cfg.out, { recursive: true });
    writeFileSync(join(cfg.out, 'invariants.csv'), toCsv(run.results, run.asOf));
    writeFileSync(join(cfg.out, 'invariants-detail.ndjson'), toDetailNdjson(run.results));
    for (const r of run.results) io.stdout(`${r.id} ${r.result}${r.result === 'SKIPPED' ? ` (${r.reason})` : ` violations=${r.violations}`}\n`);
    io.stdout(`${summaryLine(run.results)}\n`);
    for (const w of skipWarnings(run.results)) io.stderr(`${w}\n`);
    return exitCode(run.results);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
}

/** 명령 한 번. 던지지 않고 끝 코드(0·1·2)를 돌려준다 */
export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo): Promise<0 | 1 | 2> {
  try {
    return await check(argv, env, io);
  } catch (e) {
    const known = e instanceof CliError || e instanceof RecordFormatError;
    io.stderr(`peaket-invariants: ${known ? (e as Error).message : `검사 실패(${(e as { code?: string }).code ?? (e as Error).name})`}\n`);
    return 2;
  }
}
