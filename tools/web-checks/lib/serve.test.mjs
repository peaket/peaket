// 정적 서버 시험(FE-T36·FE-T40 검사의 도구)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { request } from 'node:http';
import { fileFor, serveStatic, parseServeArgs, DEFAULT_HOST } from './serve.mjs';

test('도구 명령줄: --host가 없으면 PEAKET_SERVE_HOST, 그것도 없으면 127.0.0.1에 붙는다', () => {
  const base = ['--root', 'dist', '--port', '4104'];
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(parseServeArgs(base, {}).host, '127.0.0.1');
  assert.equal(parseServeArgs(base, { PEAKET_SERVE_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(parseServeArgs([...base, '--host', '::'], { PEAKET_SERVE_HOST: '0.0.0.0' }).host, '::');
  assert.equal(parseServeArgs(base, { PEAKET_SERVE_HOST: '' }).host, '127.0.0.1');
  const o = parseServeArgs([...base, '--spa', 'index.html', '--rewrite', '^/q/[^/]+$=shell.html'], {});
  assert.deepEqual([o.root, o.port, o.base, o.spa], ['dist', 4104, '/', 'index.html']);
  assert.deepEqual(o.rewrites.map(([re, f]) => [re.test('/q/evt-1'), re.test('/q/a/b'), f]), [[true, false, 'shell.html']]);
  const q = parseServeArgs(['--root', 'd', '--port', '1', '--preset', 'queue-room'], {});
  assert.equal(q.base, '/_q/');
  assert.equal(q.rewrites.length, 5);
  assert.deepEqual(q.rewrites.map(([re, f]) => [re.test('/en/queue/e1') ? f : null, re.test('/ja/queue/e1') ? f : null, re.test('/zh/queue/e1') ? f : null]).filter((x) => x.some(Boolean)), [
    ['shell.en.html', null, null],
    [null, 'shell.ja.html', null],
    [null, null, 'shell.zh.html'],
  ]);
  assert.throws(() => parseServeArgs(['--port', '1'], {}), /쓰는 법/);
  assert.throws(() => parseServeArgs(['--root', 'd', '--port', '1', '--preset', 'nope'], {}), /preset/);
  assert.throws(() => parseServeArgs(['--root', 'd', '--port', 'x'], {}), /port/);
  // 캐시 머리글: 기본은 no-store, --cache-control로 바꾼다(좌석맵 PoC가 HTTP 캐시 길을 잰다)
  assert.equal(parseServeArgs(base, {}).cacheControl, 'no-store');
  assert.equal(parseServeArgs([...base, '--cache-control', 'max-age=600'], {}).cacheControl, 'max-age=600');
});

/** 시험이 실패해도 서버가 남아 시험 실행기를 붙잡지 않게 끝에 닫는다 */
const closeAll = (servers) => Promise.all(servers.map((s) => new Promise((ok) => (s.closeAllConnections(), s.close(ok)))));

test('도구 cacheControl 옵션이 Cache-Control 머리글이 된다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-checks-'));
  const servers = [];
  try {
    writeFileSync(join(root, 'a.json'), '{}');
    const s1 = await serveStatic({ root, port: 0 });
    servers.push(s1);
    const s2 = await serveStatic({ root, port: 0, cacheControl: 'max-age=600' });
    servers.push(s2);
    assert.equal((await fetch(`http://127.0.0.1:${s1.address().port}/a.json`)).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}/a.json`)).headers.get('cache-control'), 'max-age=600');
  } finally {
    await closeAll(servers);
    rmSync(root, { recursive: true, force: true });
  }
});

test('도구 미리 압축한 <파일>.br은 Accept-Encoding에 br이 있을 때만 Content-Encoding: br로 준다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-checks-'));
  const servers = [];
  try {
    const json = JSON.stringify({ a: 'x'.repeat(2000) });
    writeFileSync(join(root, 'layout.json'), json);
    writeFileSync(join(root, 'layout.json.br'), brotliCompressSync(json));
    writeFileSync(join(root, 'plain.css'), '.a{}');
    const server = await serveStatic({ root, port: 0 });
    servers.push(server);
    const { port } = server.address();
    // fetch는 받은 br을 스스로 풀어 버리므로 http.request로 날 바이트와 머리글을 본다
    const raw = (path, enc) =>
      new Promise((ok, no) => {
        const req = request({ host: '127.0.0.1', port, path, headers: enc ? { 'accept-encoding': enc } : {} }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', no);
        req.end();
      });
    const br = await raw('/layout.json', 'gzip, deflate, br');
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(br.headers.vary ?? '', /accept-encoding/i);
    assert.deepEqual(br.body, brotliCompressSync(json));
    const plain = await raw('/layout.json', 'gzip');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), json);
    assert.equal((await raw('/layout.json')).body.toString(), json);
    // br 짝이 없는 파일은 그대로, q=0은 받지 않는다는 뜻이다
    assert.equal((await raw('/plain.css', 'br')).headers['content-encoding'], undefined);
    assert.equal((await raw('/layout.json', 'br;q=0, gzip')).headers['content-encoding'], undefined);
    // .br 파일을 직접 달라고 하면 그 파일을 그대로 준다
    assert.equal((await raw('/layout.json.br')).status, 200);
  } finally {
    await closeAll(servers);
    rmSync(root, { recursive: true, force: true });
  }
});

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
