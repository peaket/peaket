// asvs-report: ignore
// 시험 보고서 켜기(BOT-162) 시험.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { testReport } from './report.mjs';

test('PEAKET_TEST_REPORT가없으면아무것도바꾸지않고_있으면화면출력과JSON보고서를남긴다', () => {
  const before = process.env.PEAKET_TEST_REPORT;
  try {
    delete process.env.PEAKET_TEST_REPORT;
    assert.deepEqual(testReport(), {});
    process.env.PEAKET_TEST_REPORT = 'test-report.json';
    assert.deepEqual(testReport(), { reporters: ['default', 'json'], outputFile: { json: 'test-report.json' } });
  } finally {
    if (before === undefined) delete process.env.PEAKET_TEST_REPORT;
    else process.env.PEAKET_TEST_REPORT = before;
  }
});

test('저장소의vitest설정은모두testReport를쓴다_새설정이빠뜨리면그패키지태그가조용히미실행이된다', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  // CI 컨테이너는 저장소 소유자와 실행 사용자가 달라 git이 'dubious ownership'으로 멈춘다. 읽기 한 번이라 이 호출에만 허용한다
  const files = execFileSync('git', ['-c', 'safe.directory=*', 'ls-files', '*vitest*.config.*'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  assert.ok(files.length > 20);
  const missing = files.filter((f) => !readFileSync(root + f, 'utf8').includes('...testReport()'));
  assert.deepEqual(missing, []);
});
