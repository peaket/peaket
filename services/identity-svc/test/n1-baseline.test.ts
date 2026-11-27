// identity-svc N-1 기준 스키마의 고정과 계약 표 검사(F-09-2 D-T8, 계획 docs/review/plans/F-09-2-n1.md §6).
// N-1 = 마이그레이션 직전 develop 커밋 713b522a(0037까지), migration = 0346eded(0038). Docker 없이 돈다.
// 실제 PostgreSQL에서의 계약 실행은 test-int/n1-compat.int.test.ts가 맡는다.
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { assertContractTables, assertN1Baseline, N1_BASELINE_LAST, readN1Files, type BaselineManifest } from '../test-int/n1/baseline.js';
import { N1_TABLES } from '../test-int/n1/contract.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../test-int/n1/manifest-713b522a.json', import.meta.url));
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readManifest(): Promise<BaselineManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as BaselineManifest;
}

test('D-T8 identity N-1 기준 스키마 0000~0037이 713b522a와 같다', async () => {
  const manifest = await readManifest();
  expect(manifest.source).toEqual({
    definition: '마이그레이션 직전 develop 커밋',
    branch: 'develop',
    commit: '713b522a7f4566a7b9ef047012783f9be50bf675',
    migrationCommit: '0346eded88e7de8ba108c4288f5aa1c9cd478ffe',
    migration: '0038_scanner_session_device_name.sql',
    previousMigration: N1_BASELINE_LAST,
  });
  expect(await assertN1Baseline(MIGRATIONS, manifest)).toBe(38);
});

test('D-T8 identity N-1 기준 스키마 파일이 하나라도 바뀌면 막는다', async () => {
  const manifest = await readManifest();
  const dir = await mkdtemp(join(tmpdir(), 'identity-n1-drift-'));
  tempDirs.push(dir);
  for (const file of manifest.files) await copyFile(join(MIGRATIONS, file.name), join(dir, file.name));
  await writeFile(join(dir, N1_BASELINE_LAST), '-- 713b522a 파일을 고친 판\n', { encoding: 'utf8', flag: 'a' });
  await expect(assertN1Baseline(dir, manifest)).rejects.toThrow(`N-1 기준 스키마가 713b522a와 다르다: ${N1_BASELINE_LAST}`);
});

test('D-T8 identity N-1 계약이 713b522a에 없는 표를 쓰면 막는다', async () => {
  const files = await readN1Files(MIGRATIONS);
  const sqls = files.map((file) => file.sql);
  expect(() => assertContractTables(N1_TABLES, sqls)).not.toThrow();
  expect(() => assertContractTables([...N1_TABLES, 'receivable_movement'], sqls)).toThrow(
    'N-1 계약이 713b522a에 없는 표를 쓴다: receivable_movement',
  );
});
