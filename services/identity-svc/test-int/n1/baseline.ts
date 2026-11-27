// identity-svc N-1 기준 스키마의 신원 보증(F-09-2 D-T8, docs/devops.md §7.3 적용 시험 ③).
// N-1은 "마이그레이션 직전 develop 커밋" `713b522a`(2026-11-23, 0037까지)이다.
// migration은 그다음 커밋 `0346eded`(0038_scanner_session_device_name.sql을 더한 커밋)이다.
// 이 파일은 Docker 없이 도는 시험이 쓴다. 실제 PostgreSQL에서의 계약 실행은 `n1-compat.int.test.ts`가 맡는다.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** N-1의 마지막 identity 마이그레이션. 이 이름까지가 N-1 스키마이고, 0038부터가 N 스키마다. */
export const N1_BASELINE_LAST = '0037_staff_assignment_expiry.sql';

export interface BaselineManifest {
  source: {
    definition: string;
    branch: string;
    commit: string;
    migrationCommit: string;
    migration: string;
    previousMigration: string;
  };
  files: Array<{ name: string; sha256: string }>;
}

export interface BaselineFile {
  name: string;
  sql: string;
  sha256: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** `0037_staff_assignment_expiry.sql`까지의 파일을 이름 순으로 읽는다. 그 파일이 없으면 N-1 기준이 아니다. */
export async function readN1Files(dir: string): Promise<BaselineFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const selected = names.filter((name) => name <= N1_BASELINE_LAST);
  const last = selected[selected.length - 1];
  if (selected.length === 0 || last !== N1_BASELINE_LAST) {
    throw new Error(`N-1 기준 파일이 ${N1_BASELINE_LAST}까지가 아니다: ${last ?? '없음'}`);
  }
  return Promise.all(
    selected.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, sha256: sha256(sql) };
    }),
  );
}

/**
 * N-1 기준 파일이 713b522a와 같은지 본다. 적용한 마이그레이션 파일을 고치면 N-1 스키마가 조용히 달라지므로
 * 파일 이름·차례·SHA-256을 모두 대조한다. 다르면 던진다.
 */
export async function assertN1Baseline(dir: string, manifest: BaselineManifest): Promise<number> {
  const files = await readN1Files(dir);
  if (files.length !== manifest.files.length) {
    throw new Error(`N-1 기준 파일 수가 713b522a와 다르다: ${files.length} != ${manifest.files.length}`);
  }
  for (const [index, file] of files.entries()) {
    const expected = manifest.files[index];
    if (!expected || expected.name !== file.name) {
      throw new Error(`N-1 기준 파일 차례가 713b522a와 다르다: ${file.name}`);
    }
    if (expected.sha256 !== file.sha256) {
      throw new Error(`N-1 기준 스키마가 713b522a와 다르다: ${file.name}`);
    }
  }
  return files.length;
}

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?(?:"([a-z_][a-z0-9_]*)"\.)?"([a-z_][a-z0-9_]*)"/gi;

/** 마이그레이션 SQL에서 만든 표 이름을 모은다(`retention.verification_record` 같은 스키마 붙은 표 포함). */
export function tablesInMigrations(sqls: readonly string[]): Set<string> {
  const tables = new Set<string>();
  for (const sql of sqls) {
    for (const match of sql.matchAll(CREATE_TABLE)) {
      const name = match[2];
      if (name) tables.add(name);
    }
  }
  return tables;
}

/**
 * N-1 계약이 쓰는 표가 모두 N-1 스키마(0000~0037)에 있는지 본다. 다른 서비스 표나 뒤에 생긴 표를 계약에 넣으면
 * N-1 스키마 시험에서 우연히 통과하지 않도록, Docker 없이 먼저 막는다.
 */
export function assertContractTables(tables: readonly string[], migrationSqls: readonly string[]): void {
  const known = tablesInMigrations(migrationSqls);
  const missing = [...new Set(tables.filter((table) => !known.has(table)))];
  if (missing.length > 0) throw new Error(`N-1 계약이 713b522a에 없는 표를 쓴다: ${missing.join(', ')}`);
}
