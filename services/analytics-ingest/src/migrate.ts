// 브론즈 표 이전 실행기(data/clickhouse/bronze/*.sql, OPS-200, F-04-3). services/ops-rt/src/migrate.ts와 같은 규칙이다.
// 파일은 운영 모양(ON CLUSTER '{cluster}', ReplicatedMergeTree)이다. 한 대짜리 ClickHouse(local·ci)면 topology 'single'로
// ON CLUSTER 구를 지우고 MergeTree로 바꾼다. 그때 표에 중복 거르기 창을 켠다(복제 표는 기본으로 켜져 있다, 추천 적용 2026-11-23, F-04-1 계획).
// 모든 문장은 IF NOT EXISTS·OR REPLACE라 여러 번 돌려도 같다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Topology = 'single' | 'cluster';

/** 파일 하나를 문장으로 나눈다(줄 끝의 ';'). 주석 줄은 지운다 */
export function statementsOf(sql: string): string[] {
  const body = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  return body
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 한 대짜리 ClickHouse에 맞춘다 */
export function forTopology(stmt: string, topology: Topology): string {
  if (topology === 'cluster') return stmt;
  let s = stmt.replace(/\s+ON CLUSTER '\{cluster\}'/g, '');
  if (/ENGINE = ReplicatedMergeTree/.test(s)) {
    s = s.replace(/ENGINE = ReplicatedMergeTree/, 'ENGINE = MergeTree');
    s = /\bSETTINGS\b/.test(s) ? s : `${s}\nSETTINGS non_replicated_deduplication_window = 1000`;
  }
  return s;
}

/** 폴더의 .sql을 이름 차례로 읽어 문장 목록으로 */
export function migrationStatements(dir: string, topology: Topology): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) => statementsOf(readFileSync(join(dir, f), 'utf8')).map((s) => forTopology(s, topology)));
}

export async function migrateRt(exec: (sql: string) => Promise<unknown>, dir: string, topology: Topology): Promise<number> {
  const stmts = migrationStatements(dir, topology);
  for (const s of stmts) await exec(s);
  return stmts.length;
}
