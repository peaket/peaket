// standalone 산출물 준비(docs/frontend.md §5.18, ASVS 13.4.1, HOT-390).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStandalone, standaloneAppDir, standaloneServerPath } from './standalone.mjs';

function fixture() {
  const appDir = mkdtempSync(join(tmpdir(), 'peaket-standalone-'));
  mkdirSync(join(appDir, '.next', 'static', 'chunks'), { recursive: true });
  mkdirSync(join(appDir, 'public'), { recursive: true });
  mkdirSync(join(appDir, '.next', 'standalone', 'apps', 'web'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'static', 'chunks', 'a.js'), 'console.log(1)');
  writeFileSync(join(appDir, 'public', 'robots.txt'), 'User-agent: *');
  writeFileSync(join(appDir, '.next', 'standalone', 'apps', 'web', 'server.js'), '// server');
  return appDir;
}

test('HOT-390 standalone 폴더에 .next/static과 public을 복사한다', () => {
  const appDir = fixture();
  try {
    assert.equal(standaloneAppDir(appDir, '.next'), join(appDir, '.next', 'standalone', 'apps', 'web'));
    assert.equal(standaloneServerPath(appDir, '.next'), join(appDir, '.next', 'standalone', 'apps', 'web', 'server.js'));
    assert.equal(prepareStandalone(appDir, '.next'), true);
    assert.equal(readFileSync(join(appDir, '.next', 'standalone', 'apps', 'web', '.next', 'static', 'chunks', 'a.js'), 'utf8'), 'console.log(1)');
    assert.equal(readFileSync(join(appDir, '.next', 'standalone', 'apps', 'web', 'public', 'robots.txt'), 'utf8'), 'User-agent: *');
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('distDir가 .next-poc이면 standalone 안의 .next-poc/static으로 복사한다(빌드 이름을 따른다)', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'peaket-standalone-'));
  try {
    mkdirSync(join(appDir, '.next-poc', 'static', 'chunks'), { recursive: true });
    mkdirSync(join(appDir, '.next-poc', 'standalone', 'apps', 'web'), { recursive: true });
    writeFileSync(join(appDir, '.next-poc', 'static', 'chunks', 'poc.css'), 'a{}');
    writeFileSync(join(appDir, '.next-poc', 'standalone', 'apps', 'web', 'server.js'), '// server');
    assert.equal(prepareStandalone(appDir, '.next-poc'), true);
    assert.equal(readFileSync(join(appDir, '.next-poc', 'standalone', 'apps', 'web', '.next-poc', 'static', 'chunks', 'poc.css'), 'utf8'), 'a{}');
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('standalone server.js가 없으면 false이고 아무것도 만들지 않는다(개발 next start 길)', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'peaket-standalone-'));
  try {
    assert.equal(prepareStandalone(appDir, '.next'), false);
    assert.equal(existsSync(join(appDir, '.next', 'standalone')), false);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

// BAT-170 검증 뒤 정한 것(계획 §13 V13-5, docs/security/asvs/frontend.md 13.4.1, docs/frontend.md §5.18 '앱 서버 실행'):
// public을 standalone으로 복사할 때 점으로 시작하는 파일·폴더(.git·.env·.DS_Store 등)는 빼낸다. 시험 담당(l2w7-BAT170-test)이 썼다.
test('[ASVS v5.0.0-13.4.1] public을 standalone으로 복사할 때 점으로 시작하는 파일·폴더는 빼낸다', () => {
  const appDir = fixture();
  try {
    const pub = join(appDir, 'public');
    mkdirSync(join(pub, '.git'), { recursive: true });
    mkdirSync(join(pub, 'icons'), { recursive: true });
    writeFileSync(join(pub, '.git', 'config'), '[core]');
    writeFileSync(join(pub, '.env'), 'SECRET=1');
    writeFileSync(join(pub, 'icons', '.DS_Store'), 'x');
    writeFileSync(join(pub, 'favicon.ico'), 'ico');
    writeFileSync(join(pub, 'icons', 'a.png'), 'png');
    assert.equal(prepareStandalone(appDir, '.next'), true);
    const out = join(standaloneAppDir(appDir, '.next'), 'public');
    for (const p of ['.git', join('.git', 'config'), '.env', join('icons', '.DS_Store')]) assert.equal(existsSync(join(out, p)), false, `${p}가 복사됐다`);
    for (const p of ['favicon.ico', join('icons', 'a.png'), 'robots.txt']) assert.equal(existsSync(join(out, p)), true, `${p}가 복사되지 않았다`);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

// BAT-171 시험 이의 6·7(시험 담당 l2-bat171-test, docs/frontend.md §5.4 '서비스 워커'·§5.18 '앱 서버 실행'): 월렛 서비스 워커는 빌드 때
// <dist>/serwist/sw.js로 묶어 두고 경로 처리기는 그 파일만 읽는다. standalone 서버(자기 폴더에서 뜬다)가 찾도록 그 폴더를 standalone 안 같은 자리로 복사한다
test('HOT-390 standalone 폴더에 빌드 때 묶은 월렛 서비스 워커(<dist>/serwist)를 같은 자리로 복사한다', () => {
  for (const dist of ['.next', '.next-poc']) {
    const appDir = mkdtempSync(join(tmpdir(), 'peaket-standalone-'));
    try {
      mkdirSync(join(appDir, dist, 'serwist'), { recursive: true });
      mkdirSync(join(appDir, dist, 'standalone', 'apps', 'web'), { recursive: true });
      writeFileSync(join(appDir, dist, 'serwist', 'sw.js'), 'self.__v = 10;\n');
      writeFileSync(join(appDir, dist, 'standalone', 'apps', 'web', 'server.js'), '// server');
      assert.equal(prepareStandalone(appDir, dist), true);
      const copied = join(appDir, dist, 'standalone', 'apps', 'web', dist, 'serwist', 'sw.js');
      assert.ok(existsSync(copied), `${dist}: standalone 안에 serwist/sw.js가 없다`);
      assert.equal(readFileSync(copied, 'utf8'), 'self.__v = 10;\n', dist);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  }
  // 워커 폴더가 없으면(개발 빌드 등) 빈 폴더를 만들지 않는다
  const appDir = fixture();
  try {
    assert.equal(prepareStandalone(appDir, '.next'), true);
    assert.equal(existsSync(join(appDir, '.next', 'standalone', 'apps', 'web', '.next', 'serwist')), false);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('HOT-390 standalone이 복사하는 워커 폴더 이름은 빌드 때 워커를 쓰는 폴더 이름(scripts/service-worker.mjs)과 같다', async () => {
  const server = await import('./standalone.mjs');
  const script = await import('../scripts/service-worker.mjs');
  assert.equal(typeof server.SW_DIR, 'string', 'server/standalone.mjs가 워커 폴더 이름을 내놓지 않는다');
  assert.equal(server.SW_DIR, script.SW_DIR);
});
