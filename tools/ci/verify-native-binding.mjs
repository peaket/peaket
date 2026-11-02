#!/usr/bin/env node
// 미리 빌드한 네이티브 바인딩 대조(docs/devops.md §4.4, ADR-0176 결정 5, BUILD_ORDER BSL-050).
// Kafka 클라이언트 @confluentinc/kafka-javascript는 설치 스크립트(node-pre-gyp)가 GitHub 릴리스에서 바인딩 묶음을 받는데,
// 그 묶음은 잠금 파일의 무결성 값이 지키지 않는다. 그래서 이미지 빌드 단계에서 설치가 끝난 파일 묶음을 이렇게 본다:
//   1. 그 패키지의 판·package.json binary 설정과 지금 런타임(Node ABI·플랫폼·libc·아키텍처)으로 묶음 이름과 주소를 만든다
//   2. 고정 표(PINNED_BINDINGS)에서 다이제스트를 고른다. 표에 없으면 실패(판을 올리면 표부터 고친다)
//   3. 같은 주소에서 묶음을 다시 받아 SHA-256이 다이제스트와 같은지 본다
//   4. 묶음을 풀어 모든 파일이 설치된 build/ 아래 같은 경로의 파일과 같고, 설치된 .node 파일이 모두 묶음에 있는지 본다
// 쓰는 법: node tools/ci/verify-native-binding.mjs <뿌리 폴더> [--expect]
//   뿌리 폴더 아래 node_modules(.pnpm 포함)에서 그 패키지를 모두 찾는다. --expect면 하나도 없을 때 실패한다
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 고정 표: 패키지 → 판 → '<node_abi>-<platform>-<libc>-<arch>' → 'sha256:<64자리>'(GitHub 릴리스 자산의 다이제스트, 2026-11-01 확인) */
export const PINNED_BINDINGS = {
  '@confluentinc/kafka-javascript': {
    '1.11.0': {
      'node-v137-linux-glibc-x64': 'sha256:56b443c9339cb0ae423588599af1df7636eb426c1ac93bf54906e52a0ee77699',
      'node-v137-linux-glibc-arm64': 'sha256:8ce2595cfe62bae5fafd206ed78d1d8a8188e2019534b063f51710a8e7798384',
    },
  },
};

/** 대조하는 패키지 이름들 */
export const VERIFIED_PACKAGES = Object.keys(PINNED_BINDINGS);

export class BindingError extends Error {
  name = 'BindingError';
}

/**
 * @typedef {{ nodeAbi: string, platform: string, libc: string, arch: string }} Runtime  예: { nodeAbi: 'node-v137', platform: 'linux', libc: 'glibc', arch: 'x64' }
 * @typedef {{ module_name: string, module_path: string, package_name: string, host: string, remote_path: string }} BinaryConfig  package.json의 binary 칸
 */

const sha256 = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');

/** 지금 프로세스의 런타임(libc는 glibc 판이 보고되면 glibc, 아니면 리눅스에서 musl) @returns {Runtime} */
export function currentRuntime() {
  let libc = 'unknown';
  if (process.platform === 'linux') {
    const report = /** @type {{ header?: { glibcVersionRuntime?: string } }} */ (process.report?.getReport() ?? {});
    libc = report.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  return { nodeAbi: `node-v${process.versions.modules}`, platform: process.platform, libc, arch: process.arch };
}

/**
 * 묶음 이름·주소·표 열쇠. 틀(package_name·remote_path)의 {module_name}·{version}·{node_abi}·{platform}·{libc}·{arch}를 채운다.
 * module_path의 {configuration}은 Release로 읽는다
 * @param {{ name: string, version: string, binary: BinaryConfig }} pkg
 * @param {Runtime} runtime
 * @returns {{ tarball: string, url: string, key: string, modulePath: string }}
 */
export function bindingTarget(pkg, runtime) {
  const b = pkg.binary;
  if (!b || typeof b.package_name !== 'string' || typeof b.host !== 'string' || typeof b.module_path !== 'string') {
    throw new BindingError(`${pkg.name}: package.json에 binary 설정이 없다`);
  }
  /** @type {Record<string, string>} */
  const vars = {
    module_name: b.module_name,
    version: pkg.version,
    node_abi: runtime.nodeAbi,
    platform: runtime.platform,
    libc: runtime.libc,
    arch: runtime.arch,
    configuration: 'Release',
  };
  const fill = (/** @type {string} */ t) =>
    t.replace(/\{(\w+)\}/g, (_, k) => {
      if (typeof vars[k] !== 'string') throw new BindingError(`${pkg.name}: 모르는 틀 이름 {${k}}`);
      return vars[k];
    });
  const tarball = fill(b.package_name);
  const host = b.host.endsWith('/') ? b.host : `${b.host}/`;
  const remote = fill(b.remote_path ?? '')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '');
  const url = `${host}${remote ? `${remote}/` : ''}${tarball}`;
  return { tarball, url, key: `${runtime.nodeAbi}-${runtime.platform}-${runtime.libc}-${runtime.arch}`, modulePath: fill(b.module_path) };
}

/**
 * 고정 표에서 다이제스트. 패키지·판·열쇠 가운데 하나라도 없으면 BindingError
 * @param {string} name @param {string} version @param {string} key
 * @param {typeof PINNED_BINDINGS} [pinned]
 * @returns {string}
 */
export function pinnedDigest(name, version, key, pinned = PINNED_BINDINGS) {
  const byVersion = /** @type {Record<string, Record<string, Record<string, string>>>} */ (pinned)[name];
  if (!byVersion) throw new BindingError(`${name}: 고정 표에 없는 패키지다`);
  const byKey = byVersion[version];
  if (!byKey) throw new BindingError(`${name}@${version}: 고정 표에 없는 판이다(판을 올리면 고정 표에 게시 다이제스트를 먼저 더한다)`);
  const digest = byKey[key];
  if (!digest) throw new BindingError(`${name}@${version}: 고정 표에 ${key} 묶음이 없다`);
  return digest;
}

/**
 * 뿌리 폴더 아래 node_modules(.pnpm 포함)에서 그 패키지 폴더를 모두 찾는다(실제 경로, 겹치지 않게)
 * @param {string} root @param {string} name
 * @returns {string[]}
 */
export function findPackageDirs(root, name) {
  const parts = name.split('/');
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Set<string>} */
  const visited = new Set();
  const isDir = (/** @type {string} */ p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const scan = (/** @type {string} */ nodeModules) => {
    let real;
    try {
      real = realpathSync(nodeModules);
    } catch {
      return;
    }
    if (visited.has(real) || !isDir(real)) return;
    visited.add(real);
    const candidate = join(nodeModules, ...parts);
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) found.add(realpathSync(candidate));
      } catch {
        // 깨진 package.json은 그 패키지가 아니다
      }
    }
    const store = join(nodeModules, '.pnpm');
    if (isDir(store)) for (const entry of readdirSync(store)) scan(join(store, entry, 'node_modules'));
  };
  scan(join(root, 'node_modules'));
  return [...found].sort();
}

/**
 * 폴더 아래 일반 파일의 상대 경로(/로 이음). 심볼릭 링크는 따라가지 않는다
 * @param {string} dir
 * @returns {string[]}
 */
function regularFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * 폴더 아래 .node 항목(일반 파일과 심볼릭 링크, 상대 경로는 /로 이음). 폴더 심볼릭 링크와 node_modules는 따라가지 않는다
 * @param {string} dir
 * @returns {Array<{ rel: string, symlink: boolean }>}
 */
function nativeEntries(dir) {
  /** @type {Array<{ rel: string, symlink: boolean }>} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(p);
      } else if (entry.name.endsWith('.node') && (entry.isFile() || entry.isSymbolicLink())) {
        out.push({ rel: relative(dir, p).split(sep).join('/'), symlink: entry.isSymbolicLink() });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 패키지 폴더 하나를 대조한다. 통과하면 묶음 이름과 다이제스트, 실패하면 BindingError
 * @param {string} packageDir
 * @param {{ fetch?: typeof fetch, pinned?: typeof PINNED_BINDINGS, runtime?: Runtime, tmpDir?: string }} [options]
 * @returns {Promise<{ tarball: string, digest: string, files: number }>}
 */
export async function verifyBinding(packageDir, options = {}) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const target = bindingTarget(pkg, options.runtime ?? currentRuntime());
  const digest = pinnedDigest(pkg.name, pkg.version, target.key, options.pinned ?? PINNED_BINDINGS);
  const doFetch = options.fetch ?? globalThis.fetch;
  /** @type {Buffer} */
  let bytes;
  try {
    const res = await doFetch(target.url, { redirect: 'follow' });
    if (!res.ok) throw new BindingError(`${target.tarball}: 받기 실패 HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof BindingError) throw err;
    throw new BindingError(`${target.tarball}: 받기 실패(${err instanceof Error ? err.message : String(err)})`);
  }
  if (`sha256:${sha256(bytes)}` !== digest) throw new BindingError(`${target.tarball}: 받은 묶음의 다이제스트가 고정 표와 다르다`);

  const work = mkdtempSync(join(options.tmpDir ?? tmpdir(), 'binding-'));
  try {
    const archive = join(work, 'binding.tar.gz');
    const extracted = join(work, 'x');
    writeFileSync(archive, bytes);
    mkdirSync(extracted);
    // 작업 폴더 기준 상대 경로로 부른다(GNU tar는 'C:\…'를 원격 호스트 C로 읽는다)
    execFileSync('tar', ['-xzf', 'binding.tar.gz', '-C', 'x'], { cwd: work, stdio: 'pipe' });
    const packed = regularFiles(extracted);
    if (packed.length === 0) throw new BindingError(`${target.tarball}: 묶음에 파일이 없다`);
    // node-pre-gyp은 묶음의 첫 경로 조각(Release/)을 떼고 module_path(build/Release/) 아래에 푼다
    const moduleDir = resolve(packageDir, target.modulePath);
    const installedPath = (/** @type {string} */ rel) => join(moduleDir, ...rel.split('/').slice(1));
    for (const rel of packed) {
      const installed = installedPath(rel);
      if (!existsSync(installed) || !lstatSync(installed).isFile()) throw new BindingError(`${target.tarball}: 묶음의 ${rel}이 설치된 곳에 없다`);
      if (sha256(readFileSync(installed)) !== sha256(readFileSync(join(extracted, ...rel.split('/'))))) {
        throw new BindingError(`${target.tarball}: 설치된 ${rel}이 묶음과 다르다`);
      }
    }
    // 패키지 폴더 안의 네이티브 모듈은 모두 묶음에서 와야 한다. bindings 패키지는 build/Release 말고도 build/·build/Debug/·out/·Release/·
    // compiled/ 같은 곳을 먼저 찾으므로 build/ 밖도 본다. 심볼릭 링크 .node는 대조할 수 없어 받지 않는다(2026-11-03 코드 리뷰).
    // 패키지 안의 node_modules 아래는 그 패키지의 몫이라 보지 않는다
    const packedInstalled = new Set(packed.map((rel) => installedPath(rel)));
    for (const { rel, symlink } of nativeEntries(packageDir)) {
      if (symlink) throw new BindingError(`${target.tarball}: 심볼릭 링크 네이티브 모듈 ${rel}이 있다`);
      if (!packedInstalled.has(join(packageDir, ...rel.split('/')))) throw new BindingError(`${target.tarball}: 묶음에 없는 네이티브 모듈 ${rel}이 설치돼 있다`);
    }
    return { tarball: target.tarball, digest, files: packed.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const expect = args.includes('--expect');
  const rest = args.filter((a) => a !== '--expect');
  if (rest.length !== 1 || rest[0].startsWith('--')) {
    console.error('쓰는 법: node tools/ci/verify-native-binding.mjs <뿌리 폴더> [--expect]');
    process.exit(2);
  }
  const root = rest[0];
  const dirs = VERIFIED_PACKAGES.flatMap((name) => findPackageDirs(root, name));
  if (dirs.length === 0) {
    console.log(`대조할 네이티브 바인딩 패키지가 없다(${VERIFIED_PACKAGES.join(', ')})`);
    process.exit(expect ? 1 : 0);
  }
  let failed = 0;
  for (const dir of dirs) {
    try {
      const r = await verifyBinding(dir);
      console.log(`통과: ${r.tarball} ${r.digest} 파일 ${r.files}개`);
    } catch (err) {
      failed += 1;
      console.log(`실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}
