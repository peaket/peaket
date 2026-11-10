// 이미지 스모크(tools/ci/image-smoke.mjs) 시험(docs/devops.md §3.1 build-image.yml ①, D-T32 ①, BUILD_ORDER BSL-050).
// 가짜 .node 파일에는 진짜 process.dlopen을 부르지 않는다(dlopen을 넘겨 본다). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { cliOptions, findNativeModules, findScmMetadata, smoke } from './image-smoke.mjs';

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

// 합본 이미지는 네 서비스의 start 모듈을 불러오기만 해 본다(코드 리뷰, BUILD_ORDER PRF-215). 목록은 이미지 뿌리 package.json의 peaket.smokeImports다
test('PRF215_코드리뷰_스모크_뿌리package.json의_smokeImports를_뿌리에서불러오기만해보고_못불러오면_실패에적는다', () => {
  const root = tempDir('smoke-imports-');
  writeTree(root, {
    'package.json': JSON.stringify({ name: 'x', peaket: { smokeImports: ['good-pkg/start', 'bad-pkg/start', 'missing-pkg/start'] } }),
    [join('node_modules', 'good-pkg', 'package.json')]: JSON.stringify({ name: 'good-pkg', type: 'module', exports: { './start': './start.js' } }),
    [join('node_modules', 'good-pkg', 'start.js')]: 'export function start() {}\n',
    [join('node_modules', 'bad-pkg', 'package.json')]: JSON.stringify({ name: 'bad-pkg', type: 'module', exports: { './start': './start.js' } }),
    [join('node_modules', 'bad-pkg', 'start.js')]: "throw new Error('시작 모듈이 깨졌다');\n",
  });
  const r = smoke({ expectedArch: 'x64', root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} });
  assert.deepEqual(r.imports, ['good-pkg/start', 'bad-pkg/start', 'missing-pkg/start']);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('bad-pkg/start') && f.includes('시작 모듈이 깨졌다')), JSON.stringify(r.failures));
  assert.ok(r.failures.some((f) => f.includes('missing-pkg/start')), JSON.stringify(r.failures));
  assert.ok(!r.failures.some((f) => f.includes('good-pkg')), JSON.stringify(r.failures));
  // 목록이 없으면 불러오지 않는다(다른 이미지는 그대로)
  assert.deepEqual(smoke({ expectedArch: 'x64', root: tempDir('smoke-noimports-'), runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} }).imports, []);
});

test('PRF215_코드리뷰_합본package.json은_네서비스의_start모듈을_스모크목록에둔다', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'bundle', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.peaket?.smokeImports, ['@peaket/payment-svc/start', '@peaket/purchase-svc/start', '@peaket/admission-ctrl/start', '@peaket/queue-svc/start']);
});

// ---------- 이미지 안 소스 관리 폴더(ASVS 13.4.1, ADR-0263 결정 9) ----------

/** 이미지 뿌리(/)처럼 생긴 폴더: 앱, 깊은 의존성, 시스템 폴더, 걸리면 안 되는 비슷한 이름 */
function imageRoot(files) {
  const root = tempDir('smoke-scm-');
  writeTree(root, { [join('app', 'dist', 'main.js')]: '', [join('usr', 'local', 'bin', 'node')]: '', ...files });
  return root;
}

test('[ASVS v5.0.0-13.4.1] 이미지 안 어디든 .git·.svn·.hg·.bzr·CVS 폴더나 .git 파일이 있으면 스모크가 실패한다(node_modules 안 깊은 곳 포함)', () => {
  const deep = join('app', 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep');
  const root = imageRoot({
    [join('app', '.git', 'HEAD')]: 'ref: refs/heads/develop\n',
    [join(deep, '.git')]: 'gitdir: ../../.git/modules/dep\n',
    [join('srv', 'legacy', '.svn', 'entries')]: '12\n',
    [join('opt', 'tool', '.hg', 'requires')]: 'store\n',
    [join('opt', 'bzr-tool', '.bzr', 'branch-format')]: 'Bazaar-NG meta directory, format 1\n',
    [join('usr', 'src', 'old', 'CVS', 'Root')]: ':pserver:x\n',
  });
  const expected = [join(root, 'app', '.git'), join(root, deep, '.git'), join(root, 'opt', 'bzr-tool', '.bzr'), join(root, 'opt', 'tool', '.hg'), join(root, 'srv', 'legacy', '.svn'), join(root, 'usr', 'src', 'old', 'CVS')].sort();
  assert.deepEqual(findScmMetadata(root), expected);
  const r = smoke({ expectedArch: 'x64', root: join(root, 'app'), scmRoot: root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.scmMetadata, expected);
  for (const p of expected) assert.ok(r.failures.some((f) => f.includes(p) && f.includes('소스 관리')), `${p}: ${JSON.stringify(r.failures)}`);
  assert.equal(r.failures.length, 6, '아키텍처·네이티브 모듈은 맞다');
  // 하나만 있어도(뿌리 바로 아래 .git 파일) 실패한다
  const one = imageRoot({ '.git': 'gitdir: /elsewhere\n' });
  assert.deepEqual(findScmMetadata(one), [join(one, '.git')]);
  assert.equal(smoke({ expectedArch: 'x64', root: join(one, 'app'), scmRoot: one, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} }).ok, false);
  // 없으면 통과한다
  const clean = imageRoot({});
  const ok = smoke({ expectedArch: 'x64', root: join(clean, 'app'), scmRoot: clean, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
  assert.deepEqual(ok.scmMetadata, []);
  // 명령줄도 세 번째 인자(이미지 뿌리)를 보고 실패한다
  const cli = spawnSync(process.execPath, [script, '--scm', root], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout.trim()).scmMetadata.map((p) => realpathSync(p)), expected.map((p) => realpathSync(p)));
});

test('[ASVS v5.0.0-13.4.1] /proc·/sys·/dev는 보지 않고 심볼릭 링크는 따라가지 않으며 .gitignore·.github 같은 이름은 걸리지 않는다', () => {
  const outside = tempDir('smoke-scm-outside-');
  writeTree(outside, { [join('repo', '.git', 'HEAD')]: 'ref\n' });
  const root = imageRoot({
    [join('proc', '1', 'cwd', '.git', 'HEAD')]: '',
    [join('sys', 'x', '.hg', 'store')]: '',
    [join('dev', 'shm', '.svn', 'entries')]: '',
    [join('app', '.gitignore')]: 'node_modules\n',
    [join('app', '.github', 'workflows', 'ci.yml')]: '',
    [join('app', '.gitattributes')]: '',
    [join('app', '.hgignore')]: '',
    [join('app', 'docs', 'git')]: '',
    [join('app', '.git-credentials.example')]: '',
  });
  symlinkSync(join(outside, 'repo'), join(root, 'app', 'linked'), 'junction');
  assert.deepEqual(findScmMetadata(root), []);
  // 맨 위의 proc·sys·dev만 건너뛴다. 더 깊은 같은 이름 폴더는 본다
  writeTree(root, { [join('app', 'proc', '.git', 'HEAD')]: '' });
  assert.deepEqual(findScmMetadata(root), [join(root, 'app', 'proc', '.git')]);
  // 명령줄의 기본 뿌리: 앱은 /app, 소스 관리 폴더 검사는 / 전체다
  // 명령줄: 네이티브 모듈 열기(이미지 사용자로 띄운다)와 소스 관리 폴더 검사(--scm, 루트로 띄운다)는 따로 돈다(devops §4.4 '리뷰 뒤 더한 규칙' ⑦)
  assert.deepEqual(cliOptions(['arm64']), { mode: 'native', expectedArch: 'arm64', root: '/app' });
  assert.deepEqual(cliOptions(['x64', '/srv']), { mode: 'native', expectedArch: 'x64', root: '/srv' });
  assert.deepEqual(cliOptions(['--scm']), { mode: 'scm', scmRoot: '/' });
  assert.deepEqual(cliOptions(['--scm', '/mnt']), { mode: 'scm', scmRoot: '/mnt' });
  // 네이티브 모듈 쪽 명령줄은 소스 관리 폴더를 보지 않는다(이미지 사용자로 돌아 다 읽지 못한다)
  const tree = imageRoot({ [join('app', '.git', 'HEAD')]: '' });
  const native = spawnSync(process.execPath, [script, process.arch, join(tree, 'app')], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(native.stdout.trim()).scmMetadata, []);
  const scm = spawnSync(process.execPath, [script, '--scm', tree], { encoding: 'utf8' });
  assert.equal(scm.status, 1, scm.stdout);
  assert.deepEqual(JSON.parse(scm.stdout.trim()).nativeModules, []);
});

test('[ASVS v5.0.0-13.4.1] 소스 관리 폴더를 찾다가 읽지 못한 폴더가 있으면 스모크가 실패한다(닫힘 실패)', async (t) => {
  const { chmodSync } = await import('node:fs');
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('권한으로 폴더를 못 읽게 하는 것은 리눅스 비루트 사용자에서만 재현된다(CI tools-check)');
    return;
  }
  const root = imageRoot({ [join('root', 'secret', '.git', 'HEAD')]: '' });
  chmodSync(join(root, 'root'), 0o000);
  try {
    const unreadable = [];
    assert.deepEqual(findScmMetadata(root, unreadable), []);
    assert.deepEqual(unreadable, [join(root, 'root')]);
    const r = smoke({ expectedArch: 'x64', root: join(root, 'app'), scmRoot: root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {} });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes('읽지 못한 폴더') && f.includes(join(root, 'root'))), JSON.stringify(r.failures));
  } finally {
    chmodSync(join(root, 'root'), 0o755);
  }
});

test('DT32_네이티브모듈찾기_이미지사용자로_읽지못한폴더는_건너뛰지않고_스모크실패로센다(다시 보기 3)', () => {
  const { root } = appRoot();
  const locked = join(root, 'node_modules', '.pnpm', 'other@1.0.0');
  const readdir = (dir, o) => {
    if (dir === locked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return readdirSync(dir, o);
  };
  const unreadable = [];
  const found = findNativeModules(root, unreadable, { readdir });
  assert.deepEqual(unreadable, [locked]);
  assert.equal(found.some((f) => f.includes('other.node')), false);
  const r = smoke({ expectedArch: 'x64', root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {}, readdir });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('읽지 못한 폴더') && f.includes(locked)), JSON.stringify(r.failures));
  // 사라진 폴더(ENOENT)는 실패가 아니다
  const gone = (dir, o) => {
    if (dir === locked) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return readdirSync(dir, o);
  };
  assert.equal(smoke({ expectedArch: 'x64', root, runtime: { platform: 'linux', arch: 'x64' }, dlopen: () => {}, readdir: gone }).ok, true);
});
