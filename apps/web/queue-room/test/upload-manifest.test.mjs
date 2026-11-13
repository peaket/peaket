// S3 `/_q/` 업로드 목록 시험(docs/frontend.md §2.5·§5.1, docs/devops.md §6.6, HOT-370).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheControlFor, uploadManifest } from '../scripts/upload-manifest.mjs';

test('HOT-370 셸은 no-cache, 해시 자산만 1년 immutable, 소스 맵·preview는 올리지 않는다', () => {
  assert.equal(cacheControlFor('shell.ko.html'), 'public, max-age=0, must-revalidate');
  assert.equal(cacheControlFor('shell.en.html'), 'public, max-age=0, must-revalidate');
  assert.equal(cacheControlFor('assets/queue-room.abc123.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('assets/queue-room.abc123.css'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('preview.html'), null);
  assert.equal(cacheControlFor('assets/queue-room.abc123.js.map'), null);
});

test('HOT-370 dist의 올릴 파일만 `/_q/` 키로 만든다', () => {
  const root = mkdtempSync(join(tmpdir(), 'peaket-queue-manifest-'));
  try {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'shell.ko.html'), 'ko');
    writeFileSync(join(root, 'shell.en.html'), 'en');
    writeFileSync(join(root, 'shell.ja.html'), 'ja');
    writeFileSync(join(root, 'shell.zh.html'), 'zh');
    writeFileSync(join(root, 'preview.html'), 'dev only');
    writeFileSync(join(root, 'assets', 'queue-room.abc.js'), 'js');
    writeFileSync(join(root, 'assets', 'queue-room.abc.js.map'), '{}');
    const files = uploadManifest(root);
    assert.deepEqual(files.map((f) => f.key), [
      '/_q/assets/queue-room.abc.js',
      '/_q/shell.en.html',
      '/_q/shell.ja.html',
      '/_q/shell.ko.html',
      '/_q/shell.zh.html',
    ]);
    assert.equal(files[0].cacheControl, 'public, max-age=31536000, immutable');
    assert.ok(files.slice(1).every((f) => f.cacheControl === 'public, max-age=0, must-revalidate'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
