// tools.mjs(고정 판 도구 받기) 시험. 실행: node --test "tools/local/*.test.mjs"
// 네트워크를 쓰지 않는다: 받기 함수를 바꿔 끼운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureTool, pickAsset, TOOLS } from './tools.mjs';

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
