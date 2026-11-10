#!/usr/bin/env node
// 이미지 스모크(docs/devops.md §3.1 build-image.yml ①의 arm64 러너 스모크). 이미지 안에서 그 이미지의 node로 돈다:
//   docker run --rm --network none -v <이 파일>:/smoke.mjs:ro <이미지> node /smoke.mjs <x64|arm64> [앱 뿌리, 기본 /app]     (1·2·3, 이미지 사용자)
//   docker run --rm --network none --user 0:0 -v <이 파일>:/smoke.mjs:ro <이미지> node /smoke.mjs --scm [이미지 뿌리, 기본 /]   (4, 루트)
// 1. process.platform이 linux이고 process.arch가 기대한 값인가
// 2. 앱 뿌리 아래(node_modules/.pnpm 포함)의 네이티브 모듈(.node)이 모두 열리는가(모듈마다 새 node 프로세스의 process.dlopen)
// 3. 뿌리 package.json의 peaket.smokeImports(합본 이미지의 네 서비스 start 모듈, BUILD_ORDER PRF-215 코드 리뷰)를 뿌리에서 불러오기만 해 보는가(모듈마다 새 node 프로세스)
// 4. 이미지 안 전체(이미지 뿌리 아래)에 소스 관리 메타데이터(.git·.svn·.hg·.bzr·CVS 폴더와 .git 파일)가 없는가(ASVS 13.4.1, ADR-0263 결정 9,
//    BUILD_ORDER BAS-011 ②). 맨 위의 /proc·/sys·/dev는 보지 않고 심볼릭 링크는 따라가지 않는다. 읽지 못한 폴더도 실패로 센다(닫힘 실패).
//    이미지 사용자가 읽지 못하는 폴더(/root 등)까지 보도록 이 검사만 루트 사용자로 따로 띄우고(scmRunArgs), 네이티브 모듈 열기는 앱이 도는
//    이미지 사용자로 띄운다(smokeRunArgs, devops §4.4 '리뷰 뒤 더한 규칙' ⑦)
// 결과를 한 줄 JSON으로 찍고, 하나라도 틀리면 종료 코드 1이다. 의존성 없이 node: 모듈만 쓴다.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 뿌리 폴더 아래의 .node 파일(심볼릭 링크는 따라가지 않는다, 실제 경로로 겹치지 않게). 이미지 사용자가 읽지 못한 폴더는 건너뛰지 않고
 * unreadable에 담는다(그 안의 모듈을 못 보면 열어 보지도 못한다, 다시 보기 3). 읽는 사이 사라진 것(ENOENT)만 넘긴다
 * @param {string} root
 * @param {string[]} [unreadable]
 * @param {{ readdir?: typeof readdirSync }} [o] 시험이 읽기를 바꿔 넣는다
 * @returns {string[]}
 */
export function findNativeModules(root, unreadable = [], { readdir = readdirSync } = {}) {
  /** @type {Set<string>} */
  const found = new Set();
  const walk = (/** @type {string} */ dir) => {
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') unreadable.push(dir);
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.add(realpathSync(p));
    }
  };
  walk(root);
  return [...found].sort();
}

/** 소스 관리 메타데이터 이름(폴더·파일·링크 모두. 그 안으로는 들어가지 않는다) */
export const SCM_NAMES = Object.freeze(['.git', '.svn', '.hg', '.bzr', 'CVS']);
/** 이미지 뿌리 바로 아래에서 보지 않는 가상 파일 시스템 */
export const SCM_SKIP_TOP = Object.freeze(['proc', 'sys', 'dev']);

/**
 * 이미지 뿌리 아래의 소스 관리 메타데이터. 심볼릭 링크는 따라가지 않고 맨 위의 proc·sys·dev는 건너뛴다
 * @param {string} root
 * @param {string[]} [unreadable] 읽지 못한 폴더를 담는다
 * @returns {string[]}
 */
export function findScmMetadata(root, unreadable = []) {
  /** @type {string[]} */
  const found = [];
  const skip = new Set(SCM_SKIP_TOP.map((d) => join(root, d)));
  const walk = (/** @type {string} */ dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // 읽는 사이 사라진 것만 넘긴다
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') unreadable.push(dir);
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (SCM_NAMES.includes(entry.name)) found.push(p);
      else if (entry.isDirectory() && !skip.has(p)) walk(p);
    }
  };
  walk(root);
  return found.sort();
}

/** 명령줄 인자: <아키텍처> [앱 뿌리, 기본 /app] 이면 1·2·3, --scm [이미지 뿌리, 기본 /] 이면 4만 */
export function cliOptions(argv) {
  if (argv[0] === '--scm') return { mode: 'scm', scmRoot: argv[1] ?? '/' };
  const [expectedArch, root = '/app'] = argv;
  return { mode: 'native', expectedArch, root };
}

/**
 * 뿌리 package.json의 peaket.smokeImports(없거나 읽지 못하면 빈 목록)
 * @param {string} root
 * @returns {string[]}
 */
export function smokeImports(root) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = pkg?.peaket?.smokeImports;
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

/**
 * 스모크 판정
 * @param {{ expectedArch: string, root: string, scmRoot?: string, runtime?: { platform: string, arch: string }, dlopen?: (file: string) => void, importModule?: (spec: string) => void, readdir?: typeof readdirSync }} o
 *   scmRoot: 소스 관리 메타데이터를 찾을 이미지 뿌리(명령줄 기본 /). 주지 않으면 그 검사를 하지 않는다(단위 시험의 앞 둘만 볼 때)
 * @returns {{ ok: boolean, platform: string, arch: string, nativeModules: string[], imports: string[], scmMetadata: string[], failures: string[] }}
 */
export function smoke(o) {
  const runtime = o.runtime ?? { platform: process.platform, arch: process.arch };
  // 모듈마다 새 node 프로세스에서 연다. 같은 애드온의 사본 둘(build/Release와 중간 산출물 obj.target)을 한 프로세스에서 열면
  // 두 번째가 'Module did not self-register'로 실패하기 때문이다(실제 v0 이미지에서 확인, 2026-11-03)
  const load =
    o.dlopen ??
    ((file) => {
      const r = spawnSync(process.execPath, ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', file], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `종료 코드 ${r.status}`).trim().split('\n').slice(-3).join(' '));
    });
  /** @type {string[]} */
  const failures = [];
  if (runtime.platform !== 'linux') failures.push(`플랫폼이 linux가 아니다: ${runtime.platform}`);
  if (runtime.arch !== o.expectedArch) failures.push(`아키텍처가 ${o.expectedArch}가 아니다: ${runtime.arch}`);
  /** @type {string[]} */
  const unreadableApp = [];
  const nativeModules = findNativeModules(o.root, unreadableApp, { readdir: o.readdir });
  for (const d of unreadableApp) failures.push(`네이티브 모듈을 찾다가 읽지 못한 폴더(이미지 사용자로): ${d}`);
  // 하나가 실패해도 나머지를 모두 열어 본다(한 번에 다 보이게)
  for (const file of nativeModules) {
    try {
      load(file);
    } catch (err) {
      failures.push(`네이티브 모듈을 열지 못했다: ${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // 불러오기만 한다(start를 부르지 않는다). 뿌리를 작업 폴더로 두어 이름(@peaket/...)을 뿌리의 node_modules에서 찾는다
  const importModule =
    o.importModule ??
    ((spec) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(spec)})`], { cwd: o.root, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) {
        // 오류 줄(Error: …·Error [ERR_…]: …)을 고른다. 없으면 마지막 세 줄
        const lines = (r.stderr || r.error?.message || `종료 코드 ${r.status}`).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        throw new Error(lines.find((l) => /^[A-Za-z]*Error\b/.test(l)) ?? lines.slice(-3).join(' '));
      }
    });
  const imports = smokeImports(o.root);
  for (const spec of imports) {
    try {
      importModule(spec);
    } catch (err) {
      failures.push(`모듈을 불러오지 못했다: ${spec} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  /** @type {string[]} */
  const scmMetadata = [];
  if (o.scmRoot !== undefined) {
    /** @type {string[]} */
    const unreadable = [];
    scmMetadata.push(...findScmMetadata(o.scmRoot, unreadable));
    for (const p of scmMetadata) failures.push(`이미지 안에 소스 관리 메타데이터가 있다: ${p} (.dockerignore와 Dockerfile의 COPY를 본다, ASVS 13.4.1)`);
    for (const d of unreadable) failures.push(`소스 관리 메타데이터를 찾다가 읽지 못한 폴더: ${d}`);
  }
  return { ok: failures.length === 0, platform: runtime.platform, arch: runtime.arch, nativeModules, imports, scmMetadata, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = cliOptions(process.argv.slice(2));
  if (o.mode === 'scm') {
    /** @type {string[]} */
    const unreadable = [];
    const scmMetadata = findScmMetadata(o.scmRoot, unreadable);
    const failures = [...scmMetadata.map((p) => `이미지 안에 소스 관리 메타데이터가 있다: ${p} (.dockerignore와 Dockerfile의 COPY를 본다, ASVS 13.4.1)`), ...unreadable.map((d) => `소스 관리 메타데이터를 찾다가 읽지 못한 폴더: ${d}`)];
    console.log(JSON.stringify({ ok: failures.length === 0, nativeModules: [], scmMetadata, failures }));
    process.exit(failures.length === 0 ? 0 : 1);
  }
  if (!o.expectedArch) {
    console.error('쓰는 법: node /smoke.mjs <x64|arm64> [앱 뿌리, 기본 /app] | node /smoke.mjs --scm [이미지 뿌리, 기본 /]');
    process.exit(2);
  }
  const result = smoke({ expectedArch: o.expectedArch, root: o.root });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
