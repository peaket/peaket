#!/usr/bin/env node
// 불변식 검사기 명령. 시험이 끝난 뒤 돌린다(docs/verification.md §2.5).
//   INVARIANT_CHECK_DB_URL=… INVARIANT_PURCHASE_DB_URL=… INVARIANT_PAYMENT_DB_URL=… INVARIANT_TICKET_DB_URL=… \
//     peaket-invariants --out <성능 장부 실행 폴더> [--records <시험 기록.ndjson>] [--enqueue-within-sec 60] [--issue-deadline-min 30]
// 결과: <out>/invariants.csv(건수), <out>/invariants-detail.ndjson(위반 행, Git에 두지 않음). 하나라도 FAIL이면 종료 코드 1.
// 오류 메시지에 DB 주소를 싣지 않는다(ASVS v5.0.0-16.2.5).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { CliError, parseCliArgs } from './cli-args.js';
import { RecordFormatError, parseRecords } from './records.js';
import { exitCode, toCsv, toDetailNdjson } from './report.js';
import { runInvariantChecks } from './run.js';
import type { SourceName } from './tables.js';

async function main(): Promise<number> {
  const cfg = parseCliArgs(process.argv.slice(2), process.env);
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
    const check = await connect(cfg.checkUrl, 'check');
    const sources: Partial<Record<SourceName, pg.Client>> = {};
    for (const [name, url] of Object.entries(cfg.sources) as Array<[SourceName, string]>) sources[name] = await connect(url, name);
    const run = await runInvariantChecks({ check, sources, records, enqueueWithinMs: cfg.enqueueWithinMs, issueDeadlineMs: cfg.issueDeadlineMs });
    mkdirSync(cfg.out, { recursive: true });
    writeFileSync(join(cfg.out, 'invariants.csv'), toCsv(run.results, run.asOf));
    writeFileSync(join(cfg.out, 'invariants-detail.ndjson'), toDetailNdjson(run.results));
    for (const r of run.results) process.stdout.write(`${r.id} ${r.result}${r.result === 'SKIPPED' ? ` (${r.reason})` : ` violations=${r.violations}`}\n`);
    return exitCode(run.results);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const known = e instanceof CliError || e instanceof RecordFormatError;
    process.stderr.write(`peaket-invariants: ${known ? (e as Error).message : `검사 실패(${(e as { code?: string }).code ?? (e as Error).name})`}\n`);
    process.exit(2);
  },
);
