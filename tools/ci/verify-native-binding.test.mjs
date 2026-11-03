// 미리 빌드한 네이티브 바인딩 대조(tools/ci/verify-native-binding.mjs) 시험(docs/devops.md §4.4, ADR-0176 결정 5, BUILD_ORDER BSL-050).
// 실제 GitHub 릴리스는 받지 않는다: 시스템 tar로 만든 가짜 묶음과 가짜 fetch, 시험용 고정 표로 본다. 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { BindingError, PINNED_BINDINGS, VERIFIED_PACKAGES, bindingTarget, currentRuntime, findPackageDirs, pinnedDigest, verifyBinding } from './verify-native-binding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const script = join(HERE, 'verify-native-binding.mjs');
const NAME = '@confluentinc/kafka-javascript';
// @confluentinc/kafka-javascript 1.11.0 package.json의 binary 칸 그대로(설치된 파일과 같은지는 아래 시험이 본다)
const BINARY = {
  module_name: 'confluent-kafka-javascript',
  module_path: './build/{configuration}/',
  package_name: '{module_name}-v{version}-{node_abi}-{platform}-{libc}-{arch}.tar.gz',
  host: 'https://github.com/confluentinc/confluent-kafka-javascript/releases/download/',
  remote_path: 'v{version}',
};
const X64 = { nodeAbi: 'node-v137', platform: 'linux', libc: 'glibc', arch: 'x64' };
const ARM64 = { ...X64, arch: 'arm64' };
const TARBALL_X64 = 'confluent-kafka-javascript-v1.11.0-node-v137-linux-glibc-x64.tar.gz';
const URL_X64 = `https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.11.0/${TARBALL_X64}`;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** 저장소에 설치된 1.11.0의 package.json(pnpm install 전이면 null) */
function installedPackageJson() {
  const pnpm = join(REPO, 'node_modules', '.pnpm');
  if (!existsSync(pnpm)) return null;
  const d = readdirSync(pnpm).find((n) => n.startsWith('@confluentinc+kafka-javascript@1.11.0'));
  const file = d && join(pnpm, d, 'node_modules', '@confluentinc', 'kafka-javascript', 'package.json');
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
const INSTALLED = installedPackageJson();

/** 폴더에 파일들을 쓴다 */
function writeTree(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

// 묶음 안의 파일(node-pre-gyp 묶음처럼 Release/ 아래). 설치 스크립트가 build/ 아래에 푼다
const TAR_FILES = {
  'Release/confluent-kafka-javascript.node': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2000, 7)]),
  'Release/.deps/x.d': 'cmd_Release/obj.target/confluent-kafka-javascript.node := g++ -shared\n',
};

let tarball;
/** 시스템 tar(리눅스 GNU tar, Windows bsdtar)로 만든 가짜 묶음(.tar.gz) 바이트 */
function fakeTarball() {
  if (tarball) return tarball;
  const dir = writeTree(tempDir('vnb-tar-'), TAR_FILES);
  // 드라이브 문자(C:)를 원격 주소로 읽는 tar가 있어 상대 경로만 준다
  const r = spawnSync('tar', ['-czf', 'binding.tar.gz', 'Release'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  tarball = readFileSync(join(dir, 'binding.tar.gz'));
  return tarball;
}
const pinnedFor = (bytes, key = 'node-v137-linux-glibc-x64') => ({ [NAME]: { '1.11.0': { [key]: `sha256:${sha256(bytes)}` } } });

/** 설치가 끝난 패키지 폴더: package.json과 build/ 아래의 묶음 파일 */
function installedDir(extra = {}) {
  const files = { 'package.json': JSON.stringify({ name: NAME, version: '1.11.0', binary: BINARY }) };
  for (const [p, c] of Object.entries(TAR_FILES)) files[`build/${p}`] = c;
  return writeTree(tempDir('vnb-pkg-'), { ...files, ...extra });
}

/** 묶음 바이트를 돌려주는 가짜 fetch. 부른 주소를 calls에 남긴다 */
function fakeFetch(bytes, status = 200) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    return new Response(status === 200 ? bytes : 'not found', { status });
  };
  f.calls = calls;
  return f;
}
const options = (o) => ({ runtime: X64, tmpDir: tempDir('vnb-work-'), ...o });

test('BSL050_묶음이름·주소·표열쇠는_설치된1.11.0의binary설정틀을채운다', { skip: !INSTALLED && '저장소에 @confluentinc/kafka-javascript 1.11.0이 설치돼 있지 않다(pnpm install 전)' }, () => {
  assert.deepEqual(INSTALLED.binary, BINARY, '설치된 패키지의 binary 칸이 시험의 틀과 같다');
  const pkg = { name: INSTALLED.name, version: INSTALLED.version, binary: INSTALLED.binary };
  assert.deepEqual(bindingTarget(pkg, X64), { tarball: TARBALL_X64, url: URL_X64, key: 'node-v137-linux-glibc-x64', modulePath: './build/Release/' });
});

test('BSL050_묶음이름_arm64도_같은틀로채운다', () => {
  const t = bindingTarget({ name: NAME, version: '1.11.0', binary: BINARY }, ARM64);
  assert.equal(t.tarball, 'confluent-kafka-javascript-v1.11.0-node-v137-linux-glibc-arm64.tar.gz');
  assert.equal(t.url, `https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.11.0/${t.tarball}`);
  assert.equal(t.key, 'node-v137-linux-glibc-arm64');
  assert.equal(t.modulePath, './build/Release/');
  // 판이 바뀌면 이름·주소가 따라 바뀐다
  const next = bindingTarget({ name: NAME, version: '1.12.0', binary: BINARY }, X64);
  assert.equal(next.url, 'https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.12.0/confluent-kafka-javascript-v1.12.0-node-v137-linux-glibc-x64.tar.gz');
});

test('BSL050_지금런타임_Node_ABI·플랫폼·아키텍처·libc', () => {
  const r = currentRuntime();
  assert.equal(r.nodeAbi, `node-v${process.versions.modules}`);
  assert.equal(r.platform, process.platform);
  assert.equal(r.arch, process.arch);
  if (process.platform === 'linux') {
    const glibc = process.report.getReport().header.glibcVersionRuntime;
    assert.equal(r.libc, glibc ? 'glibc' : 'musl');
  }
});

test('BSL050_고정표_두다이제스트를돌려주고_패키지·판·열쇠가없으면BindingError', () => {
  assert.ok(VERIFIED_PACKAGES.includes(NAME));
  assert.equal(pinnedDigest(NAME, '1.11.0', 'node-v137-linux-glibc-x64'), 'sha256:56b443c9339cb0ae423588599af1df7636eb426c1ac93bf54906e52a0ee77699');
  assert.equal(pinnedDigest(NAME, '1.11.0', 'node-v137-linux-glibc-arm64'), 'sha256:8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384');
  assert.equal(pinnedDigest(NAME, '1.11.0', 'node-v137-linux-glibc-arm64', PINNED_BINDINGS), PINNED_BINDINGS[NAME]['1.11.0']['node-v137-linux-glibc-arm64']);
  for (const [name, version, key] of [
    ['@confluentinc/other', '1.11.0', 'node-v137-linux-glibc-x64'],
    [NAME, '1.12.0', 'node-v137-linux-glibc-x64'],
    [NAME, '1.11.0', 'node-v137-linux-musl-x64'],
    [NAME, '1.11.0', 'node-v127-linux-glibc-x64'],
    [NAME, '1.11.0', 'node-v137-win32-unknown-x64'],
  ]) {
    assert.throws(() => pinnedDigest(name, version, key), BindingError, `${name} ${version} ${key}`);
  }
  // 넘긴 표에서 고른다
  assert.equal(pinnedDigest(NAME, '9.9.9', 'k', { [NAME]: { '9.9.9': { k: `sha256:${'c'.repeat(64)}` } } }), `sha256:${'c'.repeat(64)}`);
});

test('BSL050_패키지찾기_.pnpm아래와_직접node_modules를_실제경로로한번씩찾고_고리링크에서멈춘다', { timeout: 30_000 }, () => {
  const root = tempDir('vnb-find-');
  const pkgJson = JSON.stringify({ name: NAME, version: '1.11.0', binary: BINARY });
  const inPnpm = join(root, 'node_modules', '.pnpm', '@confluentinc+kafka-javascript@1.11.0_supports-color@8.1.1', 'node_modules', '@confluentinc', 'kafka-javascript');
  const direct = join(root, 'node_modules', '@confluentinc', 'kafka-javascript');
  writeTree(inPnpm, { 'package.json': pkgJson, 'build/Release/confluent-kafka-javascript.node': 'x' });
  writeTree(direct, { 'package.json': pkgJson });
  // 이름이 비슷한 다른 패키지
  writeTree(join(root, 'node_modules', '@confluentinc', 'kafka-javascript-extra'), { 'package.json': '{"name":"@confluentinc/kafka-javascript-extra"}' });
  writeTree(join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'other'), { 'package.json': '{"name":"other"}' });
  // pnpm이 끌어올린 링크(같은 실제 폴더를 한 번 더 가리킨다)와, 뿌리로 되돌아가는 고리
  mkdirSync(join(root, 'node_modules', '.pnpm', 'node_modules', '@confluentinc'), { recursive: true });
  symlinkSync(inPnpm, join(root, 'node_modules', '.pnpm', 'node_modules', '@confluentinc', 'kafka-javascript'), 'junction');
  symlinkSync(join(root, 'node_modules'), join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'other', 'node_modules'), 'junction');

  const found = findPackageDirs(root, NAME);
  assert.equal(new Set(found).size, found.length, '겹치지 않는다');
  assert.deepEqual(found.map((p) => realpathSync(p)).sort(), [realpathSync(inPnpm), realpathSync(direct)].sort());
  assert.deepEqual(found.slice().sort(), found.map((p) => realpathSync(p)).sort(), '실제 경로로 돌려준다');
  // 패키지가 없는 뿌리
  assert.deepEqual(findPackageDirs(tempDir('vnb-empty-'), NAME), []);
});

test('BSL050_대조_다시받은묶음의다이제스트와_묶음파일이모두설치된파일과같으면통과한다', async () => {
  const bytes = fakeTarball();
  const fetch = fakeFetch(bytes);
  const result = await verifyBinding(installedDir(), options({ fetch, pinned: pinnedFor(bytes) }));
  assert.deepEqual(result, { tarball: TARBALL_X64, digest: `sha256:${sha256(bytes)}`, files: 2 });
  // 그 판·런타임으로 만든 주소에서 한 번 받는다
  assert.deepEqual(fetch.calls, [URL_X64]);
});

test('BSL050_대조_설치된build아래의_.node가아닌다른파일은_묶음에없어도통과한다', async () => {
  const bytes = fakeTarball();
  const dir = installedDir({ 'build/config.gypi': '{}\n', 'build/Release/obj.target/x.o': 'o', 'build/Makefile': 'all:\n' });
  const result = await verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) }));
  assert.equal(result.files, 2);
});

test('BSL050_대조_다시받은묶음이고정다이제스트와다르면실패한다', async () => {
  const bytes = fakeTarball();
  await assert.rejects(verifyBinding(installedDir(), options({ fetch: fakeFetch(bytes), pinned: { [NAME]: { '1.11.0': { 'node-v137-linux-glibc-x64': `sha256:${'0'.repeat(64)}` } } } })), BindingError);
  // 진짜 고정 표(실제 GitHub 릴리스의 다이제스트)와도 가짜 묶음은 맞지 않는다
  await assert.rejects(verifyBinding(installedDir(), options({ fetch: fakeFetch(bytes) })), BindingError);
});

test('BSL050_대조_고정표에없는판·런타임이면_받지도않고실패한다', async () => {
  const bytes = fakeTarball();
  for (const [pinned, runtime] of [
    [{}, X64],
    [pinnedFor(bytes), ARM64],
    [pinnedFor(bytes), { ...X64, libc: 'musl' }],
    [{ [NAME]: { '1.10.0': { 'node-v137-linux-glibc-x64': `sha256:${sha256(bytes)}` } } }, X64],
  ]) {
    const fetch = fakeFetch(bytes);
    await assert.rejects(verifyBinding(installedDir(), options({ fetch, pinned, runtime })), BindingError);
    assert.deepEqual(fetch.calls, [], '표에 없으면 받지 않는다');
  }
});

test('BSL050_대조_묶음받기가실패하면실패한다', async () => {
  const bytes = fakeTarball();
  for (const status of [404, 500]) {
    await assert.rejects(verifyBinding(installedDir(), options({ fetch: fakeFetch(bytes, status), pinned: pinnedFor(bytes) })), BindingError, String(status));
  }
  const throwing = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(verifyBinding(installedDir(), options({ fetch: throwing, pinned: pinnedFor(bytes) })), BindingError);
});

test('BSL050_대조_설치된파일이묶음과다르거나빠지면실패한다', async () => {
  const bytes = fakeTarball();
  const changed = installedDir({ 'build/Release/confluent-kafka-javascript.node': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2000, 8)]) });
  await assert.rejects(verifyBinding(changed, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), BindingError, '내용이 다른 .node');
  const missing = installedDir();
  unlinkSync(join(missing, 'build', 'Release', '.deps', 'x.d'));
  await assert.rejects(verifyBinding(missing, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), BindingError, '묶음의 파일이 설치돼 있지 않다');
});

test('BSL050_대조_묶음에없는.node파일이설치돼있으면실패한다', async () => {
  const bytes = fakeTarball();
  for (const extra of ['build/Release/extra.node', 'build/Release/obj.target/other.node', 'build/Debug/confluent-kafka-javascript.node']) {
    const dir = installedDir({ [extra]: 'not in tarball' });
    await assert.rejects(verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), BindingError, extra);
  }
});

test('BSL050_명령줄_--expect면패키지가하나도없을때실패하고_없으면알리고통과한다', () => {
  const root = tempDir('vnb-cli-');
  const expect = spawnSync(process.execPath, [script, root, '--expect'], { encoding: 'utf8' });
  assert.notEqual(expect.status, 0, expect.stdout + expect.stderr);
  assert.notEqual(expect.status, null);
  const plain = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.ok((plain.stdout + plain.stderr).trim().length > 0, '찾지 못했다는 말을 남긴다');
});

test('BSL050_대조_묶음의.node가아닌파일도_내용이다르면실패한다', async () => {
  const bytes = fakeTarball();
  // 묶음의 .deps/x.d가 설치된 것과 다르다(있기만 보고 내용을 견주지 않는 대조를 잡는다)
  const dir = installedDir({ 'build/Release/.deps/x.d': 'cmd_Release := 바뀐 내용\n' });
  await assert.rejects(verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), BindingError);
});

test('BSL050_대조_판과주소는_설치된패키지의package.json을따른다', async () => {
  const bytes = fakeTarball();
  // 판 1.10.0, 다른 내려받기 주소로 설치된 패키지: 표 열쇠·묶음 이름·주소가 모두 그 package.json에서 온다
  const binary = { ...BINARY, host: 'https://mirror.example.invalid/dl/' };
  const dir = installedDir({ 'package.json': JSON.stringify({ name: NAME, version: '1.10.0', binary }) });
  const fetch = fakeFetch(bytes);
  const result = await verifyBinding(dir, options({ fetch, pinned: { [NAME]: { '1.10.0': { 'node-v137-linux-glibc-x64': `sha256:${sha256(bytes)}` } } } }));
  const tarballName = 'confluent-kafka-javascript-v1.10.0-node-v137-linux-glibc-x64.tar.gz';
  assert.deepEqual(result, { tarball: tarballName, digest: `sha256:${sha256(bytes)}`, files: 2 });
  assert.deepEqual(fetch.calls, [`https://mirror.example.invalid/dl/v1.10.0/${tarballName}`]);
  // 같은 패키지를 1.11.0 표로 보면 표에 없어 받지 않고 실패한다
  const again = fakeFetch(bytes);
  await assert.rejects(verifyBinding(dir, options({ fetch: again, pinned: pinnedFor(bytes) })), BindingError);
  assert.deepEqual(again.calls, []);
});

test('BSL050_명령줄_찾은패키지가대조에실패하면_받지않고실패한다', { timeout: 60_000 }, () => {
  // 고정 표에 없는 판(9.9.9)이 설치된 뿌리: 표를 먼저 보므로 네트워크 없이 실패한다
  const root = tempDir('vnb-cli-bad-');
  writeTree(join(root, 'node_modules', '@confluentinc', 'kafka-javascript'), {
    'package.json': JSON.stringify({ name: NAME, version: '9.9.9', binary: BINARY }),
    'build/Release/confluent-kafka-javascript.node': 'x',
  });
  for (const args of [[root], [root, '--expect']]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 50_000 });
    assert.notEqual(r.status, null, `시간 안에 끝난다: ${args.join(' ')}`);
    assert.notEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /9\.9\.9/, '무엇이 틀렸는지(판) 남긴다');
  }
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 낮음-4): build/ 밖의 .node와 심볼릭 링크 .node를 보지 않았다.
// 바인딩을 부르는 bindings 패키지는 build/Release 말고도 build/, build/Debug/, out/, Release/, compiled/ 같은 곳을 먼저 찾으므로
// 대조를 통과해도 다른 파일이 실릴 수 있었다. 패키지 폴더 안(아래 node_modules 빼고)의 .node는 모두 묶음에서 온 것이어야 한다
test('BSL050_대조_build밖의_.node가있으면_실패한다(재현)', async () => {
  const bytes = fakeTarball();
  for (const extra of ['Release/confluent-kafka-javascript.node', 'out/Release/confluent-kafka-javascript.node', 'compiled/24.18.0/linux/x64/confluent-kafka-javascript.node']) {
    const dir = installedDir({ [extra]: 'other binary' });
    await assert.rejects(verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), (err) => err instanceof BindingError && err.message.includes(extra), extra);
  }
});

test('BSL050_대조_심볼릭링크.node가있으면_실패한다(재현)', async (t) => {
  const bytes = fakeTarball();
  const dir = installedDir();
  mkdirSync(join(dir, 'build', 'Debug'), { recursive: true });
  const link = join(dir, 'build', 'Debug', 'confluent-kafka-javascript.node');
  try {
    symlinkSync(join(dir, 'build', 'Release', 'confluent-kafka-javascript.node'), link, 'file');
  } catch {
    t.skip('이 PC에서 파일 심볼릭 링크를 만들 수 없다(Windows 개발자 모드 없음)');
    return;
  }
  await assert.rejects(verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) })), (err) => err instanceof BindingError && /심볼릭 링크/.test(err.message));
});

test('BSL050_대조_패키지안의node_modules아래.node는_그패키지의몫이라_보지않는다', async () => {
  const bytes = fakeTarball();
  const dir = installedDir({ 'node_modules/other/build/Release/other.node': 'other package binary' });
  const r = await verifyBinding(dir, options({ fetch: fakeFetch(bytes), pinned: pinnedFor(bytes) }));
  assert.equal(r.files, Object.keys(TAR_FILES).length);
});
