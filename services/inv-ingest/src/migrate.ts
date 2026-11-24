// inv 표 이전 실행기(data/clickhouse/inv/*.sql, F-04-10). services/analytics-ingest/src/migrate.ts와 같은 규칙이다.
// 파일은 운영 모양(ON CLUSTER '{cluster}', ReplicatedReplacingMergeTree)이다. 한 대짜리 ClickHouse(local·ci)면 topology 'single'로
// ON CLUSTER 구를 지우고 MergeTree로 바꾼다. 사용자 SQL의 비밀번호 자리표시자는 넘겨받은 값으로 바꾼다(비밀번호를 저장소에 적지 않는다).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Topology = 'single' | 'cluster';

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

export function forTopology(stmt: string, topology: Topology): string {
  if (topology === 'cluster') return stmt;
  let s = stmt.replace(/\s+ON CLUSTER '\{cluster\}'/g, '');
  if (/ENGINE = ReplicatedReplacingMergeTree\(([^)]*)\)/.test(s)) {
    s = s.replace(/ENGINE = ReplicatedReplacingMergeTree\(([^)]*)\)/, 'ENGINE = ReplacingMergeTree($1)');
    s = /\bSETTINGS\b/.test(s) ? s : `${s}\nSETTINGS non_replicated_deduplication_window = 1000`;
  }
  return s;
}

/** 사용자 SQL의 {inv_*_password}를 환경 값으로 바꾼다. 값이 없으면 그 문장을 건너뛴다(로컬에서 사용자를 만들지 않는다) */
export function applyPasswords(stmt: string, passwords: Readonly<Record<string, string>>): string | null {
  const names = [...stmt.matchAll(/\{([a-z_]+_password)\}/g)].map((m) => m[1]!);
  if (names.length === 0) return stmt;
  let out = stmt;
  for (const name of names) {
    const value = passwords[name];
    if (!value) return null;
    out = out.replaceAll(`{${name}}`, value.replaceAll("'", "''"));
  }
  return out;
}

export function migrationStatements(dir: string, topology: Topology, passwords: Readonly<Record<string, string>> = {}): string[] {
  const noUsers = Object.keys(passwords).length === 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      statementsOf(readFileSync(join(dir, f), 'utf8'))
        .filter((s) => !(noUsers && /^(CREATE USER|CREATE SETTINGS PROFILE|GRANT)\b/.test(s) && /\binv_(ingest|reader|purger)\b|\binv_reader_profile\b/.test(s)))
        .map((s) => applyPasswords(s, passwords))
        .filter((s): s is string => s !== null)
        .map((s) => forTopology(s, topology)),
    );
}

export async function migrateInv(exec: (sql: string) => Promise<unknown>, dir: string, topology: Topology, passwords: Readonly<Record<string, string>> = {}): Promise<number> {
  const stmts = migrationStatements(dir, topology, passwords);
  for (const s of stmts) await exec(s);
  return stmts.length;
}
