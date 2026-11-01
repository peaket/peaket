// fork-guard.mjs(비밀이 필요한 단계의 포크 PR 건너뛰기 표시) 시험. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './fork-guard.mjs';
import { tempDir } from './git-fixture.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'fork-guard.mjs');
const pr = (head, base = 'peaket/peaket') => ({ pull_request: { head: { repo: head === null ? null : { full_name: head } }, base: { repo: { full_name: base } } } });

test('FND110_비밀이필요없는단계는_어디서나돈다', () => {
  assert.deepEqual(decide({ eventName: 'pull_request', event: pr('someone/peaket'), env: {}, needs: [] }), { run: true, reason: 'no-secrets-needed' });
});

test('FND110_포크PR은_비밀이없어_건너뛰고_까닭을남긴다', () => {
  assert.deepEqual(decide({ eventName: 'pull_request', event: pr('someone/peaket'), env: {}, needs: ['LOCALSTACK_AUTH_TOKEN'] }), { run: false, reason: 'fork' });
  // 지워진 포크(head.repo가 null)도 포크로 본다
  assert.equal(decide({ eventName: 'pull_request', event: pr(null), env: {}, needs: ['X'] }).run, false);
});

test('FND110_조직안PR·푸시에서_비밀이빠졌으면_건너뛰지않고실패한다', () => {
  assert.throws(() => decide({ eventName: 'pull_request', event: pr('peaket/peaket'), env: {}, needs: ['LOCALSTACK_AUTH_TOKEN'] }), /LOCALSTACK_AUTH_TOKEN/);
  assert.throws(() => decide({ eventName: 'push', event: {}, env: { A: 'x' }, needs: ['A', 'B'] }), /B/);
  assert.deepEqual(decide({ eventName: 'push', event: {}, env: { A: 'x' }, needs: ['A'] }), { run: true, reason: 'secrets-present' });
});

test('FND110_건너뛸때_출력run=false와_알림·잡요약에표시를쓴다', () => {
  const dir = tempDir('fork-guard-');
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(pr('someone/peaket')));
  const out = join(dir, 'out');
  const summary = join(dir, 'summary');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  const r = spawnSync(process.execPath, [script, '--job', 'aws-integration', '--needs', 'LOCALSTACK_AUTH_TOKEN'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'run=false\n');
  assert.match(r.stdout, /::notice title=포크 PR 건너뜀::aws-integration/);
  assert.match(readFileSync(summary, 'utf8'), /건너뜀\(포크 PR, 비밀 없음\): aws-integration — LOCALSTACK_AUTH_TOKEN/);
});

test('FND110_조직안PR에서_비밀이빠지면_종료코드1', () => {
  const dir = tempDir('fork-guard-');
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(pr('peaket/peaket')));
  const r = spawnSync(process.execPath, [script, '--job', 'x', '--needs', 'S'], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath } });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /::error::/);
});
