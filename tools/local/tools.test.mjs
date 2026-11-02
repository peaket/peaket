// tools.mjs(고정 판 도구 받기) 시험. 실행: node --test "tools/local/*.test.mjs"
// 네트워크를 쓰지 않는다: 받기 함수를 바꿔 끼운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureTool, httpsDownload, pickAsset, TOOLS } from './tools.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dir = () => mkdtempSync(join(tmpdir(), 'peaket-tools-'));

test('FND110_도구표_세도구_모든_플랫폼에_주소와_해시가_있다', () => {
  for (const name of ['kind', 'kubectl', 'helm']) {
    for (const p of ['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64']) {
      const a = TOOLS[name].assets[p];
      assert.ok(a, `${name} ${p}`);
      assert.match(a.url, /^https:\/\//);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test('FND110_플랫폼_고르기_지원하지_않는_조합은_이유와_함께_거절한다', () => {
  assert.equal(pickAsset('kind', 'linux', 'x64').url.endsWith('kind-linux-amd64'), true);
  assert.equal(pickAsset('kubectl', 'win32', 'x64').url.endsWith('/windows/amd64/kubectl.exe'), true);
  assert.equal(pickAsset('helm', 'darwin', 'arm64').archive, 'tar.gz');
  assert.throws(() => pickAsset('kind', 'freebsd', 'x64'), /지원하지 않는 플랫폼/);
  assert.throws(() => pickAsset('nope', 'linux', 'x64'), /모르는 도구/);
});

test('FND110_받은_파일의_해시가_다르면_쓰지_않고_실패한다', async () => {
  const root = dir();
  const bytes = Buffer.from('tampered');
  const tools = { kind: { version: 'v0', bin: 'kind', assets: { 'linux-x64': { url: 'https://example.invalid/kind', sha256: sha(Buffer.from('original')) } } } };
  await assert.rejects(
    ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download: async () => bytes }),
    /해시가 맞지 않는다/,
  );
  assert.equal(existsSync(join(root, 'kind-v0', 'kind')), false);
});

test('FND110_해시가_맞으면_실행_파일로_두고_다음에는_받지_않는다', async () => {
  const root = dir();
  const bytes = Buffer.from('#!/bin/sh\necho ok\n');
  const tools = { kind: { version: 'v0', bin: 'kind', assets: { 'linux-x64': { url: 'https://example.invalid/kind', sha256: sha(bytes) } } } };
  let calls = 0;
  const download = async () => {
    calls += 1;
    return bytes;
  };
  const p1 = await ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download });
  const p2 = await ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download });
  assert.equal(p1, p2);
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(p1), bytes);
});

test('FND110_받아_둔_파일이_바뀌었으면_다시_받는다', async () => {
  const root = dir();
  const bytes = Buffer.from('good');
  const tools = { kind: { version: 'v0', bin: 'kind', assets: { 'linux-x64': { url: 'https://example.invalid/kind', sha256: sha(bytes) } } } };
  let calls = 0;
  const download = async () => {
    calls += 1;
    return bytes;
  };
  const p = await ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download });
  writeFileSync(p, 'changed');
  await ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download });
  assert.equal(calls, 2);
  assert.deepEqual(readFileSync(p), bytes);
});

test('FND110_https가_아닌_주소는_받지_않는다', async () => {
  const root = dir();
  const tools = { kind: { version: 'v0', bin: 'kind', assets: { 'linux-x64': { url: 'http://example.invalid/kind', sha256: 'a'.repeat(64) } } } };
  await assert.rejects(ensureTool('kind', { root, tools, platform: 'linux', arch: 'x64', download: async () => Buffer.alloc(0) }), /https/);
});

test('FND110_압축으로받는도구는_받아둔실행파일을_옆파일이아니라표에고정한해시와견준다', async () => {
  // 재현(코드 리뷰): 받아 둔 helm은 스스로 적은 .sha256 옆 파일과 견줘, 실행 파일과 옆 파일을 함께 바꾸면 그대로 썼다
  for (const [p, a] of Object.entries(TOOLS.helm.assets)) assert.match(a.innerSha256 ?? '', /^[0-9a-f]{64}$/, p);
  const root = dir();
  const good = Buffer.from('real-helm');
  const evil = Buffer.from('evil-helm');
  const tools = {
    helm: { version: 'v0', bin: 'helm', assets: { 'linux-x64': { url: 'https://example.invalid/h.tar.gz', archive: 'tar.gz', inner: 'linux-amd64/helm', sha256: sha(Buffer.from('archive')), innerSha256: sha(good) } } },
  };
  const exe = join(root, 'helm-v0', 'helm');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'helm-v0'), { recursive: true });
  writeFileSync(exe, evil);
  writeFileSync(`${exe}.sha256`, sha(evil));
  let calls = 0;
  // 다시 받으려 하면(옆 파일을 믿지 않으면) 받기를 부른다. 여기서는 틀린 압축을 돌려 실패로 끝낸다
  await assert.rejects(ensureTool('helm', { root, tools, platform: 'linux', arch: 'x64', download: async () => (calls++, Buffer.from('x')) }), /해시가 맞지 않는다/);
  assert.equal(calls, 1);
  writeFileSync(exe, good);
  assert.equal(await ensureTool('helm', { root, tools, platform: 'linux', arch: 'x64', download: async () => assert.fail('받지 않아야 한다') }), exe);
});

// 2026-11-03 첫 원격 CI에서 찾음: GitHub 실행기에서 kind 클러스터를 만든 뒤 Strimzi 설치 파일 받기가 세 번 연속
// 0.03초 만에 'fetch failed'(UND_ERR_SOCKET, other side closed)로 끊겼다. 로컬에서는 재현되지 않았다
const socketError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
const okResponse = (text) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const quiet = { log: () => {} };

test('httpsDownload_연결이끊기면_잠깐쉬었다가_다시받는다', async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? Promise.reject(socketError()) : okResponse('abc'));
  const curl = () => assert.fail('curl까지 가지 않아야 한다');
  const bytes = await httpsDownload('https://example.test/a', { ...quiet, fetchImpl, curl, wait: async (ms) => waits.push(ms) });
  assert.equal(bytes.toString(), 'abc');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test('httpsDownload_fetch가모두끊기면_curl로받는다', async () => {
  const waits = [];
  const logs = [];
  const fetchImpl = async () => Promise.reject(socketError());
  const bytes = await httpsDownload('https://example.test/a', { fetchImpl, curl: () => Buffer.from('xyz'), wait: async (ms) => waits.push(ms), log: (m) => logs.push(m) });
  assert.equal(bytes.toString(), 'xyz');
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /UND_ERR_SOCKET/);
});

test('httpsDownload_서버오류(5xx)도_다시받는다', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? { ok: false, status: 503 } : okResponse('ok'));
  assert.equal((await httpsDownload('https://example.test/a', { ...quiet, fetchImpl, wait: async () => {} })).toString(), 'ok');
});

test('httpsDownload_4xx는_다시받지않고_curl도부르지않는다', async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: false, status: 404 });
  await assert.rejects(httpsDownload('https://example.test/a', { ...quiet, fetchImpl, curl: () => assert.fail('curl을 부르지 않아야 한다'), wait: async () => {} }), /HTTP 404/);
  assert.equal(calls, 1);
});

test('httpsDownload_curl도실패하면_둘의까닭을함께적는다', async () => {
  const fetchImpl = async () => Promise.reject(socketError());
  const curl = () => { throw new Error('curl 종료 56'); };
  await assert.rejects(httpsDownload('https://example.test/a', { ...quiet, fetchImpl, curl, wait: async () => {} }), /UND_ERR_SOCKET.*curl 종료 56/s);
});

test('httpsDownload_https주소만받는다', async () => {
  await assert.rejects(httpsDownload('http://example.test/a', { ...quiet, fetchImpl: async () => assert.fail('받지 않아야 한다') }), /https/);
});
