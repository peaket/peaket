// 이미지 스모크(tools/ci/image-smoke.mjs) 시험(docs/devops.md §3.1 build-image.yml ①, D-T32 ①, BUILD_ORDER BSL-050).
// 가짜 .node 파일에는 진짜 process.dlopen을 부르지 않는다(dlopen을 넘겨 본다). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { findNativeModules, smoke } from './image-smoke.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'image-smoke.mjs');

function writeTree(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const KAFKA = join('node_modules', '.pnpm', '@confluentinc+kafka-javascript@1.11.0', 'node_modules', '@confluentinc', 'kafka-javascript');
const OTHER = join('node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'other');

/** pnpm deploy 결과처럼 생긴 /app: .node 둘, .node가 아닌 파일, 끌어올린 링크와 뿌리로 되돌아가는 고리 */
function appRoot() {
  const root = tempDir('smoke-');
  writeTree(root, {
    [join(KAFKA, 'build', 'Release', 'confluent-kafka-javascript.node')]: 'fake',
    [join(KAFKA, 'build', 'Release', '.deps', 'confluent-kafka-javascript.node.d')]: 'deps',
    [join(KAFKA, 'package.json')]: '{}',
    [join(OTHER, 'prebuilds', 'linux-x64', 'other.node')]: 'fake',
    [join(OTHER, 'index.js')]: '',
    [join('dist', 'main.js')]: '',
    'notes.node.txt': '',
  });
  mkdirSync(join(root, 'node_modules', '@confluentinc'), { recursive: true });
  symlinkSync(join(root, KAFKA), join(root, 'node_modules', '@confluentinc', 'kafka-javascript'), 'junction');
  symlinkSync(root, join(root, 'node_modules', 'loop'), 'junction');
  return {
    root,
    expected: [join(root, KAFKA, 'build', 'Release', 'confluent-kafka-javascript.node'), join(root, OTHER, 'prebuilds', 'linux-x64', 'other.node')].map((p) => realpathSync(p)).sort(),
  };
}

test('DT32_네이티브모듈찾기_.pnpm아래.node를모두찾고_링크는따라가지않으며_한번씩만낸다', { timeout: 30_000 }, () => {
  const { root, expected } = appRoot();
  const found = findNativeModules(root);
  assert.equal(new Set(found).size, found.length, '겹치지 않는다');
  assert.deepEqual(found.map((p) => realpathSync(p)).sort(), expected);
  assert.deepEqual(findNativeModules(tempDir('smoke-empty-')), []);
});

test('DT32_스모크_리눅스·기대아키텍처이고_모든.node가열리면통과한다', () => {
  const { root, expected } = appRoot();
  const opened = [];
  const r = smoke({ expectedArch: 'arm64', root, runtime: { platform: 'linux', arch: 'arm64' }, dlopen: (f) => opened.push(f) });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.platform, 'linux');
  assert.equal(r.arch, 'arm64');
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.nativeModules.map((p) => realpathSync(p)).sort(), expected);
  assert.deepEqual(opened.slice().sort(), r.nativeModules.slice().sort(), '찾은 모듈을 모두 연다');
});

test('DT32_스모크_네이티브모듈이없어도_플랫폼과아키텍처가맞으면통과한다', () => {
  const r = smoke({ expectedArch: 'x64', root: tempDir('smoke-none-'), runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => assert.fail('열 모듈이 없다') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.nativeModules, []);
});

test('DT32_스모크_아키텍처가다르거나_리눅스가아니면실패한다', () => {
  const { root } = appRoot();
  const arch = smoke({ expectedArch: 'arm64', root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} });
  assert.equal(arch.ok, false);
  assert.ok(arch.failures.length > 0);
  assert.ok(arch.failures.some((f) => f.includes('x64')), JSON.stringify(arch.failures));
  const os = smoke({ expectedArch: 'arm64', root, runtime: { platform: 'darwin', arch: 'arm64' }, dlopen: () => {} });
  assert.equal(os.ok, false);
  assert.ok(os.failures.some((f) => f.includes('darwin')), JSON.stringify(os.failures));
});

test('DT32_스모크_열리지않는.node가있으면_그파일을실패에적고_나머지도열어본다', () => {
  const { root } = appRoot();
  const opened = [];
  const bad = (f) => f.endsWith('confluent-kafka-javascript.node');
  const r = smoke({
    expectedArch: 'x64',
    root,
    runtime: { platform: 'linux', arch: 'x64' },
    dlopen: (f) => {
      opened.push(f);
      if (bad(f)) throw new Error('wrong ELF class: ELFCLASS32');
    },
  });
  assert.equal(r.ok, false);
  const badFile = r.nativeModules.find(bad);
  assert.ok(badFile);
  assert.ok(r.failures.some((f) => f.includes(badFile)), JSON.stringify(r.failures));
  assert.equal(r.failures.some((f) => f.includes('other.node')), false, '열린 모듈은 실패가 아니다');
  assert.equal(opened.length, 2, '하나가 실패해도 나머지를 연다');
});

test('DT32_스모크_런타임을주지않으면_이프로세스의플랫폼과아키텍처다', () => {
  const r = smoke({ expectedArch: process.arch, root: tempDir('smoke-self-') });
  assert.equal(r.platform, process.platform);
  assert.equal(r.arch, process.arch);
  assert.equal(r.ok, process.platform === 'linux');
});

test('DT32_스모크명령줄_결과를한줄JSON으로찍고_틀리면종료코드1이다', () => {
  const root = tempDir('smoke-cli-');
  const wrong = spawnSync(process.execPath, [script, 'not-an-arch', root], { encoding: 'utf8' });
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  const lines = wrong.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, wrong.stdout);
  const out = JSON.parse(lines[0]);
  assert.equal(out.ok, false);
  assert.ok(Array.isArray(out.failures) && out.failures.length > 0);
  // 이 프로세스의 아키텍처면 리눅스에서만 통과한다(네이티브 모듈 없는 빈 뿌리)
  const self = spawnSync(process.execPath, [script, process.arch, root], { encoding: 'utf8' });
  assert.equal(self.status, process.platform === 'linux' ? 0 : 1, self.stdout + self.stderr);
  assert.equal(JSON.parse(self.stdout.trim()).ok, process.platform === 'linux');
});

test('DT32_스모크_틀린것을모두적는다_아키텍처와_열리지않는.node둘', () => {
  const { root } = appRoot();
  const opened = [];
  const r = smoke({
    expectedArch: 'arm64',
    root,
    runtime: { platform: 'linux', arch: 'x64' },
    dlopen: (f) => {
      opened.push(f);
      throw new Error(`cannot open shared object file: ${f}`);
    },
  });
  assert.equal(r.ok, false);
  // 아키텍처가 틀려도 멈추지 않고 모듈을 모두 열어 본다(한 번 돌린 결과로 고칠 것을 다 본다)
  assert.equal(opened.length, 2, JSON.stringify(opened));
  assert.ok(r.failures.length >= 3, JSON.stringify(r.failures));
  assert.ok(r.failures.some((f) => f.includes('x64')), '아키텍처 실패');
  for (const m of r.nativeModules) assert.ok(r.failures.some((f) => f.includes(m)), `${m} 실패가 없다: ${JSON.stringify(r.failures)}`);
});

test('DT32_스모크명령줄_열리지않는.node가있으면_그파일을실패에적고_종료코드1이다', () => {
  const root = tempDir('smoke-cli-bad-');
  const bad = join(root, 'node_modules', '.pnpm', 'x@1.0.0', 'node_modules', 'x', 'build', 'Release', 'x.node');
  writeTree(root, { [join('node_modules', '.pnpm', 'x@1.0.0', 'node_modules', 'x', 'build', 'Release', 'x.node')]: 'not an ELF shared object' });
  // 아키텍처는 맞게 준다: 리눅스에서는 .node만 틀렸다
  const r = spawnSync(process.execPath, [script, process.arch, root], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.deepEqual(out.nativeModules.map((p) => realpathSync(p)), [realpathSync(bad)]);
  assert.ok(out.failures.some((f) => f.includes(out.nativeModules[0])), JSON.stringify(out.failures));
});

// 재현 시험(2026-11-03, 실제 v0 이미지): Kafka 바인딩 묶음에는 같은 애드온이 두 경로에 있다(build/Release와 중간 산출물 obj.target).
// pnpm은 같은 내용의 파일을 하드 링크로 두므로 둘은 같은 inode이고, 리눅스 glibc는 같은 inode를 이미 연 라이브러리로 돌려준다.
// 그래서 한 프로세스에서 둘을 열면 두 번째가 'Module did not self-register'로 실패해 스모크가 거짓으로 실패했다. 기본 열기는 모듈마다 새 프로세스다.
// 이 PC에 설치된 실제 바인딩을 복사하고 하드 링크를 하나 더 만들어 기본 열기로 둘 다 열리는지 본다. 리눅스에서만 재현된다(Windows는
// 경로가 다르면 따로 연다). 바인딩이 없거나 리눅스가 아니면 건너뛴다. 늘 도는 회귀 방지는 CI 잡 image의 실제 이미지 스모크다(amd64·arm64)
test('DT32_하드링크한_같은애드온둘도_기본열기로_모두열린다(재현)', async (t) => {
  const { cpSync, existsSync, linkSync, readdirSync } = await import('node:fs');
  if (process.platform !== 'linux') {
    t.skip('리눅스(glibc)에서만 재현된다');
    return;
  }
  const store = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.pnpm');
  const pkg = existsSync(store) ? readdirSync(store).find((d) => d.startsWith('@confluentinc+kafka-javascript@')) : undefined;
  const addon = pkg ? join(store, pkg, 'node_modules', '@confluentinc', 'kafka-javascript', 'build', 'Release', 'confluent-kafka-javascript.node') : undefined;
  if (!addon || !existsSync(addon)) {
    t.skip('설치된 Kafka 바인딩이 없다');
    return;
  }
  const root = tempDir('smoke-real-');
  mkdirSync(join(root, 'Release', 'obj.target'), { recursive: true });
  cpSync(addon, join(root, 'Release', 'confluent-kafka-javascript.node'));
  linkSync(join(root, 'Release', 'confluent-kafka-javascript.node'), join(root, 'Release', 'obj.target', 'confluent-kafka-javascript.node'));
  const r = smoke({ expectedArch: process.arch, root, runtime: { platform: 'linux', arch: process.arch } });
  // 하드 링크 둘은 실제 경로가 달라 둘 다 세고, 둘 다 열려야 한다
  assert.equal(r.nativeModules.length, 2, r.nativeModules.join(', '));
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
});
