// 회차 기준 자료 파일 싣기(docs/features/analytics.md §3.2 '싣는 방법·싣기 전 검사·형식 검사·기록과 경보', ASVS 5.2.1, F-04-6).
// 수집 폴더의 ref-event/·ref-seat-map/ 아래 JSONEachRow 파일(.json·.jsonl)을 브론즈 brz_ref_event·brz_ref_seat_map에 싣는다.
// 열 구조 밖의 칸이나 맞지 않는 줄이 하나라도 있으면 그 파일 전체를 싣지 않고(input_format_skip_unknown_fields = 0), 실은 파일은
// bronze.brz_intake_log(경로·ETag(SHA-256)·행 수·결과)에 남겨 다시 싣지 않는다. 운영의 S3 수집 버킷(s3() 표 함수)은 배포(F-09-8) 몫이다.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouseError, type ClickHouse } from './clickhouse.js';

/** 회차 기준 자료 크기 상한(50MB [가정], analytics §3.2 표) */
export const REF_MAX_BYTES = 50 * 1024 * 1024;
export const INTAKE_TARGETS = { 'ref-event': 'bronze.brz_ref_event', 'ref-seat-map': 'bronze.brz_ref_seat_map' } as const;
const EXT = /\.(json|jsonl)$/;

export const ensureIntakeLog = (ch: ClickHouse): Promise<void> =>
  ch.command(
    'CREATE TABLE IF NOT EXISTS bronze.brz_intake_log (path String, etag String, target String, rows UInt64, loaded_at DateTime64(3) DEFAULT now64(3), result String, reason String) ENGINE = MergeTree ORDER BY (path, loaded_at)',
  );

export interface IntakeOutcome {
  path: string;
  result: 'LOADED' | 'REJECTED' | 'SKIPPED';
  rows: number;
  reason: string;
}

export async function loadIntakeDir(ch: ClickHouse, dir: string): Promise<IntakeOutcome[]> {
  await ensureIntakeLog(ch);
  const out: IntakeOutcome[] = [];
  for (const [sub, table] of Object.entries(INTAKE_TARGETS)) {
    let files: string[];
    try {
      files = readdirSync(join(dir, sub)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const rel = `${sub}/${f}`;
      const full = join(dir, sub, f);
      if (!statSync(full).isFile()) continue;
      if (!EXT.test(f)) {
        out.push(await record(ch, rel, '', table, 0, 'REJECTED', 'EXTENSION'));
        continue;
      }
      if (statSync(full).size > REF_MAX_BYTES) {
        out.push(await record(ch, rel, '', table, 0, 'REJECTED', 'TOO_LARGE'));
        continue;
      }
      const body = readFileSync(full, 'utf8');
      const etag = createHash('sha256').update(body).digest('hex');
      const seen = await ch.query<{ n: string }>("SELECT toString(count()) AS n FROM bronze.brz_intake_log WHERE path = {p:String} AND etag = {t:String} AND result = 'LOADED'", { p: rel, t: etag });
      if (Number(seen[0]?.n ?? 0) > 0) {
        out.push({ path: rel, result: 'SKIPPED', rows: 0, reason: 'ALREADY_LOADED' });
        continue;
      }
      try {
        const rows = await ch.insertJsonEachRow(table, body, { input_format_skip_unknown_fields: 0, input_format_allow_errors_num: 0, date_time_input_format: 'best_effort' });
        out.push(await record(ch, rel, etag, table, rows, 'LOADED', ''));
      } catch (e) {
        // 원문 줄은 남기지 않고 오류 번호만(기준 자료에 개인정보는 없지만 로그 크기를 막는다)
        out.push(await record(ch, rel, etag, table, 0, 'REJECTED', e instanceof ClickHouseError ? `CLICKHOUSE_${e.code ?? e.status}` : 'ERROR'));
      }
    }
  }
  return out;
}

async function record(ch: ClickHouse, path: string, etag: string, target: string, rows: number, result: IntakeOutcome['result'], reason: string): Promise<IntakeOutcome> {
  await ch.insertJsonEachRow('bronze.brz_intake_log', `${JSON.stringify({ path, etag, target, rows, result, reason })}\n`);
  return { path, result, rows, reason };
}
