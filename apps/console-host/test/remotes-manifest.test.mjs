// 원격 목록 만들기·원격 산출물 검사 시험(F-03-2 OPS-350 T9). 정본: docs/frontend.md §4.5 'remotes.json'(그 바이트의 sha384, entry 정식 주소,
// contractMajor는 계약 패키지 판의 큰 수), §5.8 관제 줄 '원격마다 80KB [가정]'·도구 칸(remotes-manifest.mjs --check, node:zlib), ADR-0361 결정 2·3·7·12.
// integrity는 스크립트와 따로 Web Crypto(subtle.digest('SHA-384'))로 계산해 견준다. 산출물은 임시 폴더에 만든다(실제 운영 빌드 산출물은
// tools/web-checks/console-remotes/build.spec.mjs가 본다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkRemote, manifestEntries, remoteSha } from '../scripts/remotes-manifest.mjs';

const contractMajor = Number(JSON.parse(readFileSync(new URL('../../../packages/console-contract/package.json', import.meta.url), 'utf8')).version.split('.')[0]);

/** 임시 dist: 원격마다 <sha>/remoteEntry.js(와 더 넣을 파일) */
function dist(remotes) {
  const root = mkdtempSync(path.join(tmpdir(), 'peaket-remotes-'));
  for (const [name, { sha, bytes, extra = {} }] of Object.entries(remotes)) {
    const dir = path.join(root, 'remotes', name, sha);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'remoteEntry.js'), bytes);
    for (const [f, b] of Object.entries(extra)) writeFileSync(path.join(dir, f), b);
  }
  return root;
}

const sri = async (bytes) => `sha384-${Buffer.from(await crypto.subtle.digest('SHA-384', bytes)).toString('base64')}`;

test('F-03-2 T9 ① 목록 항목의 integrity가 그 바이트를 따로 계산한 sha384와 같고 entry는 정식 주소, contractMajor는 계약 패키지 판의 큰 수다', async (t) => {
  const qb = Buffer.from('self.peaket_widget_queue={get(){},init(){}};');
  const pb = randomBytes(2048);
  const root = dist({ queue: { sha: 'abcdef012345', bytes: qb }, purchase: { sha: '0123456789ab', bytes: pb } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entries = manifestEntries({ dist: root });
  assert.deepEqual(entries, [
    { name: 'purchase', sha: '0123456789ab', entry: '/remotes/purchase/0123456789ab/remoteEntry.js', integrity: await sri(pb), contractMajor },
    { name: 'queue', sha: 'abcdef012345', entry: '/remotes/queue/abcdef012345/remoteEntry.js', integrity: await sri(qb), contractMajor },
  ]);
  assert.equal(contractMajor >= 1, true);
  // 한 바이트만 바뀌어도 값이 달라진다
  const changed = Buffer.from(qb);
  changed[0] ^= 1;
  assert.notEqual(await sri(changed), entries[1].integrity);
});

test('F-03-2 T9 ② 산출물 검사: 한 파일·gzip 상한 안·공유 싱글턴 사본 없음이면 문제가 없고, 어기면 그것을 적는다', (t) => {
  const ok = dist({ queue: { sha: 'abcdef012345', bytes: Buffer.from('self.peaket_widget_queue={};') } });
  const twoFiles = dist({ queue: { sha: 'abcdef012345', bytes: Buffer.from('x'), extra: { 'w-queue.chunk.js': 'y' } } });
  // 압축이 안 되는 81KB(정본 상한 80KB [가정] = 80,000바이트를 넘는다)
  const big = dist({ queue: { sha: 'abcdef012345', bytes: randomBytes(81_000) } });
  const withReact = dist({ queue: { sha: 'abcdef012345', bytes: Buffer.from('var x="__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";') } });
  const twoShas = dist({ queue: { sha: 'abcdef012345', bytes: Buffer.from('a') } });
  mkdirSync(path.join(twoShas, 'remotes/queue/fedcba543210'), { recursive: true });
  writeFileSync(path.join(twoShas, 'remotes/queue/fedcba543210/remoteEntry.js'), 'b');
  t.after(() => [ok, twoFiles, big, withReact, twoShas].forEach((d) => rmSync(d, { recursive: true, force: true })));
  assert.deepEqual(checkRemote(ok, 'queue'), []);
  assert.equal(checkRemote(twoFiles, 'queue').length, 1);
  assert.match(checkRemote(twoFiles, 'queue')[0], /한 파일/);
  assert.equal(checkRemote(big, 'queue').length, 1);
  assert.match(checkRemote(big, 'queue')[0], /gzip/);
  assert.deepEqual(checkRemote(big, 'queue', { maxGzip: 90_000 }), []);
  assert.match(checkRemote(withReact, 'queue').join('\n'), /react 사본/);
  assert.match(checkRemote(twoShas, 'queue').join('\n'), /sha 폴더가 하나가 아니다/);
  assert.throws(() => manifestEntries({ dist: twoShas }), /sha 폴더가 하나가 아니다/);
});

test('F-03-2 T9 ③ 원격 경로의 sha는 주어진 커밋(PEAKET_REMOTE_SHA → GITHUB_SHA) 앞 12자이고 꼴이 틀리면 멈춘다', () => {
  assert.equal(remoteSha('queue', { PEAKET_REMOTE_SHA: '0123456789abcdef0123456789abcdef01234567' }), '0123456789ab');
  assert.equal(remoteSha('queue', { GITHUB_SHA: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }), 'abcdef012345');
  assert.equal(remoteSha('queue', { PEAKET_REMOTE_SHA: 'a1b2c3d', GITHUB_SHA: 'ffffffffffffffff' }), 'a1b2c3d');
  assert.throws(() => remoteSha('queue', { PEAKET_REMOTE_SHA: '../x' }), TypeError);
  // 주어진 값이 없을 때(git·원천 해시)는 자식 프로세스(git)를 부르므로 단위 시험에서 보지 않는다(TA-V08). 운영 빌드 경로는 build.spec.mjs가 본다
});
