// 시작 파일 시험의 빌드 건너뛰기(코드 리뷰, ci-node 잡 시간): CI가 앞 단계(turbo build)에서 만든 dist를 쓰게 할 때, dist/main.js가 없거나
// src의 어느 .ts보다 낡았으면 그 까닭을 돌려준다(지난 빌드를 돌리지 않게). 시험 값은 임시 폴더의 가짜 패키지다.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { distProblem } from '../test-int/dist-check.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function pkg(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dist-check-'));
  dirs.push(dir);
  for (const [p, sec] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), '');
    utimesSync(join(dir, p), sec, sec);
  }
  return dir;
}

test('PRF215_코드리뷰_dist가_src보다_새로우면_문제없음이고_없거나_낡았으면_그까닭이다', () => {
  expect(distProblem(pkg({ 'src/main.ts': 1_000, 'src/a/b.ts': 1_100, 'dist/main.js': 1_200 }))).toBeNull();
  expect(distProblem(pkg({ 'src/main.ts': 1_000 }))).toMatch(/dist\/main\.js가 없다/);
  expect(distProblem(pkg({ 'src/main.ts': 1_000, 'src/a/b.ts': 1_300, 'dist/main.js': 1_200 }))).toMatch(/src[\\/]a[\\/]b\.ts.*낡았다/);
});
