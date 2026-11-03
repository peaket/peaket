// ci-summary.mjs 시험(D-T47 ①). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'ci-summary.mjs');
const run = (needs) => {
  const env = { ...process.env };
  if (needs === undefined) delete env.NEEDS;
  else env.NEEDS = typeof needs === 'string' ? needs : JSON.stringify(needs);
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
};
const job = (result) => ({ result, outputs: {} });

test('D-T47 ① 성공과 건너뜀만 있으면 통과한다', () => {
  assert.equal(run({ changes: job('success'), 'docs-check': job('success'), 'iac-check': job('skipped') }).code, 0);
});

test('실패나 취소가 하나라도 있으면 실패한다', () => {
  for (const result of ['failure', 'cancelled']) {
    const r = run({ changes: job('success'), 'iac-check': job(result) });
    assert.equal(r.code, 1, result);
    assert.match(r.out, /성공하지 못한 잡: iac-check/);
  }
});

test('결과를 읽지 못하면 실패한다', () => {
  for (const needs of [undefined, '', 'not json', {}, 'null']) assert.equal(run(needs).code, 1, String(needs));
});
