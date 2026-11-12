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

test('[ASVS v5.0.0-13.4.1] standalone 폴더에 .next/static과 public을 복사한다', () => {
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
