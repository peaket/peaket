// 정적 서버 시험(FE-T36·FE-T40 검사의 도구)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileFor, serveStatic } from './serve.mjs';

test('도구 주소를 폴더 안 파일로 바꾸고 폴더 밖으로는 나가지 않는다', () => {
  const root = resolve('/srv/app');
  assert.equal(fileFor(root, '/a/b.css'), resolve(root, 'a/b.css'));
  assert.equal(fileFor(root, '/'), resolve(root, 'index.html'));
  assert.equal(fileFor(root, '/_q/assets/x.js', '/_q/'), resolve(root, 'assets/x.js'));
  assert.equal(fileFor(root, '/../etc/passwd'), null);
  assert.equal(fileFor(root, '/%2e%2e/etc/passwd'), null);
  assert.equal(fileFor(root, '/%E0%A4%A'), null);
});

test('도구 바꿔 읽기·단일 페이지 대체·없는 파일 404를 한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-checks-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'shell.html'), '<p>셸</p>');
    writeFileSync(join(root, 'index.html'), '<p>앱</p>');
    writeFileSync(join(root, 'assets', 'a.css'), '.a{}');
    const server = await serveStatic({ root, port: 0, rewrites: [[/^\/queue\/[^/]+$/, 'shell.html']], spa: 'index.html' });
    const { port } = server.address();
    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      return [r.status, r.headers.get('content-type'), await r.text()];
    };
    assert.deepEqual(await get('/queue/evt-1?state=x'), [200, 'text/html; charset=utf-8', '<p>셸</p>']);
    assert.deepEqual(await get('/assets/a.css'), [200, 'text/css; charset=utf-8', '.a{}']);
    assert.deepEqual(await get('/some/route'), [200, 'text/html; charset=utf-8', '<p>앱</p>']);
    const noSpa = await serveStatic({ root, port: 0 });
    const r = await fetch(`http://127.0.0.1:${noSpa.address().port}/nope.css`);
    assert.equal(r.status, 404);
    await new Promise((ok) => server.close(ok));
    await new Promise((ok) => noSpa.close(ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
